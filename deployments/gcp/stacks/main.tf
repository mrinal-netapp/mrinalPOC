# AgentStudio GCP foundation stack (Infrastructure Manager entrypoint).
# Provisions VPC, PSA, GKE, GCNV pools, edge IP, optional DNS, shared GAR pull IAM.

module "apis" {
  source = "./modules/apis"

  project_id = var.project_id
}

module "networking" {
  source = "./modules/networking"

  project_id              = var.project_id
  region                  = var.location
  vpc_name                = var.networking.vpc_name
  subnet_name             = var.networking.subnet_name
  subnet_cidr             = var.networking.subnet_cidr
  pods_secondary_cidr     = var.networking.pods_secondary_cidr
  services_secondary_cidr = var.networking.services_secondary_cidr

  depends_on = [module.apis]
}

module "psa" {
  source = "./modules/psa"

  project_id        = var.project_id
  network           = module.networking.network_self_link
  psa_range_name    = var.networking.psa_range_name
  psa_prefix_length = var.networking.psa_prefix_length

  depends_on = [module.networking, module.apis]
}

module "firewall" {
  source = "./modules/firewall"

  project_id   = var.project_id
  network      = module.networking.network_self_link
  vpc_name     = var.networking.vpc_name
  source_cidrs = [var.networking.subnet_cidr, var.networking.pods_secondary_cidr]

  depends_on = [module.networking]
}

module "gke" {
  source = "./modules/gke"

  project_id          = var.project_id
  location            = var.location
  cluster_name        = var.gke.cluster_name
  release_channel     = var.gke.release_channel
  kubernetes_version  = var.gke.kubernetes_version
  deletion_protection = var.gke.deletion_protection
  network             = module.networking.network_self_link
  subnetwork          = module.networking.subnet_self_link
  node_pools          = var.gke.node_pools
  resource_labels     = var.labels

  depends_on = [module.networking, module.psa]
}

module "gcnv" {
  count  = var.storage != null ? 1 : 0
  source = "./modules/gcnv"

  project_id       = var.project_id
  location         = var.storage.gcnv_location
  vpc_name         = var.networking.vpc_name
  nas_pool_name     = var.storage.nas_pool_name
  san_pool_name     = var.storage.san_pool_name
  nas_capacity_gib  = var.storage.nas_capacity_gib
  san_capacity_gib  = var.storage.san_capacity_gib
  nas_service_level = var.storage.nas_service_level

  depends_on = [module.psa, module.apis]
}

module "edge" {
  count  = var.edge != null ? 1 : 0
  source = "./modules/edge"

  project_id           = var.project_id
  region               = var.location
  gateway_address_name = var.edge.gateway_address_name

  depends_on = [module.apis]
}

module "dns" {
  source = "./modules/dns"

  project_id        = var.project_id
  create_zone       = var.dns.create_zone && var.edge != null
  zone_name         = var.dns.zone_name
  dns_name          = var.dns.dns_name
  app_record_name   = var.dns.app_record_name
  auth_record_name  = var.dns.auth_record_name
  target_ip_address = var.edge != null ? module.edge[0].gateway_ip_address : ""

  depends_on = [module.apis]
}

module "registry" {
  count  = var.container_registry.mode == "shared" ? 1 : 0
  source = "./modules/registry"

  project_id    = var.project_id
  location      = var.container_registry.location
  repository_id = var.container_registry.repository_id

  depends_on = [module.apis, module.gke]
}

module "trident_identity" {
  source = "./modules/trident-identity"

  project_id              = var.project_id
  enabled                 = var.trident.enabled
  gsa_name                = var.trident.gsa_name
  trident_namespace       = var.trident.namespace
  trident_kubernetes_sa   = var.trident.kubernetes_service_account

  depends_on = [module.apis, module.gke]
}
