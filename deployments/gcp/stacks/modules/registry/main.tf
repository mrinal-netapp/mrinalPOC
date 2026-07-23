variable "project_id" {
  type = string
}

variable "location" {
  type = string
}

variable "repository_id" {
  type        = string
  description = "Artifact Registry repository id (not full path)."
}

variable "node_service_account_email" {
  type        = string
  description = "GKE node service account email (default compute SA if empty)."
  default     = ""
}

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  reader_member = var.node_service_account_email != "" ? "serviceAccount:${var.node_service_account_email}" : "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

resource "google_artifact_registry_repository_iam_member" "node_reader" {
  project    = var.project_id
  location   = var.location
  repository = var.repository_id
  role       = "roles/artifactregistry.reader"
  member     = local.reader_member
}

output "reader_member" {
  value = local.reader_member
}
