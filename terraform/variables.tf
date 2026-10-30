variable "domain" {
  description = "Public domain for the Edge CMS (e.g. edge-cms.example.com)"
  type        = string
}

variable "compute_package_path" {
  description = "Path to the Rust Compute package — run `fastly compute build` in rust/ first"
  type        = string
  default     = "../rust/pkg/edge-cms.tar.gz"
}

variable "compute_go_package_path" {
  description = "Path to the Go Compute package — run `make build` in go/ first"
  type        = string
  default     = "../go/pkg/edge-cms-go.tar.gz"
}

variable "go_backend_host" {
  description = "Hostname of the Go Compute service (e.g. app-go.edge-cms.example.com). Empty (default) = no Go backend on the VCL service; active_backend=go then falls back to Rust."
  type        = string
  default     = ""
}

variable "ts_backend_host" {
  description = "Hostname of the TypeScript Compute service (e.g. app-ts.edge-cms.example.com). Empty (default) = no TS backend on the VCL service; active_backend=ts then falls back to Rust."
  type        = string
  default     = ""
}

variable "fos_region" {
  description = "Fastly Object Storage region (us-east-1, eu-central-1, ap-southeast-1, etc.)"
  type        = string
  default     = "us-east-1"
}

variable "fos_bucket" {
  description = "Fastly Object Storage bucket name for images"
  type        = string
  default     = "edge-cms-images"
}

variable "shield_pop" {
  description = "Fastly POP code for origin shielding on the Compute backend (e.g. lax-ca-us, iad-va-us)"
  type        = string
  default     = "iad-va-us"
}

variable "logging_endpoint_url" {
  description = "HTTPS logging drain URL — leave empty to disable. Used by the Compute app (endpoint edge-cms-app-logs) and, if enable_vcl_logging, the VCL service."
  type        = string
  default     = ""
}

variable "enable_vcl_logging" {
  description = "Also stream VCL CDN request logs to logging_endpoint_url (default off). Entries carry a truncated client IP (/24 IPv4, /48 IPv6) and the URL path only — never the query string."
  type        = bool
  default     = false
}

variable "logging_token" {
  description = "Bearer token for the logging endpoint"
  type        = string
  default     = ""
  sensitive   = true
}
