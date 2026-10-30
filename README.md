# Edge CMS: A CMS Running Entirely on Fastly

A fully-functional content management system that runs entirely at the edge — no origin servers, no databases, no traditional infrastructure. Every request is handled by Fastly Compute, with content stored in KV Store and images in Fastly Object Storage.

Edge CMS demonstrates how Fastly's product suite composes into a real, deployable application. It ships with a reader-facing blog, an admin interface with a split-pane markdown editor, image uploads, RSS feeds, sitemaps, and cache management — all running on Fastly's global edge network.

## Fastly Products Used

| Product | Purpose |
|---------|---------|
| **Compute** | Application runtime — all request logic runs at the edge (Rust WASM; TypeScript and Go parity backends exist) |
| **KV Store** | Post content, post index, sidebar configuration, revisions, soft-deleted posts, revoked sessions |
| **Config Store** | `site_url`, cache TTLs and `page_size` — change live without redeploying |
| **Object Storage** | Image uploads, served to readers by the VCL service (SigV4-signed, read-only key) |
| **Secret Store** | Admin password (bcrypt hash), session HMAC key, origin auth token, Fastly API token, Object Storage read-write key |
| **VCL CDN Service** | Public layer — forces TLS, sends HSTS, caches reader responses, serves images, injects the origin auth header, coarse login rate limit |
| **Edge Rate Limiting** | Login brute-force protection: precise limit in Compute, coarse flood limit in VCL |
| **Image Optimizer** | On-the-fly image resizing and WebP conversion via query params |
| **Surrogate Keys + Purge API** | Targeted cache invalidation when content changes |
| **Real-time Log Streaming** | Optional HTTPS log drain (truncated client IPs, no query strings) |

## Architecture

```
Browser
  │  HTTPS only (HTTP → 301, HSTS)
  ▼
┌──────────────────────────────────────────┐
│  VCL CDN Service  (edge-cms)             │
│  • Force TLS + HSTS                      │
│  • Coarse ERL on POST /admin/login       │
│  • Caches reader responses               │
│  • Serves /images/* from Object Storage  │
│  • Injects Edge-CMS-Origin-Auth header   │
└──────────┬───────────────────────────────┘
           │ non-image requests (+ origin auth header)
           ▼
┌──────────────────────────────────────────┐
│  Compute Service  (edge-cms-app-rust)    │
│  • Rejects requests without the header   │
│  • Routing, templating, auth, CSRF       │
│  • Security headers + CSP on every reply │
│  • ERL login limit (5/min/IP)            │
│  • KV / Secret Store / Config Store      │
│  • Purges VCL cache, uploads to FOS      │
└──────────────────────────────────────────┘
```

**Two services, two domains:**

| Service | Domain | Role |
|---------|--------|------|
| VCL CDN | `your-domain.com` | Public-facing; TLS, caching, image serving, origin auth injection |
| Compute | `app.your-domain.com` | Origin for the VCL service; refuses anything that did not come through it |

`app.your-domain.com` is publicly resolvable, but Compute returns `403` to any request that lacks a valid `Edge-CMS-Origin-Auth` header, so it cannot be used to bypass the CDN layer.

### Request path and the controls on it

