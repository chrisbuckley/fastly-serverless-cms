# Edge CMS: A CMS Running Entirely on Fastly

A fully-functional content management system that runs entirely at the edge — no origin servers, no databases, no traditional infrastructure. Every request is handled by Fastly Compute, with content stored in KV Store and images in Object Store.

Edge CMS demonstrates how Fastly's product suite composes into a real, deployable application. It ships with a reader-facing blog, an admin interface with a split-pane markdown editor, image uploads, RSS feeds, sitemaps, and cache management — all running on Fastly's global edge network.

## Fastly Products Used

| Product | Purpose |
|---------|---------|
| **Compute** | Application runtime — all request logic runs at the edge in a Rust WASM binary |
| **KV Store** | Post content, post index, and sidebar configuration |
| **Config Store** | Cache TTL configuration — change page/asset/image TTLs live without redeploying |
| **Object Store** | Image uploads (binary blobs), served via FOS |
| **Secret Store** | Admin password (bcrypt hash), session HMAC key, FOS credentials, Fastly API token |
| **VCL CDN Service** | Public CDN layer — caches reader responses, serves images directly from FOS, rate-limits login |
| **Image Optimizer** | On-the-fly image resizing and WebP conversion via query params |
| **Surrogate Keys + Purge API** | Targeted cache invalidation when posts are created, updated, or deleted |
| **Rate Limiting** | Brute-force protection on `POST /admin/login` |
| **Geolocation** | Nearest POP name and code for reader-facing footer badge |
| **Real-time Log Streaming** | Optional HTTPS log drain for request telemetry |

## Architecture

```
Browser
  │
  ▼
┌─────────────────────────────────────┐
│  VCL CDN Service  (edge-cms)        │
│  • Caches reader responses          │
│  • Serves /images/* from FOS        │
│  • Rate-limits POST /admin/login    │
│  • Enables Image Optimizer          │
└──────────┬──────────────────────────┘
           │ non-image requests
           ▼
┌─────────────────────────────────────┐
│  Compute Service  (edge-cms-app)    │
│  • Routing, templating, auth        │
│  • Reads/writes KV Store            │
│  • Reads secrets from Secret Store  │
│  • Reads TTLs from Config Store     │
│  • Purges VCL cache on writes       │
│  • Writes images to FOS             │
└──────────────────────────────────────┘
```

**Two services, two domains:**

| Service | Domain | Role |
|---------|--------|------|
| VCL CDN | `your-domain.com` | Public-facing; handles caching, image serving, rate limiting |
| Compute | `app.your-domain.com` | Internal; VCL uses this as its backend |

DNS for both points to `j.sni.global.fastly.net`. Only the VCL service domain is public-facing — the `app.*` subdomain is the Compute service acting as an internal origin.

---

## Prerequisites

- **Fastly account** with Compute enabled
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
- **Python + bcrypt** (to hash your admin password):
  ```bash
  pip install bcrypt
  ```
- **AWS CLI** (to create the Object Storage bucket):
  ```bash
  brew install awscli   # macOS
  ```
- **A domain you control** with access to create CNAME records
- **For Terraform path:** Terraform >= 1.5

---

## Installation: Fastly CLI

This path creates every resource using the Fastly CLI. The VCL CDN service has several moving parts (snippets, dictionaries, rate limiter) — if you prefer infrastructure-as-code, use the Terraform path instead.

### Step 1 — Build the Compute package

```bash
cd edge-cms/rust/
fastly compute build
```

This produces `rust/pkg/edge-cms.tar.gz`.

### Step 2 — Create the KV Stores

```bash
# Post content, index, sidebar config
fastly kv-store create --name=edge-cms-content

# Note the store ID from the output — you'll need it later
# Example output: SUCCESS Created KV store 'edge-cms-content' (id: abc123...)
```

The local `fastly.toml` also references an `images` KV store for local development.
In production, images go to Fastly Object Storage — the VCL service intercepts `/images/*`
before it reaches Compute. The `images` KV store is not needed in production.

### Step 3 — Create the Secret Store

```bash
fastly secret-store create --name=edge-cms-secrets

# Note the store ID from the output
```

