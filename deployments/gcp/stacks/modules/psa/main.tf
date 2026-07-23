variable "project_id" {
  type = string
}

variable "network" {
  type = string
}

variable "psa_range_name" {
  type = string
}

variable "psa_prefix_length" {
  type    = number
  default = 20
}

locals {
  vpc_name = element(split("/", var.network), length(split("/", var.network)) - 1)
}

resource "google_compute_global_address" "psa_range" {
  name          = var.psa_range_name
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.psa_prefix_length
  network       = var.network
  project       = var.project_id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = var.network
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]
}

# GCNV (NAS + Flex UNIFIED SAN) requires NetApp-specific PSA peering (sn-netapp-prod).
resource "google_service_networking_connection" "netapp" {
  network                 = var.network
  service                 = "netapp.servicenetworking.goog"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]

  depends_on = [google_compute_global_address.psa_range]
}

resource "google_compute_network_peering_routes_config" "netapp_routes" {
  peering = google_service_networking_connection.netapp.peering
  network = local.vpc_name
  project = var.project_id

  import_custom_routes = true
  export_custom_routes = true
}

output "psa_range_name" {
  value = google_compute_global_address.psa_range.name
}

output "gcnv_network" {
  description = "Network string for GCNV pool creation (name=vpc,psa-range=range)."
  value       = "name=${split("/", var.network)[length(split("/", var.network)) - 1]},psa-range=${google_compute_global_address.psa_range.name}"
}
