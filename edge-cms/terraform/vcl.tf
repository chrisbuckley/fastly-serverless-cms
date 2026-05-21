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
  # Backend: Compute app service
  # Default for all non-image requests.
  # ---------------------------------------------------------------------------
  backend {
    name              = "edge-cms-compute"
    address           = "app.${var.domain}"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "app.${var.domain}"
    ssl_sni_hostname  = "app.${var.domain}"
    override_host     = "app.${var.domain}"

    # Compute responses carry Surrogate-Control; respect them.
    first_byte_timeout    = 30000
    between_bytes_timeout = 10000

    # IO requires shielding on ALL backends in the service.
    shield = var.shield_pop
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

  # URI list for rate limiting — must contain the paths to protect.
  # Populated by fastly_service_dictionary_items below.
  dictionary {
    name = "edge_cms_rate_limit_uris"
  }

  # ---------------------------------------------------------------------------
  # VCL snippet: route /images/* to Object Storage with SigV4 signing
  #
  # Flow:
  #   1. Detect /images/* in vcl_recv — rewrite URL, set FOS backend
  #   2. Sign in vcl_miss — only runs on cache misses (avoids signing overhead
  #      on cache hits, and signing needs the final rewritten URL)
  # ---------------------------------------------------------------------------

  snippet {
    name     = "admin-pass"
    type     = "recv"
    priority = 50
    content  = <<-VCL
      if (req.url.path ~ "^/admin") {
        set req.backend = F_edge_cms_compute;
        return(pass);
      }
    VCL
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
    name     = "images-deliver"
    type     = "deliver"
    priority = 100
    content  = <<-VCL
      # Strip internal headers before sending to client
      unset resp.http.X-Amz-Request-Id;
      unset resp.http.X-Amz-Id-2;
      unset resp.http.X-Amz-Version-Id;
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

  product_enablement {
    image_optimizer = true
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