### Step 4 — Create Object Storage credentials and bucket

Create an access key pair with read-write access to your image bucket:

```bash
fastly object-storage access-keys create \
  --description="edge-cms image store" \
  --permission=read-write-admin

# Note the access_key_id and secret_key from the output.
# The secret_key is shown ONCE — save it immediately.
```

Create the bucket (uses AWS CLI against the Fastly Object Storage endpoint):

```bash
export AWS_ACCESS_KEY_ID=<your-fos-access-key-id>
export AWS_SECRET_ACCESS_KEY=<your-fos-secret-key>

aws s3 mb s3://edge-cms-images \
  --endpoint-url https://us-east-1.object.fastlystorage.app \
  --region us-east-1
```

Adjust the region (`us-east-1`, `eu-central-1`, `ap-southeast-1`) to match where you want images stored.

### Step 5 — Deploy the Compute service

```bash
cd edge-cms/rust/
fastly compute deploy
```

When prompted, choose to link your existing KV Store (`edge-cms-content`) to the `content` resource link, and your existing Secret Store (`edge-cms-secrets`) to the `secrets` resource link. The deploy will create a new Compute service and output its service ID.

Note the service domain — it will be something like `<hash>.edgecompute.app`. You'll assign your own `app.` subdomain later.

**After deploy, add your domain to the Compute service:**

```bash
export COMPUTE_SID=<your-compute-service-id>

fastly domain create \
  --service-id=$COMPUTE_SID \
  --version=latest --autoclone \
  --name=app.your-domain.com

fastly service-version activate \
  --service-id=$COMPUTE_SID \
  --version=latest
```

**Add the Fastly Purge API backend** (Compute calls this to invalidate the CDN cache on writes):

```bash
fastly backend create \
  --service-id=$COMPUTE_SID \
  --version=latest --autoclone \
  --name=fastly-api \
  --address=api.fastly.com \
  --port=443 \
  --use-ssl \
  --ssl-cert-hostname=api.fastly.com \
  --ssl-sni-hostname=api.fastly.com

fastly backend create \
  --service-id=$COMPUTE_SID \
  --version=latest --autoclone \
  --name=fastly-object-storage \
  --address=us-east-1.object.fastlystorage.app \
  --port=443 \
  --use-ssl \
  --ssl-cert-hostname=us-east-1.object.fastlystorage.app \
  --ssl-sni-hostname=us-east-1.object.fastlystorage.app

fastly service-version activate \
  --service-id=$COMPUTE_SID --version=latest
```

### Step 6 — Create and link the Config Store

The Config Store holds cache TTLs that the Compute app reads at runtime. Values can be changed live without redeploying.

```bash
# Create the store
fastly config-store create --name=edge-cms-cache-config
export CSID=<config-store-id from output>

# Populate cache TTLs (values in seconds)
fastly config-store-entry create --store-id=$CSID --key=page_ttl --value=2592000    # 30 days
fastly config-store-entry create --store-id=$CSID --key=asset_ttl --value=31536000   # 1 year
fastly config-store-entry create --store-id=$CSID --key=image_ttl --value=31536000   # 1 year

# Link to the Compute service
fastly resource-link create \
  --service-id=$COMPUTE_SID \
  --version=latest --autoclone \
  --resource-id=$CSID \
  --name=cache_config

fastly service-version activate \
  --service-id=$COMPUTE_SID --version=latest
```

### Step 7 — Populate the Secret Store

The Secret Store holds 8 keys. The Compute app will fail to start if any required secret is missing.

