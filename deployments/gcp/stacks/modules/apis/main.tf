resource "google_project_service" "required_apis" {
  for_each = toset([
    "compute.googleapis.com",
    "container.googleapis.com",
    "config.googleapis.com",
    "netapp.googleapis.com",
    "servicenetworking.googleapis.com",
    "dns.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudquotas.googleapis.com",
  ])

  project = var.project_id
  service = each.key

  disable_on_destroy = false
}

variable "project_id" {
  type = string
}
