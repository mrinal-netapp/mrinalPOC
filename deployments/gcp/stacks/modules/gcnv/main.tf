variable "project_id" {
  type = string
}

variable "location" {
  type = string
}

variable "vpc_name" {
  type = string
}

variable "nas_pool_name" {
  type = string
}

variable "san_pool_name" {
  type = string
}

variable "nas_capacity_gib" {
  type = number
}

variable "nas_service_level" {
  type    = string
  default = "STANDARD"
  validation {
    condition     = contains(["STANDARD", "PREMIUM", "EXTREME", "FLEX"], var.nas_service_level)
    error_message = "nas_service_level must be one of STANDARD, PREMIUM, EXTREME, FLEX."
  }
}

variable "san_capacity_gib" {
  type = number
}

variable "san_zone" {
  type    = string
  default = ""
}

variable "san_replica_zone" {
  type    = string
  default = ""
}

locals {
  network_uri = "projects/${var.project_id}/global/networks/${var.vpc_name}"
  san_zone    = var.san_zone != "" ? var.san_zone : "${var.location}-b"
  san_replica = var.san_replica_zone != "" ? var.san_replica_zone : "${var.location}-c"
  # Flex pools are zone-redundant and require type + zone + replica_zone (same
  # as the SAN pool). STANDARD/PREMIUM/EXTREME are regional and set none of them.
  nas_is_flex = var.nas_service_level == "FLEX"
  nas_type    = local.nas_is_flex ? "UNIFIED" : null
  nas_zone    = local.nas_is_flex ? local.san_zone : null
  nas_replica = local.nas_is_flex ? local.san_replica : null
}

resource "google_netapp_storage_pool" "nas" {
  name          = var.nas_pool_name
  location      = var.location
  capacity_gib  = var.nas_capacity_gib
  service_level = var.nas_service_level
  network       = local.network_uri
  project       = var.project_id
  type          = local.nas_type
  zone          = local.nas_zone
  replica_zone  = local.nas_replica
}

resource "google_netapp_storage_pool" "san" {
  name          = var.san_pool_name
  location      = var.location
  capacity_gib  = var.san_capacity_gib
  service_level = "FLEX"
  network       = local.network_uri
  project       = var.project_id
  type          = "UNIFIED"
  zone          = local.san_zone
  replica_zone  = local.san_replica
}

output "nas_pool_name" {
  value = google_netapp_storage_pool.nas.name
}

output "san_pool_name" {
  value = google_netapp_storage_pool.san.name
}