```bash
export SSID=<your-secret-store-id>

# 1. Admin password — bcrypt hash
BCRYPT=$(python3 -c "import bcrypt; print(bcrypt.hashpw(b'YOUR_ADMIN_PASSWORD', bcrypt.gensalt()).decode())")
echo -n "$BCRYPT" | fastly secret-store-entry create \
  --store-id=$SSID --name=admin_password --stdin --recreate-allow

# 2. Session HMAC signing key — random 32 bytes, base64-encoded
echo -n "$(openssl rand -base64 32)" | fastly secret-store-entry create \
  --store-id=$SSID --name=hmac_key --stdin --recreate-allow

# 3. Fastly API token — must have purge scope on the VCL CDN service
#    Create a token at https://manage.fastly.com/account/personal/tokens
#    Scope: purge_select on the VCL service, or use a full-access token
echo -n 'YOUR_PURGE_API_TOKEN' | fastly secret-store-entry create \
  --store-id=$SSID --name=fastly_api_token --stdin --recreate-allow

# 4. VCL CDN service ID — Compute purges this service on content writes
#    (Populate after creating the VCL service in Step 7)
echo -n 'YOUR_VCL_SERVICE_ID' | fastly secret-store-entry create \
  --store-id=$SSID --name=purge_service_id --stdin --recreate-allow

# 5. Object Storage credentials
echo -n 'YOUR_FOS_ACCESS_KEY_ID' | fastly secret-store-entry create \
  --store-id=$SSID --name=fos_access_key_id --stdin --recreate-allow

echo -n 'YOUR_FOS_SECRET_KEY' | fastly secret-store-entry create \
  --store-id=$SSID --name=fos_secret_key --stdin --recreate-allow

# 6. Object Storage region and bucket name
echo -n 'us-east-1' | fastly secret-store-entry create \
  --store-id=$SSID --name=fos_region --stdin --recreate-allow

echo -n 'edge-cms-images' | fastly secret-store-entry create \
  --store-id=$SSID --name=fos_bucket --stdin --recreate-allow
```

**Secret reference table:**

| Key | Description | Source |
|-----|-------------|--------|
| `admin_password` | bcrypt hash of your admin password | Generate with Python `bcrypt` |
| `hmac_key` | Session cookie signing key | `openssl rand -base64 32` |
| `fastly_api_token` | Token with purge scope on VCL service | Fastly account → API tokens |
| `purge_service_id` | VCL CDN service ID | Output of Step 8 |
| `fos_access_key_id` | Object Storage access key ID | Output of Step 4 |
| `fos_secret_key` | Object Storage secret key | Output of Step 4 (shown once) |
| `fos_region` | Object Storage region | e.g. `us-east-1` |
| `fos_bucket` | Object Storage bucket name | e.g. `edge-cms-images` |

### Step 8 — Create the VCL CDN service

The VCL service is the public-facing CDN layer. It caches reader responses, serves images directly from Object Storage with SigV4 signing, and rate-limits login attempts.

**Create the service:**

```bash
fastly service create --type=vcl --name=edge-cms
export VCL_SID=<service-id from output>

fastly domain create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=your-domain.com
```

**Add backends:**

```bash
# Backend: Compute app (default for all non-image requests)
fastly backend create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=edge-cms-compute \
  --address=app.your-domain.com \
  --port=443 --use-ssl \
  --ssl-cert-hostname=app.your-domain.com \
  --ssl-sni-hostname=app.your-domain.com \
  --override-host=app.your-domain.com \
  --shield=iad-va-us

# Backend: Fastly Object Storage (for image requests)
fastly backend create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=edge-cms-fos \
  --address=us-east-1.object.fastlystorage.app \
  --port=443 --use-ssl \
  --ssl-cert-hostname=us-east-1.object.fastlystorage.app \
  --ssl-sni-hostname=us-east-1.object.fastlystorage.app \
  --override-host=us-east-1.object.fastlystorage.app \
  --shield=iad-va-us
```

**Create private dictionary for Object Storage SigV4 credentials:**

```bash
fastly service-dictionary create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=edge_cms_fos_creds --write-only

fastly service-dictionary create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=edge_cms_rate_limit_uris

fastly service-dictionary create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=edge_cms_config

# Note the dictionary IDs from the output
export FOS_DICT_ID=<edge_cms_fos_creds dictionary id>
export RL_DICT_ID=<edge_cms_rate_limit_uris dictionary id>
export CFG_DICT_ID=<edge_cms_config dictionary id>

# Populate the FOS credentials dictionary
fastly service-dictionary-item create \
  --service-id=$VCL_SID --dictionary-id=$FOS_DICT_ID \
  --key=access_key_id --value=YOUR_FOS_ACCESS_KEY_ID

fastly service-dictionary-item create \
  --service-id=$VCL_SID --dictionary-id=$FOS_DICT_ID \
  --key=secret_key --value=YOUR_FOS_SECRET_KEY

# Populate the rate-limit URI list
fastly service-dictionary-item create \
  --service-id=$VCL_SID --dictionary-id=$RL_DICT_ID \
  --key=/admin/login --value=1

# Populate the config dictionary — image cache TTL (seconds)
fastly service-dictionary-item create \
  --service-id=$VCL_SID --dictionary-id=$CFG_DICT_ID \
  --key=active_backend --value=rust

fastly service-dictionary-item create \
  --service-id=$VCL_SID --dictionary-id=$CFG_DICT_ID \
  --key=image_ttl --value=31536000
```

