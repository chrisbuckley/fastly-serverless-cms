# ---------------------------------------------------------------------------
# KV Store — post content, index, sidebar config
# ---------------------------------------------------------------------------

resource "fastly_kvstore" "content" {
  name          = "edge-cms-content"
  location      = "US"
  force_destroy = true
}

# ---------------------------------------------------------------------------
# Secret Store — admin_password (bcrypt), hmac_key, fastly_api_token,
#                purge_service_id, fos_access_key_id, fos_secret_key
#
# The store is created empty. Populate secrets manually after apply:
#   fastly secret-store-entry create --store-id=<id> --name=<key> --secret=<val>
# ---------------------------------------------------------------------------

resource "fastly_secretstore" "secrets" {
  name = "edge-cms-secrets"
}

# ---------------------------------------------------------------------------
# Config Store — cache TTLs (page_ttl, asset_ttl, image_ttl)
#
# Values are seconds. Change live without deploy via:
#   fastly config-store-entry update --store-id=<id> --key=page_ttl --value=86400
# ---------------------------------------------------------------------------

resource "fastly_configstore" "cache_config" {
  name          = "edge-cms-cache-config"
  force_destroy = true
}

resource "fastly_configstore_entries" "cache_config" {
  store_id       = fastly_configstore.cache_config.id
  manage_entries = true

  entries = {
    page_ttl  = "2592000"
    asset_ttl = "31536000"
    image_ttl = "31536000"
  }
}

# ---------------------------------------------------------------------------
# Fastly Object Storage — image bucket + access key
# ---------------------------------------------------------------------------

resource "fastly_object_storage_access_keys" "fos" {
  description = "edge-cms image store — read-write for VCL and Compute"
  permission  = "read-write-admin"
  buckets     = [var.fos_bucket]
}

# Object Storage bucket is created manually (Terraform chicken-and-egg: AWS
# provider needs credentials that come from fastly_object_storage_access_keys,
# which doesn't exist at plan time). After first `terraform apply`:
#
#   eval "$(terraform output -json | jq -r '"
#     export AWS_ACCESS_KEY_ID=\(.fos_access_key_id.value)
#     export AWS_SECRET_ACCESS_KEY=\(.fos_secret_key.value)"')"
#   aws s3 mb s3://edge-cms-images \
#     --endpoint-url https://us-east-1.object.fastlystorage.app \
#     --region us-east-1
#
# Or simply: see the "BUCKET" step in the next_steps output.
