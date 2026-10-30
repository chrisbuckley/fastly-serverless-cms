# ---------------------------------------------------------------------------
# TLS — wildcard Let's Encrypt certificate
#
# One subscription covers var.domain + *.var.domain (app, app-go, app-ts, etc.)
# No new certs needed when adding language implementations. The wildcard is
# only on the certificate — DNS uses explicit per-host records (see the
# dns_routing_records output), never a wildcard CNAME.
#
# The automation account may not have TLS provisioning enabled (403).
# If so, provision via CLI with your main account token — see
# tls_provisioning_commands output.
#
# After creation, `fastly tls-subscription list` shows DNS validation
# CNAME records to add. See dns_routing_records for routing records.
#
# To bring TLS into Terraform once enabled on the automation account,
# uncomment and run terraform import:
#
# resource "fastly_tls_subscription" "wildcard" {
#   domains               = [var.domain, "*.${var.domain}"]
#   certificate_authority = "lets-encrypt"
#   depends_on            = [fastly_service_vcl.cdn, fastly_service_compute.app]
# }
# ---------------------------------------------------------------------------
