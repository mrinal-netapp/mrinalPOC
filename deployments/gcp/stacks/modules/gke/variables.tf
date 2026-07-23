variable "project_id" {
  type = string
}

variable "location" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "release_channel" {
  type    = string
  default = "REGULAR"
}

variable "kubernetes_version" {
  type    = string
  default = ""
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "network" {
  type = string
}

variable "subnetwork" {
  type = string
}

variable "resource_labels" {
  type        = map(string)
  description = "GKE cluster resource labels (e.g. creator from env yaml tags)."
  default     = {}
}

variable "node_pools" {
  type = list(object({
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
}
