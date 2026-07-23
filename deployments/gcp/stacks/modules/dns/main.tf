variable "project_id" {
  type = string
}

variable "create_zone" {
  type    = bool
  default = false
}

variable "zone_name" {
  type    = string
  default = ""
}

variable "dns_name" {
  type    = string
  default = ""
}

variable "app_record_name" {
  type    = string
  default = "app"
}

variable "auth_record_name" {
  type    = string
  default = "auth"
}

variable "target_ip_address" {
  type    = string
  default = ""
}

resource "google_dns_managed_zone" "zone" {
  count = var.create_zone ? 1 : 0

  name        = var.zone_name
  dns_name    = var.dns_name
  project     = var.project_id
  description = "AgentStudio application DNS zone"
}

resource "google_dns_record_set" "app" {
  count = var.create_zone ? (var.target_ip_address != "" ? 1 : 0) : 0

  name         = "${var.app_record_name}.${trim(var.dns_name, ".")}."
  managed_zone = google_dns_managed_zone.zone[0].name
  type         = "A"
  ttl          = 300
  project      = var.project_id
  rrdatas      = [var.target_ip_address]
}

resource "google_dns_record_set" "auth" {
  count = var.create_zone ? (var.target_ip_address != "" ? 1 : 0) : 0

  name         = "${var.auth_record_name}.${trim(var.dns_name, ".")}."
  managed_zone = google_dns_managed_zone.zone[0].name
  type         = "A"
  ttl          = 300
  project      = var.project_id
  rrdatas      = [var.target_ip_address]
}

output "zone_name" {
  value = var.create_zone ? google_dns_managed_zone.zone[0].name : ""
}

output "dns_name" {
  value = var.create_zone ? google_dns_managed_zone.zone[0].dns_name : ""
}
