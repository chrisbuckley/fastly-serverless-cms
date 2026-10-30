# ---------------------------------------------------------------------------
# VCL CDN service — public face of the Edge CMS
#
# Responsibilities:
#   - Serve /images/* directly from Fastly Object Storage (SigV4-signed)
#   - Coarse rate limit on POST /admin/login (Edge Rate Limiting, 10 rps
#     averaged over 60s — the VCL minimum). The precise 5 attempts/min
#     limit is enforced inside Compute (ERL login_attempts/login_penalty).
#   - Cache reader responses using Surrogate-Control from Compute
#   - Route all other traffic to the Compute service
#   - (Optional) NGWAF edge deploy — enable product manually after apply
# ---------------------------------------------------------------------------

locals {
  # Optional VCL backends for the Go / TypeScript Compute services, keyed by
  # the active_backend value that selects them.
  optional_compute_backends = {
    for k, v in {
      go = { name = "edge-cms-compute-go", vcl_backend = "F_edge_cms_compute_go", host = var.go_backend_host }
      ts = { name = "edge-cms-compute-ts", vcl_backend = "F_edge_cms_compute_ts", host = var.ts_backend_host }
    } : k => v if v.host != ""
  }
}

resource "fastly_service_vcl" "cdn" {
  name    = "edge-cms"
  comment = "Edge CMS CDN — VCL layer — managed by Terraform"

  domain {
    name    = var.domain
    comment = "Public reader and admin domain"
  }

  # ---------------------------------------------------------------------------
  # Backends: Compute app services (one per language implementation)
  # The active backend is selected by active_backend in edge_cms_config.
  # Rust (app.<domain>) always exists. Go / TS backends exist only when
  # var.go_backend_host / var.ts_backend_host are set; selecting one that
  # isn't configured falls back to Rust (see backend-select snippets).
  # request_condition "snippet-routed" is never true: routing is done in VCL.
  # ---------------------------------------------------------------------------
  backend {
    name              = "edge-cms-compute"
    address           = "app.${var.domain}"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "app.${var.domain}"
    ssl_sni_hostname  = "app.${var.domain}"
    override_host     = "app.${var.domain}"

    shield                = var.shield_pop
    connect_timeout       = 1000
    first_byte_timeout    = 15000
    between_bytes_timeout = 10000

    request_condition = "snippet-routed"
  }

  dynamic "backend" {
    for_each = local.optional_compute_backends
    content {
      name              = backend.value.name
      address           = backend.value.host
      port              = 443
      use_ssl           = true
      ssl_cert_hostname = backend.value.host
      ssl_sni_hostname  = backend.value.host
      override_host     = backend.value.host

      shield                = var.shield_pop
      connect_timeout       = 1000
      first_byte_timeout    = 15000
      between_bytes_timeout = 10000

      request_condition = "snippet-routed"
    }
  }

  # ---------------------------------------------------------------------------
  # Backend: Fastly Object Storage
  # Used by the /images/* VCL snippet for direct image serving.
  # ---------------------------------------------------------------------------
  backend {
    name              = "edge-cms-fos"
    address           = "${var.fos_region}.object.fastlystorage.app"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "${var.fos_region}.object.fastlystorage.app"
    ssl_sni_hostname  = "${var.fos_region}.object.fastlystorage.app"
    override_host     = "${var.fos_region}.object.fastlystorage.app"
    shield            = var.shield_pop

    connect_timeout       = 1000
    first_byte_timeout    = 15000
    between_bytes_timeout = 10000

    request_condition = "is-image-request"
  }

  # ---------------------------------------------------------------------------
  # Private dictionary — Object Storage credentials for SigV4 signing in VCL.
  # write_only = true means values are encrypted at rest and not readable via
  # the API or UI, but are accessible in VCL via table.lookup().
  # Holds the READ-ONLY Object Storage key (fos_readonly). Terraform cannot
  # manage items in private dictionaries — populate after apply with the
  # command in the next_steps output (keeps the secret off the command line).
  # ---------------------------------------------------------------------------
  dictionary {
    name       = "edge_cms_fos_creds"
    write_only = true
  }

  # Private dictionary — origin auth shared secret (key: origin_auth_token).
  # Value comes from random_password.origin_auth_token; populate after apply
  # (see next_steps). Terraform cannot manage items in private dictionaries.
  dictionary {
    name       = "edge_cms_private"
    write_only = true
  }

  # Backend selector — set active_backend to "rust" (default), "go", or "ts".
  # Items are managed by fastly_service_dictionary_items.config below, so a
  # live switch (see next_steps) is reverted on the next apply.
  dictionary {
    name = "edge_cms_config"
  }

  # ---------------------------------------------------------------------------
  # Force TLS — plain-HTTP requests get a 301 to https:// (handled in the
  # edge-errors snippet). Only checked on the first Fastly hop: edge→shield
  # traffic is Fastly-internal and must not be redirected.
  # ---------------------------------------------------------------------------
  snippet {
    name     = "force-tls"
    type     = "recv"
    priority = 1
    content  = <<-VCL
      if (fastly.ff.visits_this_service == 0 && !req.is_ssl) {
        error 601 "Force TLS";
      }
    VCL
  }

  snippet {
    name     = "hsts"
    type     = "deliver"
    priority = 5
    content  = <<-VCL
      set resp.http.Strict-Transport-Security = "max-age=31536000; includeSubDomains";
    VCL
  }

  # Synthetic responses for the custom error codes raised in vcl_recv.
  snippet {
    name     = "edge-errors"
    type     = "error"
    priority = 10
    content  = <<-VCL
      if (obj.status == 601) {
        set obj.status = 301;
        set obj.response = "Moved Permanently";
        set obj.http.Location = "https://" + req.http.host + req.url;
        set obj.http.Cache-Control = "private, no-store";
        synthetic {""};
        return(deliver);
      }
      if (obj.status == 629) {
        set obj.status = 429;
        set obj.response = "Too Many Requests";
        set obj.http.Content-Type = "text/plain; charset=utf-8";
        set obj.http.Cache-Control = "private, no-store";
        set obj.http.Retry-After = "900";
        synthetic {"Too many login attempts
"};
        return(deliver);
      }
      if (obj.status == 604) {
        set obj.status = 404;
        set obj.response = "Not Found";
        set obj.http.Content-Type = "text/plain; charset=utf-8";
        set obj.http.Cache-Control = "private, no-store";
        synthetic {"Not Found
"};
        return(deliver);
      }
    VCL
  }

  # ---------------------------------------------------------------------------
  # Login rate limit (coarse, edge) — POST /admin/login only.
  #
  # ratelimit.check_rate() limit must be >= 10 (rps); below 10 Fastly does not
  # guarantee accuracy or detection time. 10 rps averaged over a 60s window
  # (= 600 attempts/min per IP) is the tightest the VCL limiter supports, so
  # this only stops floods. The precise limit (5 attempts per 60s, then a 15
  # minute penalty) is enforced in Compute with ERL login_attempts /
  # login_penalty (contract section 4).
  #
  # Counted only on the first Fastly hop so shielded requests aren't counted
  # twice. Keyed on client.ip: IPv4 uses the full address, IPv6 its /64
  # (h1:h2:h3:h4::/64) so rotating addresses within one allocation cannot
  # bypass the limit. addr.extract_bits numbers bits from the
  # least-significant end. Requires Edge Rate Limiting to be enabled.
  # Ref: https://www.fastly.com/documentation/reference/vcl/functions/rate-limiting/ratelimit-check-rate/
  # ---------------------------------------------------------------------------
  snippet {
    name     = "login-ratelimit-init"
    type     = "init"
    priority = 10
    content  = <<-VCL
      ratecounter rc_admin_login {}
      penaltybox pb_admin_login {}
    VCL
  }

  snippet {
    name     = "login-ratelimit"
    type     = "recv"
    priority = 3
    content  = <<-VCL
      if (fastly.ff.visits_this_service == 0 && req.method == "POST" && req.url.path == "/admin/login") {
        declare local var.rl_key STRING;
        if (addr.is_ipv6(client.ip)) {
          set var.rl_key =
            std.itoa_charset(addr.extract_bits(client.ip, 112, 16), "0123456789abcdef") + ":" +
            std.itoa_charset(addr.extract_bits(client.ip, 96, 16), "0123456789abcdef") + ":" +
            std.itoa_charset(addr.extract_bits(client.ip, 80, 16), "0123456789abcdef") + ":" +
            std.itoa_charset(addr.extract_bits(client.ip, 64, 16), "0123456789abcdef") + "::/64";
        } else {
          set var.rl_key = client.ip;
        }
        if (ratelimit.check_rate(var.rl_key, rc_admin_login, 1, 60, 10, pb_admin_login, 15m)) {
          error 629 "Too Many Requests";
        }
      }
    VCL
  }

  # ---------------------------------------------------------------------------
  # Edge request hygiene — runs right after force-tls, before anything that
  # reads Fastly-Client-IP (login-ratelimit, logging, Compute).
  #   - Clients must never supply the origin auth header.
  #   - Fastly-Client-IP is preserved by Fastly if the client sends it, so on
  #     the first Fastly hop (edge, not shield) overwrite it with the real
  #     client IP. Compute trusts it once origin auth passes (contract §1).
  # ---------------------------------------------------------------------------
  snippet {
    name     = "edge-request"
    type     = "recv"
    priority = 2
    content  = <<-VCL
      unset req.http.Edge-CMS-Origin-Auth;
      if (fastly.ff.visits_this_service == 0) {
        set req.http.Fastly-Client-IP = client.ip;
      }
    VCL
  }

  # ---------------------------------------------------------------------------
  # Origin auth — inject the shared secret on every backend request bound for
  # a Compute service (vcl_miss and vcl_pass). /images/* always routes to
  # Object Storage (see images-route) and must never receive the secret.
  # ---------------------------------------------------------------------------
  snippet {
    name     = "origin-auth-miss"
    type     = "miss"
    priority = 5
    content  = <<-VCL
      if (req.url.path !~ "^/images/") {
        set bereq.http.Edge-CMS-Origin-Auth = table.lookup(edge_cms_private, "origin_auth_token", "");
      } else {
        unset bereq.http.Edge-CMS-Origin-Auth;
      }
    VCL
  }

  snippet {
    name     = "origin-auth-pass"
    type     = "pass"
    priority = 5
    content  = <<-VCL
      if (req.url.path !~ "^/images/") {
        set bereq.http.Edge-CMS-Origin-Auth = table.lookup(edge_cms_private, "origin_auth_token", "");
      } else {
        unset bereq.http.Edge-CMS-Origin-Auth;
      }
    VCL
  }

  snippet {
    name     = "backend-select"
    type     = "recv"
    priority = 10
    content  = <<-VCL
      # Default / fallback: Rust. Optional Go/TS snippets below override it
      # only when their backend is configured.
      set req.backend = F_edge_cms_compute;
    VCL
  }

  dynamic "snippet" {
    for_each = local.optional_compute_backends
    content {
      name     = "backend-select-${snippet.key}"
      type     = "recv"
      priority = 11
      content  = <<-VCL
        if (table.lookup(edge_cms_config, "active_backend", "rust") == "${snippet.key}") {
          set req.backend = ${snippet.value.vcl_backend};
        }
      VCL
    }
  }

  snippet {
    name     = "admin-pass"
    type     = "recv"
    priority = 50
    content  = <<-VCL
      if (req.url.path ~ "^/admin") {
        return(pass);
      }
    VCL
  }

  condition {
    name      = "snippet-routed"
    type      = "REQUEST"
    statement = "!req.url"
  }

  condition {
    name      = "is-image-request"
    type      = "REQUEST"
    statement = "req.url.path ~ \"^/images/\""
  }

  # ---------------------------------------------------------------------------
  # /images/* — served from Object Storage with SigV4 signing
  #
  # Flow:
  #   1. images-route (recv): allowlist the path, set the FOS backend
  #   2. images-sign (miss): rewrite to the bucket path and sign — only on
  #      cache misses at the node fetching from Object Storage
  #   3. images-cache (fetch): Content-Type, TTLs, surrogate keys
  #   4. images-deliver (deliver): strip amz headers, nosniff + CSP
  # ---------------------------------------------------------------------------
  snippet {
    name     = "images-route"
    type     = "recv"
    priority = 100
    content  = <<-VCL
      if (req.url.path ~ "^/images/") {
        # Only /images/<slug>/<file>.<jpg|jpeg|png|webp|gif> is served;
        # anything else (other types, nested paths, bare slugs) is a 404.
        if (req.url.path !~ "^/images/[a-z0-9][a-z0-9-]*/[^/]+\.(?i:jpe?g|png|webp|gif)$") {
          error 604 "Not Found";
        }
        set req.backend = F_edge_cms_fos;
        set req.http.X-Fastly-Imageopto-Api = "fastly";
      }
    VCL
  }

  snippet {
    name     = "images-sign"
    type     = "miss"
    priority = 100
    content  = <<-VCL
      # Only sign requests going to the Object Storage backend.
      if (req.backend == F_edge_cms_fos) {
        # bereq.url starts as req.url (/images/slug/file.jpg with IO params).
        # Strip IO params via .path and rewrite to FOS bucket path before signing.
        set bereq.url = regsuball(bereq.url.path, "^/images/", "/${var.fos_bucket}/");

        declare local var.access_key STRING;
        declare local var.secret_key STRING;
        declare local var.datetime   STRING;
        declare local var.date       STRING;
        declare local var.region     STRING;
        declare local var.host       STRING;
        declare local var.body_hash  STRING;

        set var.access_key = table.lookup(edge_cms_fos_creds, "access_key_id");
        set var.secret_key = table.lookup(edge_cms_fos_creds, "secret_key");
        set var.region     = "${var.fos_region}";
        set var.host       = "${var.fos_region}.object.fastlystorage.app";
        set var.datetime   = strftime({"%Y%m%dT%H%M%SZ"}, now);
        set var.date       = strftime({"%Y%m%d"}, now);

        # SHA256 of empty body (GET has no body) — well-known constant, not a secret
        set var.body_hash  = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; # pragma: allowlist secret

        set bereq.http.Host                 = var.host;
        set bereq.http.x-amz-date          = var.datetime;
        set bereq.http.x-amz-content-sha256 = var.body_hash;
        unset bereq.http.Authorization;

        # Canonical headers (sorted alphabetically)
        declare local var.canonical_headers STRING;
        set var.canonical_headers =
          "host:" + var.host + LF +
          "x-amz-content-sha256:" + var.body_hash + LF +
          "x-amz-date:" + var.datetime + LF;

        declare local var.signed_headers STRING;
        set var.signed_headers = "host;x-amz-content-sha256;x-amz-date";

        # Credential scope
        declare local var.credential_scope STRING;
        set var.credential_scope = var.date + "/" + var.region + "/s3/aws4_request";

        # Canonical request (no query string — IO params already stripped above)
        declare local var.canonical_request STRING;
        set var.canonical_request =
          "GET" + LF +
          bereq.url + LF +
          "" + LF +
          var.canonical_headers + LF +
          var.signed_headers + LF +
          var.body_hash;

        # String to sign
        declare local var.string_to_sign STRING;
        set var.string_to_sign =
          "AWS4-HMAC-SHA256" + LF +
          var.datetime + LF +
          var.credential_scope + LF +
          digest.hash_sha256(var.canonical_request);

        # digest.awsv4_hmac(secret, date, region, service, string_to_sign)
        # Performs the full 4-step SigV4 key derivation and final HMAC in one
        # call, returning lowercase hex. Signature per falco source:
        #   digest.awsv4_hmac(STRING, STRING, STRING, STRING, STRING) → STRING
        declare local var.signature STRING;
        set var.signature = digest.awsv4_hmac(
          var.secret_key, var.date, var.region, "s3", var.string_to_sign
        );

        set bereq.http.Authorization =
          "AWS4-HMAC-SHA256 Credential=" + var.access_key + "/" + var.credential_scope +
          ", SignedHeaders=" + var.signed_headers +
          ", Signature=" + var.signature;
      }
    VCL
  }

  snippet {
    name     = "images-cache"
    type     = "fetch"
    priority = 100
    content  = <<-VCL
      # Path-based (not req.backend) so it runs on the shield, which fetches
      # from Object Storage, and on the edge, which fetches from the shield.
      if (req.url.path ~ "^/images/([a-z0-9][a-z0-9-]*)/") {
        declare local var.image_slug STRING;
        set var.image_slug = re.group.1;
        # Purged by Compute on upload: image-<slug> (contract section 7).
        set beresp.http.Surrogate-Key = "images image-" + var.image_slug;

        if (beresp.status == 200) {
          # Never trust the stored Content-Type: derive it from the
          # (already allowlisted in images-route) extension.
          if (req.url.path ~ "(?i)\.jpe?g$") {
            set beresp.http.Content-Type = "image/jpeg";
          } else if (req.url.path ~ "(?i)\.png$") {
            set beresp.http.Content-Type = "image/png";
          } else if (req.url.path ~ "(?i)\.webp$") {
            set beresp.http.Content-Type = "image/webp";
          } else {
            set beresp.http.Content-Type = "image/gif";
          }

          # Edge TTL is long (image_ttl, default 1y) because uploads purge
          # image-<slug>. Browsers can't be purged and image URLs are not
          # versioned, so their TTL is capped at 1 day.
          declare local var.image_ttl STRING;
          set var.image_ttl = table.lookup(edge_cms_config, "image_ttl", "31536000");
          set beresp.ttl = std.atoi(var.image_ttl);
          set beresp.http.Cache-Control = "public, max-age=86400";
        } else {
          # Missing objects / Object Storage errors: cache briefly at the
          # edge to absorb floods, never in browsers.
          set beresp.ttl = 60s;
          set beresp.http.Cache-Control = "private, no-store";
        }
      }
    VCL
  }

  snippet {
    name     = "images-deliver"
    type     = "deliver"
    priority = 100
    content  = <<-VCL
      # Strip internal headers before sending to client
      unset resp.http.X-Amz-Request-Id;
      unset resp.http.X-Amz-Id-2;
      unset resp.http.X-Amz-Version-Id;

      # Image responses must never be interpreted as anything but an image,
      # even if a non-image byte stream was stored under an image name.
      if (req.url.path ~ "^/images/") {
        set resp.http.X-Content-Type-Options = "nosniff";
        set resp.http.Content-Security-Policy = "default-src 'none'; sandbox";
      }
    VCL
  }

  # Truncated client IP for the VCL request log (IPv4 /24 -> a.b.c.0,
  # IPv6 /48 -> h1:h2:h3::). Computed in deliver, which always runs before
  # vcl_log; req headers set here are never sent to a backend.
  # addr.extract_bits numbers bits from the least-significant end.
  # Ref: https://www.fastly.com/documentation/reference/vcl/functions/addr/addr-extract-bits/
  snippet {
    name     = "log-client-ip"
    type     = "deliver"
    priority = 90
    content  = <<-VCL
      declare local var.log_ip IP;
      set var.log_ip = std.str2ip(req.http.Fastly-Client-IP, "0.0.0.0");
      if (addr.is_ipv6(var.log_ip)) {
        set req.http.X-Edge-CMS-Log-IP =
          std.itoa_charset(addr.extract_bits(var.log_ip, 112, 16), "0123456789abcdef") + ":" +
          std.itoa_charset(addr.extract_bits(var.log_ip, 96, 16), "0123456789abcdef") + ":" +
          std.itoa_charset(addr.extract_bits(var.log_ip, 80, 16), "0123456789abcdef") + "::";
      } else {
        set req.http.X-Edge-CMS-Log-IP =
          std.itoa(addr.extract_bits(var.log_ip, 24, 8)) + "." +
          std.itoa(addr.extract_bits(var.log_ip, 16, 8)) + "." +
          std.itoa(addr.extract_bits(var.log_ip, 8, 8)) + ".0";
      }
    VCL
  }

  # Expose the edge cache result for the page load to the browser (read from
  # Navigation Timing's serverTiming) so the sidebar can show HIT / MISS / PASS.
  snippet {
    name     = "cache-status"
    type     = "deliver"
    priority = 10
    content  = <<-VCL
      if (fastly_info.state ~ "^(HIT|MISS|PASS)") {
        set resp.http.Server-Timing = "cdn-cache;desc=" + re.group.1;
      }
    VCL
  }

  # Browsers must revalidate cached HTML so per-load data (e.g. the sidebar
  # cache status) is never stale. Edge TTL is unaffected: it comes from
  # Surrogate-Control and is already decided before deliver runs. Only public
  # HTML is touched; admin pages (private, no-store) and assets keep their own
  # Cache-Control.
  snippet {
    name     = "html-revalidate"
    type     = "deliver"
    priority = 20
    content  = <<-VCL
      if (resp.http.Content-Type ~ "^text/html" && resp.http.Cache-Control ~ "public") {
        set resp.http.Cache-Control = "public, no-cache";
      }
    VCL
  }

  snippet {
    name     = "debug-headers"
    type     = "deliver"
    priority = 10
    content  = <<-VCL
      set resp.http.X-Edge-CMS-VCL-Version = req.vcl.version;
    VCL
  }

  # Optional request log (var.enable_vcl_logging, default off).
  # Privacy: client IP is truncated to /24 (IPv4) or /48 (IPv6) by the
  # log-client-ip snippet, and only the URL path is logged (query strings can
  # carry tokens or personal data).
  dynamic "logging_https" {
    for_each = var.enable_vcl_logging && var.logging_endpoint_url != "" ? [1] : []
    content {
      name              = "edge-cms-cdn-logs"
      url               = var.logging_endpoint_url
      method            = "POST"
      content_type      = "application/json"
      header_name       = "Authorization"
      header_value      = "Bearer ${var.logging_token}"
      message_type      = "blank"
      request_max_bytes = 0
      json_format       = "2"
      # "%{" must be written "%%{" in Terraform strings; a bare "%" is literal.
      format = jsonencode({
        timestamp    = "%%{begin:%Y-%m-%dT%H:%M:%SZ}t"
        service_id   = "%%{req.service_id}V"
        path         = "%%{json.escape(req.url.path)}V"
        method       = "%%{req.method}V"
        status       = "%%{resp.status}V"
        cache_status = "%%{fastly_info.state}V"
        region       = "%%{server.region}V"
        pop          = "%%{server.datacenter}V"
        client_ip    = "%%{req.http.X-Edge-CMS-Log-IP}V"
        bytes        = "%B"
        ttfb_ms      = "%%{time.elapsed.msec}V"
      })
    }
  }

  gzip {
    name = "compress-text"
    content_types = [
      "text/html",
      "text/css",
      "text/plain",
      "text/xml",
      "text/javascript",
      "application/javascript",
      "application/json",
      "application/xml",
      "application/rss+xml",
      "application/atom+xml",
      "image/svg+xml",
    ]
    extensions = [
      "html", "htm", "css", "js", "json", "xml", "svg", "txt",
    ]
  }

  product_enablement {
    domain_inspector = true
    image_optimizer  = true
  }

  # force_destroy deactivates the active version so `terraform destroy` can
  # delete the service. Kept: the service holds no data and is fully
  # reproducible from this config (private dictionary items must be
  # re-populated per next_steps).
  force_destroy = true
}

# ---------------------------------------------------------------------------
# Dictionary items — backend selector and image TTL
# ---------------------------------------------------------------------------

resource "fastly_service_dictionary_items" "config" {
  service_id    = fastly_service_vcl.cdn.id
  dictionary_id = { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_config"]
  manage_items  = true

  items = {
    "active_backend" = "rust"
    "image_ttl"      = "31536000"
  }
}