1. **VCL, first hop:** plain HTTP gets a `301` to HTTPS; every response carries `Strict-Transport-Security: max-age=31536000; includeSubDomains`. `Fastly-Client-IP` is overwritten with the real client IP and any client-supplied `Edge-CMS-Origin-Auth` is stripped.
2. **VCL → Compute:** on every backend request to Compute (`vcl_miss` and `vcl_pass`), VCL sets `Edge-CMS-Origin-Auth` from the private dictionary `edge_cms_private` (key `origin_auth_token`). Never for `/images/*`.
3. **Compute, first thing:** compares the header (constant time) with Secret Store entry `origin_auth_token`. Missing secret, missing header or mismatch: `403`.
4. **Compute, every response:** CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`. `/admin` also gets `X-Robots-Tag: noindex, nofollow`. Templates therefore have no inline script, style or `on*=` handlers.
5. **CSRF (all non-GET/HEAD `/admin` requests, including login):** `Sec-Fetch-Site` if present must be `same-origin` (or `none`); otherwise `Origin` must equal `site_url`; otherwise `403`.
6. **Login limit:** Compute ERL allows 5 `POST /admin/login` per 60 s per client IP, then a 15-minute penalty box (`429`, `Retry-After: 900`). VCL adds a coarse limit at the minimum the VCL limiter supports (10 rps averaged over 60 s) that only stops floods.
7. **Sessions:** `v1.<expires>.<nonce>.<sig>` tokens (HMAC-SHA256, 1 h), cookie `HttpOnly; Secure; SameSite=Strict; Path=/admin`. Logout writes `session-revoked:<nonce>` to KV, so a stolen token stops working immediately. Pre-v1 tokens are rejected.
8. **Input validation (identical in all backends):** slug, title, excerpt, content (512 KiB), tags, status, bodies (1 MiB), sidebar JSON (64 KiB, 50 items, URL scheme allowlist).
9. **Markdown** is rendered, then sanitized with an allowlist (Rust `ammonia`, TypeScript `xss`, Go `bluemonday`). `<script>`, event handlers and `javascript:`/`data:` URLs are removed; `<iframe>` survives only for `youtube-nocookie.com`, `youtube.com` and `player.vimeo.com`.
10. **Uploads:** `POST /admin/images`, max 10 MiB, filename `^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|jpeg|png|webp|gif)$`, type detected from magic bytes and must match the extension; that detected type is what is stored. SVG and everything else: `415`.
11. **Images out:** VCL serves only `/images/<slug>/<file>.(jpg|jpeg|png|webp|gif)`, forces `Content-Type` from the extension, and adds `nosniff` plus `Content-Security-Policy: default-src 'none'; sandbox`. Compute returns `404` for `/images/*`.

Fonts (Fraunces, DM Sans, JetBrains Mono) are self-hosted from `/assets/fonts/`; the site makes no third-party requests.

---

## Security model

**Controls** — see the request path above, plus: least-privilege Object Storage keys (read-only for VCL, read-write-objects for Compute, neither can manage buckets); content KV store protected by `prevent_destroy`/`force_destroy = false`; secrets never on a command line (`--stdin`, `read -rs`) or in Terraform state except the generated origin auth token and Object Storage keys (see the state warning below); explicit DNS records instead of a wildcard CNAME; CI dependency audit, secret scanning and SHA-pinned actions.

**Residual risks — know these before you rely on it:**

- **Single shared admin password, no MFA.** There are no per-user accounts. Use a long random password; the ERL limit and bcrypt slow guessing but do not replace a second factor. Consider NGWAF or an IP allowlist in front of `/admin` for anything sensitive.
- **ERL fails open in Compute.** If the ERL host calls themselves error, the login limit is skipped (and logged); only the coarse VCL limit remains.
- **KV eventual consistency vs purge.** Compute purges after writing KV, but a read in a POP that has not yet seen the new KV value can re-cache stale content after the purge. Pages use `stale-while-revalidate=60`; a repeat edit or a second purge fixes it. Session revocation is also KV-based, so a revoked session may remain valid briefly in other POPs.
- **VCL → Compute shielding.** The auth header is set in `vcl_miss`/`vcl_pass`, which also run on the shield node, and the first-hop snippet strips any inbound copy. This design relies on Fastly's generated VCL ordering; verify it in the generated VCL (Fastly UI → Show VCL) and with the smoke tests below after every VCL change.
- **HSTS `includeSubDomains`.** Once a browser has seen the header it will refuse plain HTTP for every subdomain of `var.domain`. If `var.domain` is a zone apex this covers the whole domain, so every other subdomain must serve valid HTTPS. There is no `preload`. Removing it later only takes effect as the one-year max-age expires per browser.
- **Terraform state holds secrets** (origin auth token, Object Storage keys, logging token). Use an encrypted remote backend (commented examples in `terraform/providers.tf`) and restrict access.
- **Rotation:** `terraform apply -replace=random_password.origin_auth_token`, then rewrite the dictionary item first and the secret second (brief `403`s for requests in flight between the two writes).

---

## Prerequisites

- **Fastly account** with Compute, Object Storage and Edge Rate Limiting available
- **Fastly CLI** installed and authenticated:
  ```bash
  brew install fastly/tap/fastly   # macOS
  fastly profile create
  ```
- **Rust toolchain** with the WASM target:
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  rustup target add wasm32-wasip1
  ```
- **Terraform** >= 1.5
- **jq** (post-apply steps feed JSON to the CLI)
- **Python + bcrypt** (to hash your admin password): `pip install bcrypt`
- **AWS CLI** (one-off, to create the Object Storage bucket): `brew install awscli`
- **A domain you control** with access to create CNAME records

> **Why Terraform only?** The VCL service is about twenty snippets, three dictionaries and several settings that must stay consistent with the Compute code (origin auth, force-TLS, rate limiting, image hardening). `terraform/vcl.tf` is the single source of truth; a hand-built CLI equivalent is no longer maintained. The Compute app alone can still be deployed with `fastly compute deploy` for experiments, but it will answer `403` to everything without the VCL service in front of it.

---

## Installation: new deployment

All commands run from the repo root unless noted.

### Step 1 — Build the Compute package

```bash
cd rust/
fastly compute build        # produces rust/pkg/edge-cms.tar.gz
cd ..
```

### Step 2 — Configure Terraform

```bash
cd terraform/
cp terraform.tfvars.example terraform.tfvars
export FASTLY_API_KEY=<your-fastly-api-token>   # provider auth; not a Terraform variable
```

Edit `terraform.tfvars` (gitignored — never commit it):

```hcl
domain               = "your-domain.com"
compute_package_path = "../rust/pkg/edge-cms.tar.gz"
fos_region           = "us-east-1"
fos_bucket           = "edge-cms-images"
shield_pop           = "iad-va-us"

# Optional: HTTPS log drain (Compute app; VCL too if enable_vcl_logging = true)
# logging_endpoint_url = "https://your-log-drain.example.com/logs"
# logging_token        = "your-logging-auth-token"
# enable_vcl_logging   = true
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `domain` | Yes | — | Public domain (e.g. `edge-cms.example.com`) |
| `compute_package_path` | No | `../rust/pkg/edge-cms.tar.gz` | Built Rust Compute package |
| `fos_region` | No | `us-east-1` | Object Storage region |
| `fos_bucket` | No | `edge-cms-images` | Object Storage bucket name |
| `shield_pop` | No | `iad-va-us` | Shield POP for the Compute and Object Storage backends |
| `go_backend_host` | No | `""` | Hostname of a Go Compute service; empty = no Go backend on the VCL service |
| `ts_backend_host` | No | `""` | Hostname of a TypeScript Compute service; empty = no TS backend |
| `logging_endpoint_url` | No | `""` | HTTPS log drain URL; empty disables logging |
| `enable_vcl_logging` | No | `false` | Also log VCL requests (truncated IP, path only) |
| `logging_token` | No | `""` | Bearer token for the log drain (sensitive) |

`terraform.tfstate` contains secrets (the generated origin auth token and Object Storage keys). Configure an encrypted remote backend before you apply (see `terraform/providers.tf`).

### Step 3 — Apply

```bash
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Terraform creates the VCL service (snippets, dictionaries `edge_cms_fos_creds`, `edge_cms_private`, `edge_cms_config`, compression, Image Optimizer), the Compute service, the content KV store (`edge-cms-content`, delete-protected), the Config Store (`edge-cms-cache-config`: `site_url`, `page_ttl`, `asset_ttl`, `image_ttl`, `page_size`), an empty Secret Store (`edge-cms-secrets`), the generated origin auth token, and two Object Storage access keys.

> If activation of the VCL service fails on `ratecounter`/`penaltybox`, Edge Rate Limiting is not enabled for the service yet. Enable it (Step 4) and re-run `terraform apply`.

The Compute service now answers `403` to everything until the origin auth token is in place (Step 5). Nothing is live yet on a new deployment, so this is expected.

```bash
terraform output next_steps     # the checklist below with your IDs filled in
```

### Step 4 — Enable Edge Rate Limiting on the VCL service

The VCL login limiter (`ratecounter`/`penaltybox`) requires the product on the service.

```bash
fastly products --service-id=$(terraform output -raw vcl_service_id)    # list products and status
# enable the Edge Rate Limiting entry: Fastly UI, or `fastly products --enable=<id> --service-id=...`
```

The Compute app also uses ERL (`login_attempts`, `login_penalty`). `terraform/outputs.tf` only documents enabling the product on the VCL service; if login rate limiting misbehaves, check the Compute logs for `erl ... failed` warnings (the app fails open and logs them).

### Step 5 — Populate the Secret Store

Secret values never go on a command line or through `echo`: they are piped from `terraform output` or a generator, or typed into `read -rs`. Commands match `terraform output next_steps`.

```bash
export SSID=$(terraform output -raw secret_store_id)

# Origin auth token (Terraform-generated)
terraform output -raw origin_auth_token \
  | fastly secret-store-entry create --store-id=$SSID --name=origin_auth_token --stdin --recreate-allow

# Admin password — bcrypt hash; password read from the TTY
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

# Non-secret settings (Compute reads them from the Secret Store)
terraform output -raw vcl_service_id \
  | fastly secret-store-entry create --store-id=$SSID --name=purge_service_id --stdin --recreate-allow
printf '%s' "us-east-1"       | fastly secret-store-entry create --store-id=$SSID --name=fos_region --stdin --recreate-allow
printf '%s' "edge-cms-images" | fastly secret-store-entry create --store-id=$SSID --name=fos_bucket --stdin --recreate-allow
```

`fos_region` and `fos_bucket` must match `terraform.tfvars`.

| Key | Description | Source |
|-----|-------------|--------|
| `origin_auth_token` | Shared secret VCL → Compute (must equal the `edge_cms_private` item) | `terraform output -raw origin_auth_token` |
| `admin_password` | bcrypt hash of the admin password | Python `bcrypt` |
| `hmac_key` | Session token signing key | `openssl rand -base64 32` |
| `fastly_api_token` | Token with purge scope on the VCL service | Fastly account → API tokens |
| `purge_service_id` | VCL CDN service ID | `terraform output vcl_service_id` |
| `fos_access_key_id` | Object Storage **read-write** key ID | `terraform output fos_readwrite_access_key_id` |
| `fos_secret_key` | Object Storage **read-write** secret | `terraform output fos_readwrite_secret_key` |
| `fos_region` | Object Storage region | e.g. `us-east-1` |
| `fos_bucket` | Object Storage bucket name | e.g. `edge-cms-images` |

> **Why not Terraform for these?** The provider has no Secret Store entry resource, and values in Terraform state are readable by anyone with state access.

### Step 6 — Populate the private VCL dictionaries

Terraform cannot manage items in private (write-only) dictionaries. `dictionary-entry update --file` takes a batch JSON file; process substitution keeps the values off the command line.

```bash
export VCL_SID=$(terraform output -raw vcl_service_id)

# edge_cms_private — origin auth token (same value as the secret above)
fastly service dictionary-entry update --service-id=$VCL_SID \
  --dictionary-id="$(terraform output -raw private_dict_id)" \
  --file=<(terraform output -raw origin_auth_token \
    | jq -Rs '{items: [{op: "upsert", item_key: "origin_auth_token", item_value: .}]}')

# edge_cms_fos_creds — Object Storage READ-ONLY key (SigV4 signing in VCL)
fastly service dictionary-entry update --service-id=$VCL_SID \
  --dictionary-id="$(terraform output -raw fos_dict_id)" \
  --file=<(jq -n --arg id "$(terraform output -raw fos_readonly_access_key_id)" \
                 --rawfile sk <(terraform output -raw fos_readonly_secret_key) \
    '{items: [{op: "upsert", item_key: "access_key_id", item_value: $id},
              {op: "upsert", item_key: "secret_key",    item_value: $sk}]}')
```

### Step 7 — Create the Object Storage bucket (once)

Neither Terraform-managed key can create buckets, so mint a temporary admin key and delete it straight afterwards:

```bash
fastly object-storage access-keys create --description="edge-cms bucket bootstrap (delete me)" \
  --permission=read-write-admin
IFS= read -r  AWS_ACCESS_KEY_ID;     export AWS_ACCESS_KEY_ID      # paste the key ID
IFS= read -rs AWS_SECRET_ACCESS_KEY; export AWS_SECRET_ACCESS_KEY  # paste the secret (hidden)
aws s3 mb s3://edge-cms-images \
  --endpoint-url https://us-east-1.object.fastlystorage.app \
  --region us-east-1
fastly object-storage access-keys delete --ak-id="$AWS_ACCESS_KEY_ID"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

Use your own bucket name and region from `terraform.tfvars`.

### Step 8 — Seed the KV store

```bash
KVID=$(terraform output -raw content_kv_store_id)
fastly kv-store-entry create --store-id=$KVID --key=_index   --value='{"posts":[]}'
fastly kv-store-entry create --store-id=$KVID --key=_sidebar --value='{"items":[]}'
```

### Step 9 — DNS and TLS

DNS uses explicit records — no wildcard CNAME. Print the exact list:

```bash
terraform output dns_routing_records
```

| Name | Type | Value |
|------|------|-------|
| `your-domain.com` | CNAME | `j.sni.global.fastly.net` |
| `app.your-domain.com` | CNAME | `j.sni.global.fastly.net` |
| plus `go_backend_host` / `ts_backend_host`, if set | CNAME | `j.sni.global.fastly.net` |

A CNAME is not allowed at a zone apex: use your provider's ALIAS/ANAME or Fastly's documented apex A records.

TLS: one wildcard Let's Encrypt subscription covers the domain and `*.your-domain.com` (the wildcard is only on the certificate). The automation account may lack TLS permissions, so run this with your main account token:

```bash
terraform output tls_provisioning_commands     # prints the commands; run them with the main account token
fastly tls-subscription list                   # shows the _acme-challenge CNAMEs to add
```

Certificates issue within a few minutes of the validation records resolving.

### Step 10 — Smoke test and first login

```bash
curl -sI  https://your-domain.com/            # 200, strict-transport-security, content-security-policy
curl -sI  http://your-domain.com/             # 301 to https://
curl -s -o /dev/null -w '%{http_code}\n' https://app.your-domain.com/   # 403 (no origin auth header)
```

Then visit `https://your-domain.com/admin/login` and sign in with the admin password from Step 5.

---

## Upgrading an existing deployment

For a deployment that predates the security hardening (single Object Storage admin key, managed rate limiter, no origin auth). **Run it in this order.** It is designed so that no step makes the live site return `403`.

Why the order matters: the new Compute package returns `403` to any request without a valid `Edge-CMS-Origin-Auth` header, so the token must be in the Secret Store **and** in the VCL dictionary before the new Compute package goes live. The old Compute package ignores the header, so the new VCL service can safely go live first. The `edge_cms_private` dictionary only exists once the new VCL version is applied, which is why the apply is split in two.

Rolling out Compute before the secrets are written takes the whole site (public and admin) to `403` until they are; rolling it out with the secret written but the dictionary empty has the same effect, because VCL then sends no token.

All Terraform commands run in `terraform/` with `FASTLY_API_KEY` exported. Do not paste secrets into the shell history; use the `terraform output -raw … |` patterns below.

**0. Back up content** (see [Backup and restore](#backup-and-restore)):

```bash
FASTLY_KV_STORE_ID=$(terraform output -raw content_kv_store_id) \
FASTLY_API_TOKEN=$FASTLY_API_KEY ../scripts/kv-backup.sh
```

Note the currently active service versions for rollback:

```bash
fastly service-version list --service-id=$(terraform output -raw vcl_service_id)
fastly service-version list --service-id=$(terraform output -raw compute_service_id)
```

**1. Build the Rust package** (`../rust/pkg/edge-cms.tar.gz`):

```bash
(cd ../rust && fastly compute build)
```

**2. Initialise Terraform** (adds the `hashicorp/random` provider from the committed lock file):

```bash
terraform init
```

**3. Create the new keys and token only:**

```bash
terraform apply \
  -target=fastly_object_storage_access_keys.fos_readonly \
  -target=fastly_object_storage_access_keys.fos_readwrite \
  -target=random_password.origin_auth_token
```

Sanity-check that the token is readable without printing it: `terraform output -raw origin_auth_token | wc -c` must print `48`. (The old `fastly_object_storage_access_keys.fos` admin key is untouched until step 8.)

**4. Write the Compute-side secrets** (old Compute ignores them; the old code simply starts uploading with the new read-write key):

```bash
SSID=$(terraform output -raw secret_store_id)
terraform output -raw origin_auth_token \
  | fastly secret-store-entry create --store-id=$SSID --name=origin_auth_token --stdin --recreate-allow
terraform output -raw fos_readwrite_access_key_id \
  | fastly secret-store-entry create --store-id=$SSID --name=fos_access_key_id --stdin --recreate-allow
terraform output -raw fos_readwrite_secret_key \
  | fastly secret-store-entry create --store-id=$SSID --name=fos_secret_key --stdin --recreate-allow
```

**5. Enable Edge Rate Limiting on the VCL service** (the new VCL declares a `ratecounter` and `penaltybox` and will not activate without it):

```bash
VCL_SID=$(terraform output -raw vcl_service_id)
fastly products --service-id=$VCL_SID    # find the Edge Rate Limiting entry, then enable it
# fastly products --enable=<id> --service-id=$VCL_SID    (or use the Fastly UI)
```

**6. Review and apply the VCL service only.** This creates the `edge_cms_private` dictionary and activates the hardened VCL (force-TLS, HSTS, image hardening). It sends an empty origin auth header for now, which the old Compute ignores.

```bash
terraform plan -target=fastly_service_vcl.cdn -target=fastly_service_dictionary_items.config
terraform apply -target=fastly_service_vcl.cdn -target=fastly_service_dictionary_items.config
```

Expect: `edge_cms_rate_limit_uris` dictionary and the old `rate_limiter` removed; new `edge_cms_private` dictionary and the new snippets added; Go/TS VCL backends removed unless `go_backend_host`/`ts_backend_host` are set.

**7. Write the VCL dictionaries** (same commands as new-deployment Step 6):

```bash
fastly service dictionary-entry update --service-id=$VCL_SID \
  --dictionary-id="$(terraform output -raw private_dict_id)" \
  --file=<(terraform output -raw origin_auth_token \
    | jq -Rs '{items: [{op: "upsert", item_key: "origin_auth_token", item_value: .}]}')

fastly service dictionary-entry update --service-id=$VCL_SID \
  --dictionary-id="$(terraform output -raw fos_dict_id)" \
  --file=<(jq -n --arg id "$(terraform output -raw fos_readonly_access_key_id)" \
                 --rawfile sk <(terraform output -raw fos_readonly_secret_key) \
    '{items: [{op: "upsert", item_key: "access_key_id", item_value: $id},
              {op: "upsert", item_key: "secret_key",    item_value: $sk}]}')
```

Images now flow through the read-only key. Quick check: an existing `https://your-domain.com/images/<slug>/<file>` still returns `200`.

**8. Full plan — read it before applying:**

```bash
terraform plan -out=tfplan
```

Expected: the old `fastly_object_storage_access_keys.fos` admin key **destroyed**; the Compute service updated in place with the new package; Config Store entries updated in place (`page_ttl` 2592000 → 86400, plus new `site_url` and `page_size`). Any remaining Go/TS backend or rate-limiter removals that step 6 did not already cover. **There must be no replacement (`-/+`) of the content KV store, Secret Store, Config Store or dictionaries.** If you see one, stop.

```bash
terraform apply tfplan
```

This deploys the new Compute package, which starts enforcing origin auth. Existing admin sessions become invalid (the new `v1` tokens are required); everyone logs in again.

If you run Go or TypeScript Compute services (managed outside Terraform), rebuild and redeploy them with their security-fixed packages too; they read the same Secret Store, so no extra secrets are needed.

**9. Smoke tests:**

```bash
curl -sI  https://your-domain.com/            # 200 + strict-transport-security + content-security-policy
curl -sI  http://your-domain.com/             # 301 to https
curl -s -o /dev/null -w '%{http_code}\n' https://app.your-domain.com/   # 403: direct access refused
```

Then log in at `https://your-domain.com/admin/login`, create and delete a draft post, and upload a small image.

**10. Rollback.** Activate the previous version of both services (the version numbers noted in step 0):

```bash
fastly service-version activate --version=<prev-vcl>     --service-id=<vcl-service-id>
fastly service-version activate --version=<prev-compute> --service-id=<compute-service-id>
```

The KV store is not versioned and is never modified by this runbook (new `rev:`/`trash:`/`session-revoked:` keys are ignored by old code). Config Store and dictionary item values are also unversioned; old code tolerates the new values. Old Compute needs a working Object Storage key: if step 8 already destroyed the old admin key, uploads keep working with the new read-write key written in step 4. After a rollback, Terraform state no longer matches the active versions; re-run `terraform plan` before the next apply. If you still hold a KV backup from step 0 and content looks wrong, see `scripts/kv-restore.sh`.

---

## Backup and restore

`scripts/kv-backup.sh` exports every key of the content KV store (including `rev:` and `trash:` keys) to a timestamped JSON-lines file (`{"key","value"}` with base64 values); `scripts/kv-restore.sh` replays it.

```bash
cp scripts/.env.example scripts/.env     # then fill in; scripts/.env is gitignored
#   FASTLY_API_TOKEN=...
#   FASTLY_KV_STORE_ID=...               # terraform output -raw content_kv_store_id

scripts/kv-backup.sh                      # writes ./kv-backups/kv-backup-<store>-<UTC timestamp>.jsonl (mode 600)
scripts/kv-backup.sh /path/to/dir         # different output directory

scripts/kv-restore.sh kv-backups/kv-backup-<store>-<ts>.jsonl   # asks you to type the store id to confirm
scripts/kv-restore.sh --yes <file>                              # non-interactive
```

Needs the `fastly` CLI and `jq`. Restore **overwrites** keys with the same name and leaves keys that are not in the backup alone. Backups contain all post content: `kv-backups/` is gitignored; keep them out of the repo and treat them as sensitive. Backups do not include the Secret Store, Config Store or dictionaries (those are rebuilt from Terraform and the post-apply steps).

---

## Sensitive Files Reference

| File | Tracked | Purpose |
|------|---------|---------|
| `rust/.env.example`, `scripts/.env.example` | Yes | Templates — copy to `.env` |
| `rust/.env`, `scripts/.env` | **No** (gitignored) | API token, service and store IDs |
| `terraform/terraform.tfvars.example` | Yes | Template — copy to `terraform.tfvars` |
| `terraform/terraform.tfvars` | **No** (gitignored) | Deployment config (and log token if set) |
| `terraform/terraform.tfstate` | **No** (gitignored) | **Contains secrets**: origin auth token, Object Storage keys. Use an encrypted remote backend |
| `terraform/.terraform.lock.hcl` | Yes | Provider version/hash lock |
| `*/tests/secrets.json` | Yes | **Test-only** admin bcrypt hash, HMAC key and origin auth token — not real credentials |
| `.secrets.baseline` | Yes | detect-secrets baseline; the test fixtures above are allowed through it |

`tests/secrets.json` exists for local development and the integration suite only. The bcrypt hash is for the password `admin`, the HMAC key is a fixed string and `origin_auth_token` is `local-dev-origin-auth`. They are safe to commit because deployed environments always use the Secret Store.

---

## Local Development

Run locally with Viceroy (Fastly's local Compute runtime). Each backend directory (`rust/`, `typescript/`, `go/`) has a `fastly.toml` that wires local KV, Config and Secret stores to fixture files under `tests/` — no Fastly account required.

```bash
cd rust/
fastly compute serve         # http://127.0.0.1:7676
```

**Every local request must carry `Edge-CMS-Origin-Auth: local-dev-origin-auth`.** In production the VCL service injects that header; Compute refuses (`403`) anything that did not come through it. Locally there is no VCL service, so you add it yourself. The value is the `origin_auth_token` in `tests/secrets.json`.

The admin password fixture is **`admin`**. Mutating `/admin` requests also need a same-origin signal for CSRF: `Origin: http://127.0.0.1:7676` (equal to `site_url` in `tests/cache-config.json`).