**Add VCL snippets** — these control request routing and image signing.

```bash
# Snippet 1: Pass /admin/* directly to Compute, bypass cache
fastly vcl snippet create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=admin-pass --type=recv --priority=50 \
  --content='if (req.url.path ~ "^/admin") { set req.backend = F_edge_cms_compute; return(pass); }'

# Snippet 2: Route /images/* to Object Storage backend
fastly vcl snippet create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=images-route --type=recv --priority=100 \
  --content='if (req.url.path ~ "^/images/") { set req.backend = F_edge_cms_fos; set req.http.X-Fastly-Imageopto-Api = "fastly"; }'

# Snippet 3: Sign image requests with AWS SigV4 on cache miss
# This snippet is long — write it to a file first
cat > /tmp/images-sign.vcl << 'ENDVCL'
if (req.backend == F_edge_cms_fos) {
  set bereq.url = regsuball(bereq.url.path, "^/images/", "/edge-cms-images/");

  declare local var.access_key STRING;
  declare local var.secret_key STRING;
  declare local var.datetime   STRING;
  declare local var.date       STRING;
  declare local var.region     STRING;
  declare local var.host       STRING;
  declare local var.body_hash  STRING;

  set var.access_key = table.lookup(edge_cms_fos_creds, "access_key_id");
  set var.secret_key = table.lookup(edge_cms_fos_creds, "secret_key");
  set var.region     = "us-east-1";
  set var.host       = "us-east-1.object.fastlystorage.app";
  set var.datetime   = strftime({"%Y%m%dT%H%M%SZ"}, now);
  set var.date       = strftime({"%Y%m%d"}, now);
  set var.body_hash  = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; # pragma: allowlist secret

  set bereq.http.Host                 = var.host;
  set bereq.http.x-amz-date          = var.datetime;
  set bereq.http.x-amz-content-sha256 = var.body_hash;
  unset bereq.http.Authorization;

  declare local var.canonical_headers STRING;
  set var.canonical_headers =
    "host:" + var.host + LF +
    "x-amz-content-sha256:" + var.body_hash + LF +
    "x-amz-date:" + var.datetime + LF;

  declare local var.signed_headers STRING;
  set var.signed_headers = "host;x-amz-content-sha256;x-amz-date";

  declare local var.credential_scope STRING;
  set var.credential_scope = var.date + "/" + var.region + "/s3/aws4_request";

  declare local var.canonical_request STRING;
  set var.canonical_request =
    "GET" + LF +
    bereq.url + LF +
    "" + LF +
    var.canonical_headers + LF +
    var.signed_headers + LF +
    var.body_hash;

  declare local var.string_to_sign STRING;
  set var.string_to_sign =
    "AWS4-HMAC-SHA256" + LF +
    var.datetime + LF +
    var.credential_scope + LF +
    digest.hash_sha256(var.canonical_request);

  declare local var.signature STRING;
  set var.signature = digest.awsv4_hmac(
    var.secret_key, var.date, var.region, "s3", var.string_to_sign
  );

  set bereq.http.Authorization =
    "AWS4-HMAC-SHA256 Credential=" + var.access_key + "/" + var.credential_scope +
    ", SignedHeaders=" + var.signed_headers +
    ", Signature=" + var.signature;
}
ENDVCL

fastly vcl snippet create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=images-sign --type=miss --priority=100 \
  --content="$(cat /tmp/images-sign.vcl)"

# Snippet 4: Strip internal AWS headers from image responses
fastly vcl snippet create \
  --service-id=$VCL_SID --version=latest --autoclone \
  --name=images-deliver --type=deliver --priority=100 \
  --content='unset resp.http.X-Amz-Request-Id; unset resp.http.X-Amz-Id-2; unset resp.http.X-Amz-Version-Id;'
```

