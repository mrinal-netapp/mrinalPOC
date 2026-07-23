variable "project_id" {
  type        = string
  description = "GCP project ID."
}

variable "enabled" {
  type        = bool
  description = "Create Trident GSA and Workload Identity binding."
  default     = true
}

variable "gsa_name" {
  type        = string
  description = "Service account id (without @project.iam.gserviceaccount.com)."
  default     = "trident-controller"
}

variable "trident_namespace" {
  type        = string
  description = "Kubernetes namespace for Trident."
  default     = "trident"
}

variable "trident_kubernetes_sa" {
  type        = string
  description = "Kubernetes service account name for trident-controller."
  default     = "trident-controller"
}