```bash
H='Edge-CMS-Origin-Auth: local-dev-origin-auth'
B=http://127.0.0.1:7676

curl -s -H "$H" $B/                              # reader home page: 200
curl -s -o /dev/null -w '%{http_code}\n' $B/     # no header: 403

# Log in (CSRF: Origin must equal site_url). The cookie is Secure, so pass it by hand over http.
curl -si -X POST $B/admin/login -H "$H" -H "Origin: $B" --data-urlencode 'password=admin' \
  | grep -i '^set-cookie'
# → set-cookie: session=v1....; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=3600

SESSION=<value after "session=" up to the first ;>
curl -s -H "$H" -H "Cookie: session=$SESSION" $B/admin           # dashboard: 200

# Mutating request, JSON API style
curl -s -X PUT $B/admin/sidebar -H "$H" -H "Origin: $B" -H "Cookie: session=$SESSION" \
  -H 'Content-Type: application/json' -d '{"items":[]}'
```

The login limit is 5 per 60 s per IP (Viceroy may stub ERL); don't hammer login in a loop.

| File | Contents |
|------|---------|
| `tests/kv-content.json` | Sample post, index, and sidebar config |
| `tests/cache-config.json` | `site_url` (`http://127.0.0.1:7676`), TTLs, `page_size` |
| `tests/secrets.json` | Test admin password hash (`admin`), HMAC key, origin auth token |