> **Note:** The rate limiter cannot be created via the Fastly CLI. Use the Fastly web UI under **Security → Rate Limiting** on the VCL service, or use the Terraform path which automates this.

**Enable Image Optimizer:**

```bash
fastly products enable --service-id=$VCL_SID --product-id=image_optimizer
```

**Activate the VCL service:**

```bash
fastly service-version activate --service-id=$VCL_SID --version=latest
```

**Update the Compute service** with the VCL service ID in the Secret Store (go back to Step 7, `purge_service_id`):

```bash
echo -n "$VCL_SID" | fastly secret-store-entry create \
  --store-id=$SSID --name=purge_service_id --stdin --recreate-allow
```

### Step 9 — Seed the KV Store

Initialize the content KV store with empty index and sidebar structures:

```bash
export KVID=<your-content-kv-store-id>

fastly kv-store-entry create \
  --store-id=$KVID \
  --key=_index \
  --value='{"posts":[]}'

fastly kv-store-entry create \
  --store-id=$KVID \
  --key=_sidebar \
  --value='{"items":[]}'
```

### Step 10 — Configure DNS

Add two CNAME records in your DNS provider:

| Name | Type | Value |
|------|------|-------|
| `your-domain.com` | CNAME | `j.sni.global.fastly.net` |
| `app.your-domain.com` | CNAME | `j.sni.global.fastly.net` |

### Step 11 — Provision TLS

```bash
# Provision Let's Encrypt certificates for both domains
fastly tls-subscription create \
  --domain=your-domain.com \
  --cert-authority=lets-encrypt

fastly tls-subscription create \
  --domain=app.your-domain.com \
  --cert-authority=lets-encrypt

# Check for DNS validation CNAME records to add
fastly tls-subscription list
```

Each subscription will show one or more `_acme-challenge.*` CNAME records. Add these to your DNS provider — Fastly validates them to issue the certificate. Certificates are usually issued within a few minutes.

### Step 12 — First login

Visit `https://your-domain.com/admin/login` and sign in with the admin password you set in Step 7.

---

## Installation: Terraform

The Terraform configuration automates the full infrastructure — VCL CDN service (with all snippets, rate limiter, dictionaries), Compute service, KV Store, Secret Store, and Object Storage access keys. Secrets and the Object Storage bucket still require a few manual steps after `terraform apply`.

### Step 1 — Build the Compute package

```bash
cd edge-cms/rust/
fastly compute build
```

This produces `rust/pkg/edge-cms.tar.gz`, which Terraform uploads on apply.

### Step 2 — Configure Terraform variables

```bash
cd edge-cms/terraform/
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
fastly_api_token     = "your-fastly-api-token"
domain               = "your-domain.com"
compute_package_path = "../rust/pkg/edge-cms.tar.gz"
fos_region           = "us-east-1"
fos_bucket           = "edge-cms-images"
shield_pop           = "iad-va-us"

# Optional: enable HTTPS log streaming
# logging_endpoint_url = "https://your-log-drain.example.com/logs"
# logging_token        = "your-logging-auth-token"
```

`terraform.tfvars` is gitignored — never commit it.

**Variable reference:**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `fastly_api_token` | Yes | — | Fastly API token for Terraform |
| `domain` | Yes | — | Public domain (e.g. `edge-cms.example.com`) |
| `compute_package_path` | No | `../rust/pkg/edge-cms.tar.gz` | Path to the built Compute package |
| `fos_region` | No | `us-east-1` | Object Storage region |
| `fos_bucket` | No | `edge-cms-images` | Object Storage bucket name |
| `shield_pop` | No | `iad-va-us` | POP for origin shielding — pick one near your origin or users |
| `logging_endpoint_url` | No | `""` | HTTPS log drain URL; leave empty to disable |
| `logging_token` | No | `""` | Bearer token for the log drain |

