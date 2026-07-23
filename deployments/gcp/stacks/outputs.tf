output "project_id" {
  description = "GCP project ID."
  value       = var.project_id
}

output "location" {
  description = "GCP region (GKE cluster location)."
  value       = var.location
}

output "endpoint" {
  description = "Application endpoint hostname."
  value       = var.endpoint
}

output "vpc_name" {
  description = "VPC network name."
  value       = module.networking.vpc_name
}

output "subnet_name" {
  description = "GKE subnet name."
  value       = module.networking.subnet_name
}

output "cluster_name" {
  description = "GKE cluster name."
  value       = module.gke.cluster_name
}

output "cluster_endpoint" {
  description = "GKE control plane endpoint (sensitive)."
  value       = module.gke.cluster_endpoint
  sensitive   = true
}

output "gcnv_nas_pool_name" {
  description = "GCNV NAS storage pool name."
  value       = var.storage != null ? module.gcnv[0].nas_pool_name : ""
}

output "gcnv_san_pool_name" {
  description = "GCNV SAN storage pool name."
  value       = var.storage != null ? module.gcnv[0].san_pool_name : ""
}

output "gcnv_network" {
  description = "GCNV network parameter for Trident/scripts."
  value       = module.psa.gcnv_network
}

output "trident_gsa_email" {
  description = "Trident controller Google service account email (Workload Identity)."
  value       = module.trident_identity.gsa_email
}

output "trident_gsa_name" {
  description = "Trident controller GSA account id."
  value       = module.trident_identity.gsa_name
}

output "gateway_address_name" {
  description = "Regional static IP name for edge Helm overlay."
  value       = var.edge != null ? module.edge[0].gateway_address_name : ""
}

output "gateway_ip_address" {
  description = "Gateway static IP address."
  value       = var.edge != null ? module.edge[0].gateway_ip_address : ""
}

output "dns_zone_name" {
  description = "Cloud DNS managed zone name (when create_zone=true)."
  value       = module.dns.zone_name
}

output "console_url_hint" {
  description = "Console URL after app deploy."
  value       = "https://app.${var.endpoint}/console/"
}