There is no local images store: `/images/*` is served by the VCL service from Object Storage, and Compute returns `404` for it.

### Tests

```bash
# Unit tests
(cd rust       && cargo test)
(cd go         && make test)                 # copies ../shared first
(cd typescript && npm ci && npm test -- --coverage)

# Integration suite, one backend at a time (build it first; starts Viceroy, runs the suite, stops it)
(cd rust && fastly compute build)       && scripts/run-integration.sh rust
(cd go && make build)                   && scripts/run-integration.sh go
(cd typescript && npm ci && fastly compute build) && scripts/run-integration.sh typescript
```

The same suite (`rust/tests/integration.sh`, encoding `docs/architecture/security-hardening-contract.md`) runs against all three backends. To run it by hand against a server you started, `rust/tests/integration.sh`; overrides are listed at the top of the script (`EDGE_CMS_BASE_URL`, `EDGE_CMS_ORIGIN_AUTH`, `EDGE_CMS_ADMIN_PASSWORD`). It makes at most 5 login requests per run; running it twice within 60 s against a backend with working ERL may hit the login limit.

---

## CI / GitHub Actions

`.github/workflows/edge-cms-ci.yml` runs on pull requests to, and pushes to, `main`. A `changes` job filters by path so each language only builds when it (or `shared/`) changed; `dependency-audit` and `detect-secrets` always run.

