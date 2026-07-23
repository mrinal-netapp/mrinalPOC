resource "google_compute_network" "vpc" {
  name                    = var.vpc_name
  project                 = var.project_id
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "gke" {
  name          = var.subnet_name
  ip_cidr_range = var.subnet_cidr
  region        = var.region
  project       = var.project_id
  network       = google_compute_network.vpc.id

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_secondary_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_secondary_cidr
  }

  private_ip_google_access = true
}
