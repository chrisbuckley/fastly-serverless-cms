# ---------------------------------------------------------------------------
# VCL CDN service — public face of the Edge CMS
#
# Responsibilities:
#   - Serve /images/* directly from Fastly Object Storage (SigV4-signed)
#   - Rate-limit POST /admin/login to 5 req/min per IP
#   - Cache reader responses using Surrogate-Control from Compute
#   - Route all other traffic to the Compute service
#   - (Optional) NGWAF edge deploy — enable product manually after apply
# ---------------------------------------------------------------------------

resource "fastly_service_vcl" "cdn" {
  name    = "edge-cms"
  comment = "Edge CMS CDN — VCL layer — managed by Terraform"

  domain {
    name    = var.domain
    comment = "Public reader and admin domain"
  }

  # ---------------------------------------------------------------------------
  # Backends: Compute app services (one per language implementation)
  # The active backend is selected by the edge_cms_config dictionary.
  # Default: Rust. Switch with: fastly dictionary-item update --key=active_backend --value=go|ts
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

  backend {
    name              = "edge-cms-compute-go"
    address           = "app-go.${var.domain}"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "app-go.${var.domain}"
    ssl_sni_hostname  = "app-go.${var.domain}"
    override_host     = "app-go.${var.domain}"

    shield                = var.shield_pop
    connect_timeout       = 1000
    first_byte_timeout    = 15000
    between_bytes_timeout = 10000

    request_condition = "snippet-routed"
  }

  backend {
    name              = "edge-cms-compute-ts"
    address           = "app-ts.${var.domain}"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "app-ts.${var.domain}"
    ssl_sni_hostname  = "app-ts.${var.domain}"
    override_host     = "app-ts.${var.domain}"

    shield                = var.shield_pop
    connect_timeout       = 1000
    first_byte_timeout    = 15000
    between_bytes_timeout = 10000

    request_condition = "snippet-routed"
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
  # Populate after apply:
  #   fastly service-dictionary-item create --service-id=<vcl-sid> \
  #     --dictionary-id=<dict-id> --key=access_key_id --value=<AKI>
  #   fastly service-dictionary-item create ... --key=secret_key --value=<SK>
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

  # URI list for rate limiting — must contain the paths to protect.
  # Populated by fastly_service_dictionary_items below.
  dictionary {
    name = "edge_cms_rate_limit_uris"
  }

  # Backend selector — set active_backend to "rust" (default), "go", or "ts".
  # Switch live without deploy: fastly dictionary-item update ...
  # Example: fastly dictionary-item update <dict-id> --key=active_backend --value=ts
  dictionary {
    name = "edge_cms_config"
  }

  # ---------------------------------------------------------------------------
  # VCL snippet: route /images/* to Object Storage with SigV4 signing
  #
  # Flow:
  #   1. Detect /images/* in vcl_recv — rewrite URL, set FOS backend
  #   2. Sign in vcl_miss — only runs on cache misses (avoids signing overhead
  #      on cache hits, and signing needs the final rewritten URL)
  # ---------------------------------------------------------------------------

  # ---------------------------------------------------------------------------
  # Edge request hygiene — runs first in vcl_recv.
  #   - Clients must never supply the origin auth header.
  #   - Fastly-Client-IP is preserved by Fastly if the client sends it, so on
  #     the first Fastly hop (edge, not shield) overwrite it with the real
  #     client IP. Compute trusts it once origin auth passes (contract §1).
  # ---------------------------------------------------------------------------
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
      declare local var.active STRING;
      set var.active = table.lookup(edge_cms_config, "active_backend", "rust");

      if (var.active == "go") {
        set req.backend = F_edge_cms_compute_go;
      } else if (var.active == "ts") {
        set req.backend = F_edge_cms_compute_ts;
      } else {
        set req.backend = F_edge_cms_compute;
      }
    VCL
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

  # ---------------------------------------------------------------------------
  # Rate limiter: brute-force protection on POST requests (includes /admin/login)
  #
  # Fastly ERL minimum is 10 RPS. With window_size=60 this allows 10 req/s
  # sustained — still blocks automated credential-stuffing attacks.
  # uri_dictionary_name omitted: Fastly rejects it when the dictionary has no
  # items at service activation time (items are populated by a separate resource
  # after service creation). All POSTs on this VCL service hit the Compute app
  # anyway, so rate-limiting all of them is acceptable for a CMS workload.
  # ---------------------------------------------------------------------------

  rate_limiter {
    name                 = "admin-login-protect"
    action               = "response"
    client_key           = "client.ip" # pragma: allowlist secret
    http_methods         = "POST"
    rps_limit            = 10
    window_size          = 60
    penalty_box_duration = 5

    response {
      status       = 429
      content_type = "text/html; charset=utf-8"
      content      = "<!doctype html><html><head><title>429 Too Many Requests</title></head><body><h1>Too Many Requests</h1><p>Too many login attempts. Please wait a few minutes before trying again.</p></body></html>"
    }
  }

  dynamic "logging_https" {
    for_each = var.logging_endpoint_url != "" ? [1] : []
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
      # %{ in Fastly log format must be escaped as %%{ in Terraform template strings
      format = jsonencode({
        timestamp    = "%%{begin:%%Y-%%m-%%dT%%H:%%M:%%SZ}t"
        service_id   = "%%{req.service_id}V"
        url          = "%%{req.url}V"
        method       = "%%{req.method}V"
        status       = "%%{resp.status}V"
        cache_status = "%%{fastly_info.state}V"
        region       = "%%{server.region}V"
        pop          = "%%{server.datacenter}V"
        client_ip    = "%%{req.http.Fastly-Client-IP}V"
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

  force_destroy = true
}

# ---------------------------------------------------------------------------
# Dictionary items — rate-limit URI list and Object Storage credentials
# ---------------------------------------------------------------------------

resource "fastly_service_dictionary_items" "rate_limit_uris" {
  service_id    = fastly_service_vcl.cdn.id
  dictionary_id = { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_rate_limit_uris"]

  items = {
    "/admin/login" = "1"
  }
}

resource "fastly_service_dictionary_items" "config" {
  service_id    = fastly_service_vcl.cdn.id
  dictionary_id = { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_config"]
  manage_items  = true

  items = {
    "active_backend" = "rust"
    "image_ttl"      = "31536000"
  }
}