| Job | What it checks |
|-----|---------------|
| **Rust** | `cargo fmt --check`, `cargo clippy --target wasm32-wasip1 -D warnings`, `cargo test` |
| **Go** | `gofmt`, `make test`, `go vet` |
| **TypeScript** | `tsc --noEmit`, `jest --coverage` (coverage threshold in `jest.config.js`), `webpack` build |
| **Terraform** | `terraform fmt -check`, `terraform init -backend=false`, `terraform validate` |
| **VCL** | `scripts/extract-vcl.sh` pulls each inline snippet out of `terraform/vcl.tf`, wraps it in its subroutine, and `falco lint` checks it (falco pinned to a release and verified by SHA-256) |
| **Integration (Rust, Go, TypeScript)** | Builds each package, starts it under [Viceroy](https://github.com/fastly/Viceroy) via [`fastly/compute-actions/setup`](https://github.com/fastly/compute-actions), runs the shared integration suite with `scripts/run-integration.sh <backend>` |
| **Dependency audit** | `npm audit --omit=dev`, `govulncheck`, `cargo audit` — fails on known-vulnerable dependencies; Node jobs use `check-latest` |
| **Secrets** | `detect-secrets-hook` against `.secrets.baseline` — fails the build on any new secret |

Every third-party action is pinned to a full commit SHA (tag noted in a comment), and Dependabot (`.github/dependabot.yml`) proposes weekly bumps for Actions, npm, cargo and Go modules. Stale CI runs on the same branch are cancelled.

Pre-commit hooks (`.pre-commit-config.yaml`) mirror the fast checks: secret detection, forbidden `.env` files and service-version strings, `terraform fmt`, VCL lint, rustfmt/clippy, gofmt/vet, `tsc`, shellcheck.

---

## Data Model

| Store | Type | Key | Value |
|-------|------|-----|-------|
| `content` | KV | `_index` | Post metadata for listing pages (rebuildable) |
| `content` | KV | `_sidebar` | Sidebar config (categories and links) |
| `content` | KV | `post:<slug>` | Full post JSON |
| `content` | KV | `rev:<slug>:<unix_ts>` | Previous version of a post, written before each update (30-day TTL) |
| `content` | KV | `trash:<slug>` | Soft-deleted post, written before delete (30-day TTL) |
| `content` | KV | `session-revoked:<nonce>` | Revoked session, TTL to the session's expiry |
| — | Object Storage bucket | `<slug>/<filename>` | Image bytes (written by Compute, served by VCL) |
| `cache_config` | Config Store | `site_url`, `page_ttl`, `asset_ttl`, `image_ttl`, `page_size` | Site URL (CSRF and canonical URLs), TTLs in seconds, posts per page |
| `edge_cms_config` | Edge Dictionary | `active_backend`, `image_ttl` | Backend selector + VCL image cache TTL |
| `edge_cms_private` | Private Dictionary | `origin_auth_token` | Token the VCL service sends to Compute |
| `edge_cms_fos_creds` | Private Dictionary | `access_key_id`, `secret_key` | Object Storage read-only key for VCL SigV4 |
| `secrets` | Secret Store | 9 keys | See the secrets table above |

**Admin operations that touch this data:** `POST /admin/rebuild-index` rebuilds `_index` from the `post:` keys (use it if the index ever drifts), then purges `post-index`. There is no restore UI for `rev:`/`trash:` entries; recover them with the `fastly kv-store-entry` CLI. If a purge call fails, the admin redirect carries `?purge=failed` and the dashboard shows a warning banner: retry the save, or purge from the Fastly UI.

---

## Caching Strategy

TTLs are configurable at runtime — no code deploy. Compute reads a **Config Store** (`cache_config`); VCL image caching reads the **`edge_cms_config` Edge Dictionary**. Both are managed by Terraform, so live edits are reverted by the next `terraform apply` unless you also change the Terraform value.

### TTL Tiers

| Content | Edge TTL | Browser | Source | Surrogate Keys |
|---------|----------|---------|--------|----------------|
| **Pages** (home, post, tag) | 1 day (`86400`) + `stale-while-revalidate=60`, `stale-if-error=86400` | `public, no-cache` (always revalidates; VCL rewrites it) | Config Store: `page_ttl` | `post-index`, `post-<slug>`, `tag-<tag>`, `sidebar` |
| **feed.xml, sitemap.xml, robots.txt** | same as pages | `public, max-age=300` | `page_ttl` | `post-index` |
| **CSS/JS/fonts** | 1 year (`31536000`) | `public, max-age=31536000, immutable` (URLs carry `?v=<service version>`) | Config Store: `asset_ttl` | `assets` |
| **Images** (VCL → Object Storage) | 1 year (`31536000`) | `public, max-age=86400` | Edge Dictionary: `image_ttl` | `images`, `image-<slug>` |
| **Errors and admin** | none | `private, no-store` | — | — |

Admin routes also get `return(pass)` in VCL. `stale-if-error` lets the edge keep serving a cached page for a day if Compute or the KV store is failing.

### Changing TTLs Live

```bash
# Pages — takes effect on the next cache miss (purge for immediate effect)
fastly config-store-entry update \
  --store-id=<cache-config-store-id> --key=page_ttl --value=3600

# Images — Edge Dictionary
fastly service dictionary-entry update \
  --service-id=<vcl-service-id> \
  --dictionary-id=<edge_cms_config-dict-id> \
  --key=image_ttl --value=86400
```

### Purging

On any admin write Compute calls the Fastly Purge API (`Surrogate-Key`, soft purge) with only the affected keys: create or delete `post-index post-<slug> sidebar` plus each `tag-<t>`; update adds the old slug and tags; sidebar save `sidebar post-index`; upload `image-<slug>`. A non-2xx purge response is logged and surfaces as the dashboard banner described above.

### Compression

The VCL service applies brotli (gzip fallback) to text responses: HTML, CSS, JS, JSON, XML, SVG. Images are excluded.

---

## Directory Structure

```
.
├── README.md
├── DESIGN.md              # Design document
├── docs/architecture/     # security-hardening-contract.md — interface contract for all backends
├── .github/               # CI workflow, Dependabot
├── .hooks/, .pre-commit-config.yaml, .secrets.baseline
├── scripts/               # kv-backup/kv-restore, run-integration, extract-vcl/lint-vcl
├── shared/                # Shared across all backends
│   ├── templates/         # Handlebars templates (.hbs)
│   ├── css/               # style.css (reader), admin.css (admin + login)
│   ├── js/                # site.js (public), admin.js
│   ├── fonts/             # Self-hosted woff2 (OFL)
│   └── test-fixtures/
├── rust/                  # Primary implementation
│   ├── src/
│   ├── tests/             # Fixtures + shared integration.sh
│   └── fastly.toml
├── typescript/            # Parity backend (security fixes only)
├── go/                    # Parity backend (security fixes only)
└── terraform/             # VCL service, Compute service, stores, keys, outputs
```

---

## Available Implementations

| Language | Status | Notes |
|----------|--------|-------|
| **Rust** | Primary | Reference implementation. New features land here first; Terraform deploys it. |
| TypeScript | Implemented, frozen | Parity backend (`@fastly/js-compute`). Receives security and data-integrity fixes only. |
| Go | Implemented, frozen | Parity backend (`compute-sdk-go`). Receives security and data-integrity fixes only. |

All implementations share the templates and assets in `shared/` and are held to the same behavior by the shared integration suite and the hardening contract. Go and TypeScript services are not managed by Terraform: deploy them with the CLI, set `go_backend_host` / `ts_backend_host` so the VCL service gets a backend (and DNS record) for them, and switch with the `active_backend` item in `edge_cms_config` (`rust`, `go` or `ts`; an unconfigured choice falls back to Rust). `active_backend` is managed by Terraform, so a manual change is reverted at the next apply.