**Shield POP selection:** pick a POP geographically close to your primary user base. Find POP codes at `fastly pop list` or the [Fastly POP reference](https://developer.fastly.com/reference/api/utils/pops/).

### Step 3 — Apply

```bash
cd edge-cms/terraform/
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Terraform creates:
- VCL CDN service with backends, dictionaries, VCL snippets, rate limiter, compression, and Image Optimizer
- Compute service with KV Store, Secret Store, and Config Store resource links, and backends for the Fastly API and Object Storage
- KV Store (`edge-cms-content`)
- Config Store (`edge-cms-cache-config`) — pre-populated with cache TTLs (`page_ttl`, `asset_ttl`, `image_ttl`)
- Secret Store (`edge-cms-secrets`) — created empty; populate in the next step
- Edge Dictionary (`edge_cms_config`) — pre-populated with `active_backend` and `image_ttl`
- Object Storage access key pair

After apply, note the outputs — you'll need them for the next steps:

```bash
terraform output
```

### Step 4 — Populate the Secret Store

The Secret Store is created empty by Terraform (secrets cannot be stored in Terraform state).
Use the IDs from `terraform output` to populate all 8 required keys:

```bash
export SSID=$(terraform output -raw secret_store_id)
export VCL_SID=$(terraform output -raw vcl_service_id)
export FOS_AKI=$(terraform output -raw fos_access_key_id)
export FOS_SK=$(terraform output -raw fos_secret_key)

# 1. Admin password — bcrypt hash
BCRYPT=$(python3 -c "import bcrypt; print(bcrypt.hashpw(b'YOUR_ADMIN_PASSWORD', bcrypt.gensalt()).decode())")
echo -n "$BCRYPT" | fastly secret-store-entry create \
  --store-id=$SSID --name=admin_password --stdin --recreate-allow

# 2. Session HMAC signing key
echo -n "$(openssl rand -base64 32)" | fastly secret-store-entry create \
  --store-id=$SSID --name=hmac_key --stdin --recreate-allow

# 3. Fastly API token with purge scope on the VCL service
#    Create at: https://manage.fastly.com/account/personal/tokens
echo -n 'YOUR_PURGE_API_TOKEN' | fastly secret-store-entry create \
  --store-id=$SSID --name=fastly_api_token --stdin --recreate-allow

# 4. VCL CDN service ID (from terraform output)
echo -n "$VCL_SID" | fastly secret-store-entry create \
  --store-id=$SSID --name=purge_service_id --stdin --recreate-allow

# 5. Object Storage credentials (from terraform output)
echo -n "$FOS_AKI" | fastly secret-store-entry create \
  --store-id=$SSID --name=fos_access_key_id --stdin --recreate-allow

echo -n "$FOS_SK" | fastly secret-store-entry create \
  --store-id=$SSID --name=fos_secret_key --stdin --recreate-allow

# 6. Object Storage region and bucket (must match terraform.tfvars)
echo -n 'us-east-1' | fastly secret-store-entry create \
  --store-id=$SSID --name=fos_region --stdin --recreate-allow

echo -n 'edge-cms-images' | fastly secret-store-entry create \
  --store-id=$SSID --name=fos_bucket --stdin --recreate-allow
```

> **Why not Terraform for secrets?** Terraform stores state in plaintext. Putting secrets in `terraform.tfstate` would expose them to anyone with state access. The Secret Store is provisioned as an empty container; secrets are populated out-of-band via the CLI.

### Step 5 — Create the Object Storage bucket

Terraform creates the access key pair but not the bucket itself (the bucket needs the credentials that don't exist until after apply). Use the credentials from `terraform output`:

```bash
export AWS_ACCESS_KEY_ID=$(terraform output -raw fos_access_key_id)
export AWS_SECRET_ACCESS_KEY=$(terraform output -raw fos_secret_key)

aws s3 mb s3://edge-cms-images \
  --endpoint-url https://us-east-1.object.fastlystorage.app \
  --region us-east-1
```

Replace `edge-cms-images`, `us-east-1`, and the endpoint region to match your `terraform.tfvars`.

### Step 6 — Populate the VCL dictionary

The private `edge_cms_fos_creds` dictionary holds Object Storage credentials for SigV4 signing in VCL. Populate it after apply:

```bash
export VCL_SID=$(terraform output -raw vcl_service_id)
export DICT_ID=$(terraform output -raw fos_dict_id)
export FOS_AKI=$(terraform output -raw fos_access_key_id)
export FOS_SK=$(terraform output -raw fos_secret_key)

fastly service-dictionary-item create \
  --service-id=$VCL_SID --dictionary-id=$DICT_ID \
  --key=access_key_id --value="$FOS_AKI"

fastly service-dictionary-item create \
  --service-id=$VCL_SID --dictionary-id=$DICT_ID \
  --key=secret_key --value="$FOS_SK"
```

### Step 7 — Seed the KV Store

```bash
export KVID=$(terraform output -raw content_kv_store_id)

fastly kv-store-entry create \
  --store-id=$KVID --key=_index --value='{"posts":[]}'

fastly kv-store-entry create \
  --store-id=$KVID --key=_sidebar --value='{"items":[]}'
```

### Step 8 — Configure DNS

Add two CNAME records in your DNS provider:

| Name | Type | Value |
|------|------|-------|
| `your-domain.com` | CNAME | `j.sni.global.fastly.net` |
| `app.your-domain.com` | CNAME | `j.sni.global.fastly.net` |

```bash
# Confirm the expected records
terraform output squarespace_dns_routing_cnames
```

### Step 9 — Provision TLS

```bash
# Provision Let's Encrypt for both domains
fastly tls-subscription create \
  --domain=your-domain.com --cert-authority=lets-encrypt

fastly tls-subscription create \
  --domain=app.your-domain.com --cert-authority=lets-encrypt

# List validation records — add these CNAME records in your DNS provider
fastly tls-subscription list
```

Certificates are issued once Fastly verifies the `_acme-challenge.*` DNS records. This usually takes 1–5 minutes after the DNS change propagates.

### Step 10 — First login

Visit `https://your-domain.com/admin/login` and sign in with the admin password you set in Step 4.

> **Note:** The Config Store and `edge_cms_config` dictionary are fully managed by Terraform. To change cache TTLs, update the values in `stores.tf` and `vcl.tf` and run `terraform apply`, or update them live via the CLI (see "Changing TTLs Live" in the Caching Strategy section).

---

## Sensitive Files Reference

| File | Tracked | Purpose |
|------|---------|---------|
| `rust/.env.example` | Yes | Template — copy to `.env` for local dev |
| `rust/.env` | **No** (gitignored) | Local API token and service ID |
| `terraform/terraform.tfvars.example` | Yes | Template — copy to `terraform.tfvars` |
| `terraform/terraform.tfvars` | **No** (gitignored) | Fastly API token and deployment config |
| `terraform/terraform.tfstate` | **No** (gitignored) | Terraform state — contains FOS access key ID |
| `rust/tests/secrets.json` | Yes | **Test-only** bcrypt hash and HMAC key — not real credentials |

The `tests/secrets.json` file contains placeholder credentials for local development only. The bcrypt hash corresponds to the password `testpassword` and the HMAC key is a fixed base64 string. These are safe to commit because they are never used in production — the Secret Store is always used in deployed environments.

---

## Local Development

Run locally with Viceroy (Fastly's local Compute runtime):

```bash
cd edge-cms/rust/
fastly compute serve
```

This starts a local server at `http://127.0.0.1:7676` with test data pre-loaded from the fixture files in `tests/`. The `fastly.toml` configures local KV and Secret stores to use these files — no Fastly account required for local development.

**Local test fixtures:**

| File | Contents |
|------|---------|
| `tests/kv-content.json` | Sample post, index, and sidebar config |
| `tests/kv-images.json` | Empty image store placeholder |
| `tests/cache-config.json` | Cache TTLs for local dev (matches production Config Store) |
| `tests/secrets.json` | Test admin password hash and HMAC key |

### Integration Tests

With Viceroy running, execute the integration test script:

```bash
./tests/integration.sh
```

This exercises all reader routes, cache headers, JSON-LD structured data, and admin auth redirects.

---

## Data Model

| Store | Type | Key | Value |
|-------|------|-----|-------|
| `content` | KV | `_index` | JSON array of post metadata (used for listing pages) |
| `content` | KV | `_sidebar` | JSON sidebar config (tags + links) |
| `content` | KV | `post:<slug>` | Full post JSON (title, content, tags, dates, featured image URL) |
| `images` | FOS bucket | `<slug>/<filename>` | Raw image bytes (written by Compute, served by VCL via FOS) |
| `cache_config` | Config Store | `page_ttl`, `asset_ttl`, `image_ttl` | Cache TTLs in seconds (read by Compute) |
| `edge_cms_config` | Edge Dictionary | `active_backend`, `image_ttl` | Backend selector + VCL image cache TTL |
| `secrets` | Secret Store | 8 keys | See secret reference table above |

---

## Caching Strategy

All cache TTLs are configurable at runtime — no code deploy required. Compute reads from a **Config Store** (`cache_config`), and VCL image caching reads from the **`edge_cms_config` Edge Dictionary**.

### TTL Tiers

| Content | Edge + Browser TTL | Source | Surrogate Keys |
|---------|-------------------|--------|----------------|
| **Pages** (home, post, tag, feed, sitemap, robots) | 30 days (`2592000`) | Config Store: `page_ttl` | `post-index`, `post-<slug>`, `sidebar` |
| **CSS/JS** | 1 year (`31536000`) | Config Store: `asset_ttl` | `assets` |
| **Images** (via VCL → Object Storage) | 1 year (`31536000`) | Edge Dictionary: `image_ttl` | `images` |
| **Admin** (`/admin/*`) | No cache | `private, no-store` + VCL `return(pass)` | — |

### Changing TTLs Live

```bash
# Pages — takes effect on next cache miss (or purge first for immediate effect)
fastly config-store-entry update \
  --store-id=<cache-config-store-id> --key=page_ttl --value=86400

# Images — Edge Dictionary, takes effect immediately on next miss
fastly service dictionary-entry update \
  --service-id=<vcl-service-id> \
  --dictionary-id=<edge_cms_config-dict-id> \
  --key=image_ttl --value=86400
```

### Purging

On any admin write (create, update, or delete), Compute calls the Fastly Purge API with the relevant surrogate key, instantly invalidating only the affected cached responses. With aggressive TTLs, purging is the primary cache invalidation mechanism.

### Compression

The VCL CDN service applies **brotli** (with gzip fallback) to all text-based responses: HTML, CSS, JS, JSON, XML, and SVG. Images are excluded — they are already compressed by format. Fastly auto-negotiates the encoding based on `Accept-Encoding`.

---

## Directory Structure

```
edge-cms/
├── README.md
├── DESIGN.md              # Full design document
├── shared/                # Shared across all language implementations
│   ├── templates/         # Handlebars templates (.hbs)
│   ├── css/               # Stylesheet
│   └── js/                # Admin JavaScript
├── rust/                  # Rust/Compute implementation (complete)
│   ├── src/               # Rust source
│   ├── tests/             # Fixture data and integration tests
│   ├── .env.example       # Local dev environment template
│   ├── Cargo.toml
│   └── fastly.toml        # Compute manifest + local dev store config
└── terraform/             # Infrastructure-as-code
    ├── providers.tf        # Fastly provider config
    ├── variables.tf        # Variable definitions
    ├── terraform.tfvars.example  # Variable template (copy to terraform.tfvars)
    ├── compute.tf          # Compute service
    ├── stores.tf           # KV Store, Secret Store, Config Store, Object Storage access keys
    ├── vcl.tf              # VCL CDN service with snippets, rate limiter, dictionaries
    ├── tls.tf              # TLS provisioning notes and commented resources
    └── outputs.tf          # IDs, credentials, post-apply checklist
```

---

## Available Implementations

| Language | Status | Notes |
|----------|--------|-------|
| **Rust** | Complete | Primary implementation. All features working. |
| TypeScript | Planned | Will use `@fastly/js-compute` SDK |
| Go | Planned | Will use `compute-sdk-go` |

All implementations share the same templates (`shared/`) and produce identical behavior. The differences are in how each language handles routing, KV Store access, and response construction.
