output "vcl_service_id" {
  description = "VCL CDN service ID — use this as purge_service_id in the Secret Store"
  value       = fastly_service_vcl.cdn.id
}

output "compute_service_id" {
  description = "Compute app service ID (Rust)"
  value       = fastly_service_compute.app.id
}

output "compute_go_service_id" {
  description = "Compute app service ID (Go)"
  value       = fastly_service_compute.app_go.id
}

output "content_kv_store_id" {
  description = "KV Store ID for post content, index, sidebar"
  value       = fastly_kvstore.content.id
}

output "secret_store_id" {
  description = "Secret Store ID — populate manually after apply"
  value       = fastly_secretstore.secrets.id
}

output "fos_access_key_id" {
  description = "Object Storage access key ID"
  value       = fastly_object_storage_access_keys.fos.access_key_id
}

output "fos_secret_key" {
  description = "Object Storage secret key"
  value       = fastly_object_storage_access_keys.fos.secret_key
  sensitive   = true
}

output "fos_dict_id" {
  description = "Private VCL dictionary ID for FOS SigV4 credentials"
  value       = { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_fos_creds"]
}

# ---------------------------------------------------------------------------
# Squarespace DNS — routing CNAMEs
# Add these to route traffic to Fastly.
# j.sni.global.fastly.net is the correct SNI endpoint for TLS subscriptions.
# ---------------------------------------------------------------------------

output "config_dict_id" {
  description = "Config dictionary ID — set active_backend to rust/go/ts"
  value       = { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_config"]
}

output "squarespace_dns_routing_cnames" {
  description = "Add these CNAME records in Squarespace DNS — wildcard covers all subdomains"
  value = {
    "${var.domain}."   = "CNAME  j.sni.global.fastly.net"
    "*.${var.domain}." = "CNAME  j.sni.global.fastly.net"
  }
}

# ---------------------------------------------------------------------------
# TLS — wildcard cert, provisioned via main account (automation account lacks TLS)
# ---------------------------------------------------------------------------

output "tls_provisioning_commands" {
  description = "Run with your MAIN account token to provision a wildcard Let's Encrypt cert"
  value       = <<-EOT
    MAIN_TOKEN="<your-main-fastly-api-token>"

    # Single wildcard subscription covers ${var.domain} + *.${var.domain}
    # (app, app-go, app-ts, any future subdomains — no new certs needed)
    FASTLY_API_TOKEN=$MAIN_TOKEN fastly tls-subscription create \
      --domain=${var.domain} \
      --domain=*.${var.domain} \
      --cert-authority=lets-encrypt

    # Check for DNS validation records to add:
    FASTLY_API_TOKEN=$MAIN_TOKEN fastly tls-subscription list
  EOT
}

# ---------------------------------------------------------------------------
# Post-apply checklist
# ---------------------------------------------------------------------------

output "next_steps" {
  description = "Post-apply checklist with exact CLI commands"
  value       = <<-EOT

    ┌──────────────────────────────────────────────────────────────────────┐
    │  Edge CMS — post-apply checklist                                     │
    └──────────────────────────────────────────────────────────────────────┘

    IDs (copy these — used in every command below):
      VCL service:    ${fastly_service_vcl.cdn.id}
      Compute (Rust): ${fastly_service_compute.app.id}
      Compute (Go):   ${fastly_service_compute.app_go.id}
      KV Store:       ${fastly_kvstore.content.id}
      Secret Store:   ${fastly_secretstore.secrets.id}
      FOS key ID:     ${fastly_object_storage_access_keys.fos.access_key_id}
      FOS dict:       ${ { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_fos_creds"]}
      Config dict:    ${ { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_config"]}

    ── DNS (Squarespace) ────────────────────────────────────────────────────

    Routing CNAMEs (wildcard covers all subdomains):
      ${var.domain}           →  j.sni.global.fastly.net
      *.${var.domain}         →  j.sni.global.fastly.net

    TLS: single wildcard cert covers ${var.domain} + *.${var.domain}
      terraform output tls_provisioning_commands   # shows CLI command
      # then: fastly tls-subscription list         # shows validation CNAME to add

    ── Secrets ─────────────────────────────────────────────────────────────

    # Generate admin password hash (Python bcrypt):
    BCRYPT=$(python3 -c "import bcrypt; print(bcrypt.hashpw(b'YOUR_PASSWORD', bcrypt.gensalt()).decode())")
    FOS_SECRET=$(terraform output -raw fos_secret_key)

    SSID="${fastly_secretstore.secrets.id}"
    echo -n "$BCRYPT"                                        | fastly secret-store-entry create --store-id=$SSID --name=admin_password   --stdin --recreate-allow
    echo -n "$(openssl rand -base64 32)"                    | fastly secret-store-entry create --store-id=$SSID --name=hmac_key         --stdin --recreate-allow
    echo -n '<YOUR_FASTLY_API_TOKEN>'                        | fastly secret-store-entry create --store-id=$SSID --name=fastly_api_token  --stdin --recreate-allow  # needs purge scope on VCL service
    echo -n "${fastly_service_vcl.cdn.id}"                  | fastly secret-store-entry create --store-id=$SSID --name=purge_service_id  --stdin --recreate-allow
    echo -n "${fastly_object_storage_access_keys.fos.access_key_id}" | fastly secret-store-entry create --store-id=$SSID --name=fos_access_key_id --stdin --recreate-allow
    echo -n "$FOS_SECRET"                                   | fastly secret-store-entry create --store-id=$SSID --name=fos_secret_key    --stdin --recreate-allow
    echo -n "${var.fos_region}"                             | fastly secret-store-entry create --store-id=$SSID --name=fos_region        --stdin --recreate-allow
    echo -n "${var.fos_bucket}"                             | fastly secret-store-entry create --store-id=$SSID --name=fos_bucket        --stdin --recreate-allow

    ── VCL Dictionary (FOS SigV4 credentials) ──────────────────────────────

    VCL_SID="${fastly_service_vcl.cdn.id}"
    DICT_ID="${ { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_fos_creds"]}"

    fastly service-dictionary-item create --service-id=$VCL_SID --dictionary-id=$DICT_ID \
      --key=access_key_id --value="${fastly_object_storage_access_keys.fos.access_key_id}"
    fastly service-dictionary-item create --service-id=$VCL_SID --dictionary-id=$DICT_ID \
      --key=secret_key --value="$(terraform output -raw fos_secret_key)"

    ── Object Storage bucket ────────────────────────────────────────────────

    export AWS_ACCESS_KEY_ID="${fastly_object_storage_access_keys.fos.access_key_id}"
    export AWS_SECRET_ACCESS_KEY="$(terraform output -raw fos_secret_key)"
    aws s3 mb s3://${var.fos_bucket} \
      --endpoint-url https://${var.fos_region}.object.fastlystorage.app \
      --region ${var.fos_region}

    ── KV seed (empty initial state) ───────────────────────────────────────

    KVID="${fastly_kvstore.content.id}"
    fastly kv-store-entry create --store-id=$KVID --key=_index   --value='{"posts":[]}'
    fastly kv-store-entry create --store-id=$KVID --key=_sidebar --value='{"items":[]}'

    ── Backend switching ───────────────────────────────────────────────

    CONFIG_DICT="${ { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }["edge_cms_config"]}"

    # Set initial backend (default is Rust if key missing):
    fastly service-dictionary-item create --service-id=$VCL_SID --dictionary-id=$CONFIG_DICT \
      --key=active_backend --value=rust

    # Switch to Go (no deploy needed — takes effect immediately):
    fastly service-dictionary-item update --service-id=$VCL_SID --dictionary-id=$CONFIG_DICT \
      --key=active_backend --value=go

    # Switch back to Rust:
    fastly service-dictionary-item update --service-id=$VCL_SID --dictionary-id=$CONFIG_DICT \
      --key=active_backend --value=rust

    ── NGWAF (optional) ────────────────────────────────────────────────────

    Provision NGWAF workspace in the NGWAF console, link to VCL service
    ${fastly_service_vcl.cdn.id}, then add to vcl.tf:
      product_enablement { ngwaf { enabled = true } }

  EOT
}
