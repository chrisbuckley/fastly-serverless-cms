locals {
  dictionary_ids = { for d in fastly_service_vcl.cdn.dictionary : d.name => d.dictionary_id }
}

output "vcl_service_id" {
  description = "VCL CDN service ID — use this as purge_service_id in the Secret Store"
  value       = fastly_service_vcl.cdn.id
}

output "compute_service_id" {
  description = "Compute app service ID (Rust)"
  value       = fastly_service_compute.app.id
}

# Uncomment when Go Compute service is managed by Terraform
# output "compute_go_service_id" {
#   description = "Compute app service ID (Go)"
#   value       = fastly_service_compute.app_go.id
# }

output "content_kv_store_id" {
  description = "KV Store ID for post content, index, sidebar"
  value       = fastly_kvstore.content.id
}

output "secret_store_id" {
  description = "Secret Store ID — populate manually after apply"
  value       = fastly_secretstore.secrets.id
}

output "fos_readonly_access_key_id" {
  description = "Object Storage read-only key ID (VCL edge_cms_fos_creds dictionary)"
  value       = fastly_object_storage_access_keys.fos_readonly.access_key_id
}

output "fos_readonly_secret_key" {
  description = "Object Storage read-only secret key (VCL edge_cms_fos_creds dictionary)"
  value       = fastly_object_storage_access_keys.fos_readonly.secret_key
  sensitive   = true
}

output "fos_readwrite_access_key_id" {
  description = "Object Storage read-write-objects key ID (Compute secret fos_access_key_id)"
  value       = fastly_object_storage_access_keys.fos_readwrite.access_key_id
}

output "fos_readwrite_secret_key" {
  description = "Object Storage read-write-objects secret key (Compute secret fos_secret_key)"
  value       = fastly_object_storage_access_keys.fos_readwrite.secret_key
  sensitive   = true
}

output "fos_dict_id" {
  description = "Private VCL dictionary ID for FOS SigV4 credentials"
  value       = local.dictionary_ids["edge_cms_fos_creds"]
}

output "private_dict_id" {
  description = "Private VCL dictionary ID for the origin auth token (edge_cms_private)"
  value       = local.dictionary_ids["edge_cms_private"]
}

output "origin_auth_token" {
  description = "Shared secret for the Edge-CMS-Origin-Auth header — write to the secret store and edge_cms_private (see next_steps)"
  value       = random_password.origin_auth_token.result
  sensitive   = true
}

output "config_dict_id" {
  description = "Config dictionary ID — set active_backend to rust/go/ts"
  value       = local.dictionary_ids["edge_cms_config"]
}

# ---------------------------------------------------------------------------
# DNS — explicit routing records (no wildcard)
# One record per hostname that a Fastly service actually serves, so a
# dangling wildcard can't route arbitrary subdomains to Fastly.
# j.sni.global.fastly.net is the SNI endpoint for TLS subscriptions.
# If var.domain is a zone apex, a CNAME is not allowed there: use your DNS
# provider's ALIAS/ANAME record or Fastly's documented apex A records.
# ---------------------------------------------------------------------------

locals {
  dns_routing_records = merge(
    {
      "${var.domain}."     = "CNAME  j.sni.global.fastly.net" # VCL CDN service (public)
      "app.${var.domain}." = "CNAME  j.sni.global.fastly.net" # Rust Compute service (origin for VCL)
    },
    { for k, v in local.optional_compute_backends : "${v.host}." => "CNAME  j.sni.global.fastly.net" },
  )
}

output "dns_routing_records" {
  description = "DNS records to create (explicit hostnames only, no wildcard)"
  value       = local.dns_routing_records
}

# ---------------------------------------------------------------------------
# TLS — wildcard cert, provisioned via main account (automation account lacks TLS)
# ---------------------------------------------------------------------------

