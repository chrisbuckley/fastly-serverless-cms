# ---------------------------------------------------------------------------
# Compute service — Rust WASM app
# Internal: traffic reaches it through the VCL CDN service.
# Domain: app.<domain> — needs a CNAME to Fastly (see outputs).
# ---------------------------------------------------------------------------

resource "fastly_service_compute" "app" {
  name    = "edge-cms-app"
  comment = "Edge CMS Compute backend — managed by Terraform"

  domain {
    name    = "app.${var.domain}"
    comment = "Internal domain — VCL CDN service uses this as its backend"
  }

  package {
    filename         = var.compute_package_path
    source_code_hash = filesha512(var.compute_package_path)
  }

  # KV Store for post content, index, sidebar config
  resource_link {
    name        = "content"
    resource_id = fastly_kvstore.content.id
  }

  # Secret Store for admin_password, hmac_key, fastly_api_token, purge_service_id,
  # fos_access_key_id, fos_secret_key (for admin image uploads to Object Storage)
  resource_link {
    name        = "secrets"
    resource_id = fastly_secretstore.secrets.id
  }

  # Backend for Fastly Purge API calls — Compute makes HTTP requests here
  # when posts are created/updated/deleted to invalidate the CDN cache.
  backend {
    name              = "fastly-api"
    address           = "api.fastly.com"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "api.fastly.com"
    ssl_sni_hostname  = "api.fastly.com"
  }

  # Backend for writing images to Fastly Object Storage from admin upload handler
  backend {
    name              = "fastly-object-storage"
    address           = "${var.fos_region}.object.fastlystorage.app"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "${var.fos_region}.object.fastlystorage.app"
    ssl_sni_hostname  = "${var.fos_region}.object.fastlystorage.app"
  }

  dynamic "logging_https" {
    for_each = var.logging_endpoint_url != "" ? [1] : []
    content {
      name              = "edge-cms-app-logs"
      url               = var.logging_endpoint_url
      method            = "POST"
      content_type      = "application/json"
      header_name       = "Authorization"
      header_value      = "Bearer ${var.logging_token}"
      message_type      = "blank"
      request_max_bytes = 0
      json_format       = "2"
    }
  }

  force_destroy = true
}
