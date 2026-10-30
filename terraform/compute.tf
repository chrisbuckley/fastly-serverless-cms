# ---------------------------------------------------------------------------
# Compute service — Rust WASM app
# Internal: traffic reaches it through the VCL CDN service. The app rejects
# (403) any request without the VCL-injected Edge-CMS-Origin-Auth header, so
# app.<domain> being publicly resolvable doesn't bypass the CDN layer.
# Domain: app.<domain> — needs a DNS record (see dns_routing_records output).
# ---------------------------------------------------------------------------

resource "fastly_service_compute" "app" {
  name    = "edge-cms-app-rust"
  comment = "Edge CMS Compute backend (Rust) — managed by Terraform"

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
  # origin_auth_token, fos_region, fos_bucket, fos_access_key_id/fos_secret_key
  # (read-write-objects key for admin image uploads to Object Storage)
  resource_link {
    name        = "secrets"
    resource_id = fastly_secretstore.secrets.id
  }

  # Config Store for site_url, cache TTLs and page_size — change values live without redeploying
  resource_link {
    name        = "cache_config"
    resource_id = fastly_configstore.cache_config.id
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

    connect_timeout       = 1000
    first_byte_timeout    = 15000
    between_bytes_timeout = 10000
  }

  # Backend for writing images to Fastly Object Storage from admin upload handler
  backend {
    name              = "fastly-object-storage"
    address           = "${var.fos_region}.object.fastlystorage.app"
    port              = 443
    use_ssl           = true
    ssl_cert_hostname = "${var.fos_region}.object.fastlystorage.app"
    ssl_sni_hostname  = "${var.fos_region}.object.fastlystorage.app"

    connect_timeout       = 1000
    first_byte_timeout    = 15000
    between_bytes_timeout = 10000
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

  # force_destroy deactivates the active version so `terraform destroy` can
  # delete the service. Kept: services hold no data (content lives in the
  # protected KV store) and are fully reproducible from this config.
  force_destroy = true
}

# ---------------------------------------------------------------------------
# Compute service — Go WASM app
# Same stores and backends as Rust. Different domain for coexistence.
# Domain: app-go.<domain>. Set var.go_backend_host to it so the VCL service
# gets a backend for it and dns_routing_records lists its record.
# ---------------------------------------------------------------------------

# Commented out until Fastly Package API 500 is resolved.
# Uncomment and run: terraform import fastly_service_compute.app_go <service-id>
#
# resource "fastly_service_compute" "app_go" {
#   name    = "edge-cms-app-go"
#   comment = "Edge CMS Compute backend (Go) — managed by Terraform"
#
#   domain {
#     name    = "app-go.${var.domain}"
#     comment = "Internal domain — VCL CDN service uses this as a backend"
#   }
#
#   package {
#     filename         = var.compute_go_package_path
#     source_code_hash = filesha512(var.compute_go_package_path)
#   }
#
#   resource_link {
#     name        = "content"
#     resource_id = fastly_kvstore.content.id
#   }
#
#   resource_link {
#     name        = "secrets"
#     resource_id = fastly_secretstore.secrets.id
#   }
#
#   # Required: the Go app reads site_url, TTLs and page_size from cache_config.
#   resource_link {
#     name        = "cache_config"
#     resource_id = fastly_configstore.cache_config.id
#   }
#
#   backend {
#     name              = "fastly-api"
#     address           = "api.fastly.com"
#     port              = 443
#     use_ssl           = true
#     ssl_cert_hostname = "api.fastly.com"
#     ssl_sni_hostname  = "api.fastly.com"
#   }
#
#   backend {
#     name              = "fastly-object-storage"
#     address           = "${var.fos_region}.object.fastlystorage.app"
#     port              = 443
#     use_ssl           = true
#     ssl_cert_hostname = "${var.fos_region}.object.fastlystorage.app"
#     ssl_sni_hostname  = "${var.fos_region}.object.fastlystorage.app"
#   }
#
#   dynamic "logging_https" {
#     for_each = var.logging_endpoint_url != "" ? [1] : []
#     content {
#       # Must match logEndpointName in go/logging.go.
#       name              = "edge-cms-app-logs"
#       url               = var.logging_endpoint_url
#       method            = "POST"
#       content_type      = "application/json"
#       header_name       = "Authorization"
#       header_value      = "Bearer ${var.logging_token}"
#       message_type      = "blank"
#       request_max_bytes = 0
#       json_format       = "2"
#     }
#   }
#
#   force_destroy = true
# }
