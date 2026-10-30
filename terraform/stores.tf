# ---------------------------------------------------------------------------
# KV Store — post content, index, sidebar config
#
# This is the only copy of the site's content: Terraform must never delete
# it. force_destroy = false makes the API refuse to delete a non-empty store,
# and prevent_destroy makes any plan that would destroy it fail. To really
# remove it, export the content first, then remove both guards deliberately.
# NOTE: changing `name` or `location` forces replacement — prevent_destroy
# will block that plan, which is intended.
# ---------------------------------------------------------------------------

resource "fastly_kvstore" "content" {
  name          = "edge-cms-content"
  location      = "US"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Secret Store — admin_password (bcrypt), hmac_key, fastly_api_token,
#                purge_service_id, fos_access_key_id, fos_secret_key,
#                fos_region, fos_bucket, origin_auth_token
#
# The Fastly provider has no resource for secret store entries, so the store
# is created empty and populated after apply with `--stdin` (see the
# next_steps output). Never pass secret values as command-line arguments.
# ---------------------------------------------------------------------------

resource "fastly_secretstore" "secrets" {
  name = "edge-cms-secrets"
}

# ---------------------------------------------------------------------------
# Origin auth — shared secret the VCL service sends to the Compute services
# in the Edge-CMS-Origin-Auth header (contract §1). Compute rejects any
# request without it, so app.<domain> can't be used to bypass the CDN layer.
#
# Terraform generates the value; it must be written (post-apply, see
# next_steps) to BOTH:
#   - Secret Store `secrets`, key `origin_auth_token`   (read by Compute)
#   - private dictionary `edge_cms_private`, key `origin_auth_token` (VCL)
# Neither can be written by Terraform: the provider has no secret-entry
# resource and cannot manage items in write-only (private) dictionaries.
#
# Rotate: terraform apply -replace=random_password.origin_auth_token, then
# rewrite the dictionary item first and the secret second (brief 403s on
# requests in flight between the two writes).
# ---------------------------------------------------------------------------

resource "random_password" "origin_auth_token" {
  length  = 48
  special = false
}

# ---------------------------------------------------------------------------
# Config Store — site_url, cache TTLs (page_ttl, asset_ttl, image_ttl),
#                page_size
#
# TTLs are seconds. Edits made outside Terraform are reverted on the next
# apply (manage_entries = true). Change live without deploy (until the next
# apply — update the value here to make it stick) via:
#   fastly config-store-entry update --store-id=<id> --key=page_ttl --value=86400
# ---------------------------------------------------------------------------

# force_destroy = true is fine here: every entry is declared below, so the
# store can be recreated from this file with no data loss.
resource "fastly_configstore" "cache_config" {
  name          = "edge-cms-cache-config"
  force_destroy = true
}

resource "fastly_configstore_entries" "cache_config" {
  store_id       = fastly_configstore.cache_config.id
  manage_entries = true

  entries = {
    site_url  = "https://${var.domain}" # absolute, no trailing slash — canonical URLs, CSRF Origin check
    page_ttl  = "86400"
    asset_ttl = "31536000"
    image_ttl = "31536000"
    page_size = "10" # posts per page on home and tag listings
  }
}

# ---------------------------------------------------------------------------
# Fastly Object Storage — least-privilege access keys (one per consumer)
#
# Permission values (Fastly API, Object Storage access keys):
#   read-write-admin | read-only-admin | read-write-objects | read-only-objects
# "-objects" keys can be limited to specific buckets and cannot manage
# buckets. Permissions can't be changed after creation — changing
# `permission` replaces the key (new ID + secret).
# Ref: https://www.fastly.com/documentation/reference/api/services/resources/object-storage-access-keys/
# ---------------------------------------------------------------------------

# VCL service: SigV4-signs GETs for /images/* → read-only. Goes in the
# edge_cms_fos_creds private dictionary (populated post-apply).
resource "fastly_object_storage_access_keys" "fos_readonly" {
  description = "edge-cms images — read-only, VCL image delivery"
  permission  = "read-only-objects"
  buckets     = [var.fos_bucket]
}

# Compute service: admin image uploads → read/write objects, no bucket admin.
# Goes in the Secret Store as fos_access_key_id / fos_secret_key.
resource "fastly_object_storage_access_keys" "fos_readwrite" {
  description = "edge-cms images — read-write objects, Compute uploads"
  permission  = "read-write-objects"
  buckets     = [var.fos_bucket]
}

# The bucket itself is created manually, once, with a short-lived
# read-write-admin key that is deleted straight afterwards (neither key above
# may create buckets, and the AWS provider can't use credentials that don't
# exist at plan time). See the "Object Storage bucket" step in next_steps.
