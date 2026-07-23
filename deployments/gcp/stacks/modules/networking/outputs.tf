output "vpc_name" {
  value = google_compute_network.vpc.name
}

output "network_self_link" {
  value = google_compute_network.vpc.self_link
}

output "subnet_name" {
  value = google_compute_subnetwork.gke.name
}

output "subnet_self_link" {
  value = google_compute_subnetwork.gke.self_link
}
