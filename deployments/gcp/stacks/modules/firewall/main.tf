variable "project_id" {
  type = string
}

variable "network" {
  type = string
}

variable "vpc_name" {
  type = string
}

variable "source_cidrs" {
  type        = list(string)
  description = "CIDR blocks allowed to reach NFS (TCP 2049)."
}

resource "google_compute_firewall" "allow_nfs" {
  name    = "${var.vpc_name}-allow-nfs-2049"
  network = var.network
  project = var.project_id

  allow {
    protocol = "tcp"
    ports    = ["2049"]
  }

  source_ranges = var.source_cidrs
  direction     = "INGRESS"
  priority      = 1000
}
