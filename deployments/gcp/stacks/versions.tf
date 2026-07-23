terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      # 7.28+ adds google_netapp_storage_pool.type (UNIFIED SAN pools).
      version = "~> 7.28"
    }
  }
}

provider "google" {
  project        = var.project_id
  region         = var.location
  default_labels = var.labels
}
