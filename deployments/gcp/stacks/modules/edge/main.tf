variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "gateway_address_name" {
  type = string
}

resource "google_compute_address" "gateway" {
  name    = var.gateway_address_name
  region  = var.region
  project = var.project_id
}

output "gateway_address_name" {
  value = google_compute_address.gateway.name
}

output "gateway_ip_address" {
  value = google_compute_address.gateway.address
}

output "gateway_address_self_link" {
  value = google_compute_address.gateway.self_link
}
