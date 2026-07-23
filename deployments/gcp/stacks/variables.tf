variable "labels" {
  type        = map(string)
  description = "GCP resource labels (env yaml tags.creator -> labels.creator; provider default_labels + GKE resource_labels)."
  default = {
    creator = "agentstudio"
  }
}

variable "project_id" {
  type        = string
  description = "GCP project ID."
}

variable "location" {
  type        = string
  description = "GCP region for VPC subnet and regional GKE cluster (e.g. us-central1)."
}

variable "endpoint" {
  type        = string
  description = "Application hostname label (console at https://app.<endpoint>/console/)."
  default     = "agentstudio.test"
}

variable "networking" {
  type = object({
    vpc_name                = string
    subnet_name             = string
    subnet_cidr             = string
    pods_secondary_cidr     = optional(string, "10.4.0.0/16")
    services_secondary_cidr = optional(string, "10.5.0.0/20")
    psa_range_name          = optional(string, "agentstudio-psa")
    psa_prefix_length       = optional(number, 20)
  })
  description = "VPC and GKE subnet configuration."
}

variable "gke" {
  type = object({
    cluster_name        = string
    release_channel     = optional(string, "REGULAR")
    kubernetes_version  = optional(string, "")
    deletion_protection = optional(bool, true)
    node_pools = list(object({
      name         = string
      machine_type = string
      min_count    = number
      max_count    = number
      disk_size_gb = optional(number, 100)
      image_type   = optional(string, "COS_CONTAINERD")
      labels       = optional(map(string), {})
      taints = optional(list(object({
        key    = string
        value  = string
        effect = string
      })), [])
    }))
  })
  description = "GKE cluster and node pool configuration."
}

variable "storage" {
  type = object({
    gcnv_location     = string
    nas_pool_name     = string
    san_pool_name     = string
    nas_capacity_gib  = optional(number, 4096)
    san_capacity_gib  = optional(number, 4096)
    nas_service_level = optional(string, "STANDARD")
  })
  description = "GCNV storage pool configuration."
  default     = null
}

variable "edge" {
  type = object({
    gateway_address_name = string
  })
  description = "Regional static IP for Istio gateway (Helm edge overlay)."
  default     = null
}

variable "dns" {
  type = object({
    create_zone      = optional(bool, false)
    zone_name        = optional(string, "")
    dns_name         = optional(string, "")
    app_record_name  = optional(string, "app")
    auth_record_name = optional(string, "auth")
  })
  description = "Optional Cloud DNS zone and app/auth A records."
  default = {
    create_zone = false
  }
}

variable "container_registry" {
  type = object({
    mode          = optional(string, "shared")
    location      = optional(string, "")
    repository_id = optional(string, "")
  })
  description = "Shared Artifact Registry pull IAM (mode=shared)."
  default = {
    mode = "shared"
  }
}

variable "trident" {
  type = object({
    enabled                 = optional(bool, true)
    gsa_name                = optional(string, "trident-controller")
    namespace               = optional(string, "trident")
    kubernetes_service_account = optional(string, "trident-controller")
  })
  description = "Trident controller GSA + Workload Identity (infra auth)."
  default = {
    enabled = true
  }
}
