resource "google_service_account" "trident" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = var.gsa_name
  display_name = "AgentStudio Trident controller"
}

resource "google_project_iam_member" "trident_netapp_admin" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  role    = "roles/netapp.admin"
  member  = "serviceAccount:${google_service_account.trident[0].email}"
}

resource "google_service_account_iam_member" "trident_workload_identity" {
  count = var.enabled ? 1 : 0

  service_account_id = google_service_account.trident[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.trident_namespace}/${var.trident_kubernetes_sa}]"
}
