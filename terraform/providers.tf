terraform {
  required_version = ">= 1.5"

  required_providers {
    fastly = {
      source  = "fastly/fastly"
      version = "~> 9.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # -------------------------------------------------------------------------
  # State backend
  #
  # WARNING: state is local (terraform.tfstate) by default, and it contains
  # secrets in plain text: origin_auth_token, both Object Storage secret
  # keys, the logging token. Keep it out of git (it is gitignored), off
  # shared drives, and on an encrypted disk — or use an encrypted remote
  # backend with tight IAM, like one of the examples below (not enabled).
  # Switching: uncomment one, then `terraform init -migrate-state`.
  #
  # GCS — bucket with versioning + uniform bucket-level access; encrypted at
  # rest by Google, optionally with your own Cloud KMS key:
  #
  # backend "gcs" {
  #   bucket             = "your-tfstate-bucket"
  #   prefix             = "edge-cms"
  #   kms_encryption_key = "projects/<proj>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key>"
  # }
  #
  # S3 — SSE-KMS encryption, versioned bucket, native S3 lockfile
  # (Terraform >= 1.10):
  #
  # backend "s3" {
  #   bucket       = "your-tfstate-bucket"
  #   key          = "edge-cms/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   kms_key_id   = "alias/your-tfstate-key"
  #   use_lockfile = true
  # }
  # -------------------------------------------------------------------------
}

# API key is read from the FASTLY_API_KEY environment variable.
provider "fastly" {}