output "tls_provisioning_commands" {
  description = "Run with your MAIN account token to provision a wildcard Let's Encrypt cert"
  value       = <<-EOT
    # Paste your MAIN account token (hidden); exported only for these commands.
    IFS= read -rs FASTLY_API_TOKEN; export FASTLY_API_TOKEN

    # Single wildcard subscription covers ${var.domain} + *.${var.domain}
    # (app, app-go, app-ts, any future subdomains — no new certs needed).
    # DNS still uses explicit records only (see dns_routing_records).
    fastly tls-subscription create \
      --domain=${var.domain} \
      --domain=*.${var.domain} \
      --cert-authority=lets-encrypt

    # Check for DNS validation records to add:
    fastly tls-subscription list
    unset FASTLY_API_TOKEN
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
      Compute (Go/TS): (managed via CLI — see compute.tf; set go_backend_host / ts_backend_host)
      KV Store:       ${fastly_kvstore.content.id}
      Secret Store:   ${fastly_secretstore.secrets.id}
      FOS RO key ID:  ${fastly_object_storage_access_keys.fos_readonly.access_key_id}  (VCL)
      FOS RW key ID:  ${fastly_object_storage_access_keys.fos_readwrite.access_key_id}  (Compute)
      FOS dict:       ${local.dictionary_ids["edge_cms_fos_creds"]}
      Private dict:   ${local.dictionary_ids["edge_cms_private"]}
      Config dict:    ${local.dictionary_ids["edge_cms_config"]}

    ── DNS (Squarespace) ────────────────────────────────────────────────────

    Routing records (explicit hostnames, no wildcard — see dns_routing_records):
%{for host, rec in local.dns_routing_records~}
      ${host}  ${rec}
%{endfor~}

    TLS: single wildcard cert covers ${var.domain} + *.${var.domain}
      terraform output tls_provisioning_commands   # shows CLI command
      # then: fastly tls-subscription list         # shows validation CNAME to add

    ── Secrets (Compute Secret Store) ─────────────────────────────────────

    # Secret values never go on a command line or through `echo`: they are
    # piped from terraform output / a generator, or typed into `read -rs`
    # and passed with printf (a shell builtin — not visible in `ps`).
    SSID="${fastly_secretstore.secrets.id}"

    # Origin auth token (Terraform-generated) — write BEFORE deploying the
    # Compute packages that enforce it, together with edge_cms_private below.
    terraform output -raw origin_auth_token \
      | fastly secret-store-entry create --store-id=$SSID --name=origin_auth_token --stdin --recreate-allow

    # Admin password — bcrypt-hashed; the password is read from the TTY.
    python3 -c 'import bcrypt,getpass,sys; sys.stdout.write(bcrypt.hashpw(getpass.getpass("Admin password: ").encode(), bcrypt.gensalt()).decode())' \
      | fastly secret-store-entry create --store-id=$SSID --name=admin_password --stdin --recreate-allow

    # Session HMAC key
    openssl rand -base64 32 | tr -d '\n' \
      | fastly secret-store-entry create --store-id=$SSID --name=hmac_key --stdin --recreate-allow

    # Fastly API token with purge scope on the VCL service
    IFS= read -rs PURGE_TOKEN; printf '%s' "$PURGE_TOKEN" \
      | fastly secret-store-entry create --store-id=$SSID --name=fastly_api_token --stdin --recreate-allow
    unset PURGE_TOKEN

    # Object Storage read-write-objects key (uploads)
    terraform output -raw fos_readwrite_access_key_id \
      | fastly secret-store-entry create --store-id=$SSID --name=fos_access_key_id --stdin --recreate-allow
    terraform output -raw fos_readwrite_secret_key \
      | fastly secret-store-entry create --store-id=$SSID --name=fos_secret_key --stdin --recreate-allow

    # Non-secret settings (still read from the Secret Store by Compute)
    terraform output -raw vcl_service_id \
      | fastly secret-store-entry create --store-id=$SSID --name=purge_service_id --stdin --recreate-allow
    printf '%s' "${var.fos_region}" | fastly secret-store-entry create --store-id=$SSID --name=fos_region --stdin --recreate-allow
    printf '%s' "${var.fos_bucket}" | fastly secret-store-entry create --store-id=$SSID --name=fos_bucket --stdin --recreate-allow

    ── VCL private dictionaries ────────────────────────────────────────────

    # Terraform can't manage items in private (write-only) dictionaries.
    # `dictionary-entry update --file` takes a batch JSON file; feeding it via
    # process substitution keeps values off the command line.
    VCL_SID="${fastly_service_vcl.cdn.id}"

    # edge_cms_private — origin auth token (same value as the secret above)
    fastly service dictionary-entry update --service-id=$VCL_SID \
      --dictionary-id="${local.dictionary_ids["edge_cms_private"]}" \
      --file=<(terraform output -raw origin_auth_token \
        | jq -Rs '{items: [{op: "upsert", item_key: "origin_auth_token", item_value: .}]}')

    # edge_cms_fos_creds — Object Storage READ-ONLY key for SigV4 in VCL
    fastly service dictionary-entry update --service-id=$VCL_SID \
      --dictionary-id="${local.dictionary_ids["edge_cms_fos_creds"]}" \
      --file=<(jq -n --arg id "$(terraform output -raw fos_readonly_access_key_id)" \
                     --rawfile sk <(terraform output -raw fos_readonly_secret_key) \
        '{items: [{op: "upsert", item_key: "access_key_id", item_value: $id},
                  {op: "upsert", item_key: "secret_key",    item_value: $sk}]}')

    ── Object Storage bucket ────────────────────────────────────────────────

    # One-off (skip if the bucket exists). Neither Terraform-managed key can
    # create buckets, so mint a temporary admin key and delete it afterwards.
    fastly object-storage access-keys create --description="edge-cms bucket bootstrap (delete me)" \
      --permission=read-write-admin
    IFS= read -r  AWS_ACCESS_KEY_ID;     export AWS_ACCESS_KEY_ID      # paste the key ID
    IFS= read -rs AWS_SECRET_ACCESS_KEY; export AWS_SECRET_ACCESS_KEY  # paste the secret (hidden)
    aws s3 mb s3://${var.fos_bucket} \
      --endpoint-url https://${var.fos_region}.object.fastlystorage.app \
      --region ${var.fos_region}
    fastly object-storage access-keys delete --ak-id="$AWS_ACCESS_KEY_ID"
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

    ── Edge Rate Limiting ──────────────────────────────────────────────────

    The login-ratelimit snippet uses ratecounter/penaltybox, which need the
    Edge Rate Limiting product enabled on VCL service ${fastly_service_vcl.cdn.id}.

    ── KV seed (empty initial state) ───────────────────────────────────────

    KVID="${fastly_kvstore.content.id}"
    fastly kv-store-entry create --store-id=$KVID --key=_index   --value='{"posts":[]}'
    fastly kv-store-entry create --store-id=$KVID --key=_sidebar --value='{"items":[]}'

    ── Backend switching ───────────────────────────────────────────────

    CONFIG_DICT="${local.dictionary_ids["edge_cms_config"]}"

    # active_backend is managed by Terraform (default rust) and a manual
    # change is reverted on the next apply. Go/TS only work when
    # go_backend_host / ts_backend_host are set; otherwise Rust is used.
    # Live switch (no deploy, takes effect immediately):
    fastly service dictionary-entry update --service-id=$VCL_SID --dictionary-id=$CONFIG_DICT \
      --key=active_backend --value=go

    # Switch back to Rust:
    fastly service dictionary-entry update --service-id=$VCL_SID --dictionary-id=$CONFIG_DICT \
      --key=active_backend --value=rust

    ── NGWAF (optional) ────────────────────────────────────────────────────

    Provision NGWAF workspace in the NGWAF console, link to VCL service
    ${fastly_service_vcl.cdn.id}, then add to vcl.tf:
      product_enablement { ngwaf { enabled = true } }

  EOT
}
