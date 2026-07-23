output "gsa_email" {
  description = "Trident controller Google service account email."
  value       = var.enabled ? google_service_account.trident[0].email : ""
}

output "gsa_name" {
  description = "Trident controller GSA account id."
  value       = var.enabled ? google_service_account.trident[0].account_id : ""
}
