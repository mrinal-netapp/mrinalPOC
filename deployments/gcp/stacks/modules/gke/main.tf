locals {
  release_channel = upper(var.release_channel)
}

resource "google_container_cluster" "primary" {
  name     = var.cluster_name
  location = var.location
  project  = var.project_id

  network    = var.network
  subnetwork = var.subnetwork

  deletion_protection = var.deletion_protection

  remove_default_node_pool = true
  initial_node_count       = 1

  release_channel {
    channel = local.release_channel
  }

  min_master_version = var.kubernetes_version != "" ? var.kubernetes_version : null

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  resource_labels = var.resource_labels

  logging_service    = "logging.googleapis.com/kubernetes"
  monitoring_service = "monitoring.googleapis.com/kubernetes"
}

resource "google_container_node_pool" "pools" {
  for_each = { for pool in var.node_pools : pool.name => pool }

  name     = each.value.name
  location = var.location
  cluster  = google_container_cluster.primary.name
  project  = var.project_id

  autoscaling {
    min_node_count = each.value.min_count
    max_node_count = each.value.max_count
  }

  node_config {
    machine_type = each.value.machine_type
    disk_size_gb = each.value.disk_size_gb
    image_type   = each.value.image_type
    labels       = each.value.labels

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    dynamic "taint" {
      for_each = each.value.taints
      content {
        key    = taint.value.key
        value  = taint.value.value
        effect = taint.value.effect
      }
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}
