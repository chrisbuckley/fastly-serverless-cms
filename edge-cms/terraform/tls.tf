# ---------------------------------------------------------------------------
# TLS — managed Let's Encrypt certificates
#
# The automation account (edge-cms-4txyztf83hfif92sir2jzd) does not have TLS
# provisioning enabled (403 from Fastly API). TLS must be configured on the
# main account that owns chrisbuckley.dev.
#
# After terraform apply, provision TLS from the Fastly control panel or via
# the CLI using your main account credentials:
#
#   # Public domain
#   FASTLY_API_TOKEN=<main-account-token> \
#     fastly tls-subscription create \
#       --domain=serverless-cms.chrisbuckley.dev \
#       --cert-authority=lets-encrypt
#
#   # Internal app domain
#   FASTLY_API_TOKEN=<main-account-token> \
#     fastly tls-subscription create \
#       --domain=app.serverless-cms.chrisbuckley.dev \
#       --cert-authority=lets-encrypt
#
# After creation, fastly tls-subscription list shows the DNS validation
# CNAME records to add in Squarespace. See outputs for routing CNAMEs.
#
# To bring TLS into Terraform once TLS is enabled on the automation account,
# uncomment the resources below and run terraform import:
#
# resource "fastly_tls_subscription" "public" {
#   domains               = [var.domain]
#   certificate_authority = "lets-encrypt"
#   depends_on            = [fastly_service_vcl.cdn]
# }
#
# resource "fastly_tls_subscription" "app_internal" {
#   domains               = ["app.${var.domain}"]
#   certificate_authority = "lets-encrypt"
#   depends_on            = [fastly_service_compute.app]
# }
# ---------------------------------------------------------------------------
