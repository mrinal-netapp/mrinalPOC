// main.bicep -- root orchestrator for AgentStudio Azure infrastructure.
//
// Dependency graph:
//
//   networking ──> aks ──┬──> workloadIdentity
//        │               ├──> acrPull (shared registry)
//        │               ├──> anfKubeletReaderRole
//        │               ├──> anfKubeletContributorRole (resource-scoped in main.bicep)
//        │               └──> gatewayPipClusterNetworkContributorRole (when edge.gatewayPipName set)
//        └──> anf
//   keyVault ────────────────> workloadIdentity
//   containerRegistry (mode=create only)
//   gatewayPip ──> dnsZone (optional)
//   CI/CD auth: subscription-wide agent-studio-cicd-umi (outside this stack)

targetScope = 'resourceGroup'

@description('Azure region for all resources. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Entra ID tenant ID (key-vault + workload-identity). az account show --query tenantId -o tsv')
param tenantId string

@description('Networking inputs: vnetName, vnetAddressPrefix, aksSubnetName/Prefix, ilbSubnetName/Prefix, anfSubnetName/Prefix.')
param networking object

@description('AKS inputs: clusterName, kubernetesVersion, dnsPrefix, nodePools[], and optional autoUpgradeProfile + autoScalerProfile objects.')
param aks object

@description('Azure NetApp Files inputs: anfAccountName and pools[].')
param anf object

@description('Container registry: mode create|shared. shared uses resourceId + loginServer; create provisions a new ACR.')
param containerRegistry object

@description('Key Vault inputs: keyVaultName, purgeProtectionEnabled, softDeleteRetentionInDays.')
param keyVault object

@description('Workload Identity inputs: uamiNamePrefix, services[].')
param workloadIdentity object

@description('Optional gateway static public IP: gatewayPipName, sku (Standard|Basic).')
param edge object = {}

@description('Optional DNS zone: createZone, zoneName, dnsName, appRecordName, authRecordName.')
param dns object = {}

var registryMode = containerRegistry.?mode ?? 'create'
var useSharedAcr = registryMode == 'shared'
var createAcr = registryMode == 'create'
var acrResourceId = containerRegistry.?resourceId ?? ''
var acrIdParts = split(acrResourceId, '/')
var sharedAcrSubscriptionId = length(acrIdParts) > 2 ? acrIdParts[2] : subscription().subscriptionId
var sharedAcrResourceGroupName = length(acrIdParts) > 4 ? acrIdParts[4] : resourceGroup().name
var gatewayPipName = edge.?gatewayPipName ?? ''
var createGatewayPip = !empty(gatewayPipName)
var createDnsZone = dns.?createZone ?? false

module networkingMod 'networking.json' = {
  name: 'networking'
  params: {
    vnetName: networking.vnetName
    location: location
    vnetAddressPrefix: networking.vnetAddressPrefix
    aksSubnetName: networking.aksSubnetName
    aksSubnetPrefix: networking.aksSubnetPrefix
    ilbSubnetName: networking.ilbSubnetName
    ilbSubnetPrefix: networking.ilbSubnetPrefix
    anfSubnetName: networking.anfSubnetName
    anfSubnetPrefix: networking.anfSubnetPrefix
  }
}

module aksMod 'aks.json' = {
  name: 'aks'
  params: {
    clusterName: aks.clusterName
    location: location
    kubernetesVersion: aks.kubernetesVersion
    dnsPrefix: aks.dnsPrefix
    aksSubnetResourceId: networkingMod.outputs.aksSubnetId
    nodePools: aks.nodePools
    autoUpgradeProfile: aks.?autoUpgradeProfile ?? {
      upgradeChannel: 'none'
      nodeOSUpgradeChannel: 'NodeImage'
    }
    autoScalerProfile: aks.?autoScalerProfile ?? {}
    serviceCidr: aks.?serviceCidr ?? '10.0.16.0/20'
    dnsServiceIP: aks.?dnsServiceIP ?? '10.0.16.10'
  }
}

module anfMod 'azure-netapp-files.json' = {
  name: 'azure-netapp-files'
  params: {
    anfAccountName: anf.anfAccountName
    location: location
    pools: anf.pools
  }
  dependsOn: [
    networkingMod
  ]
}

module acrMod 'container-registry.json' = if (createAcr) {
  name: 'container-registry'
  params: {
    registryName: containerRegistry.registryName
    location: location
    sku: containerRegistry.sku
    adminUserEnabled: containerRegistry.adminUserEnabled
    zoneRedundancyEnabled: containerRegistry.zoneRedundancyEnabled
  }
}

module acrPullMod 'acr-pull-role.json' = if (useSharedAcr) {
  name: 'acr-pull-role'
  scope: resourceGroup(sharedAcrSubscriptionId, sharedAcrResourceGroupName)
  params: {
    principalId: aksMod.outputs.kubeletIdentityObjectId
    registryResourceId: acrResourceId
  }
}

// Contributor is deployed via a nested template scoped to the NetApp account so
// ARM accepts the role assignment (RG-scoped `scope` on roleAssignments fails
// for Microsoft.NetApp) and the assignment name stays stable across re-runs.
resource anfAccount 'Microsoft.NetApp/netAppAccounts@2023-11-01' existing = {
  name: anf.anfAccountName
  dependsOn: [
    anfMod
  ]
}

module anfKubeletReaderRoleMod 'anf-kubelet-reader-role.json' = {
  name: 'anf-kubelet-reader-role'
  params: {
    principalId: aksMod.outputs.kubeletIdentityObjectId
  }
}

resource anfKubeletContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: anfAccount
  // Stable per cluster + ANF account (principalId omitted — Bicep BCP120). If the
  // kubelet identity is ever rotated, delete this assignment and re-apply.
  name: guid(anfAccount.id, aks.clusterName, 'kubelet-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: aksMod.outputs.kubeletIdentityObjectId
    principalType: 'ServicePrincipal'
  }
}

module keyVaultMod 'key-vault.json' = {
  name: 'key-vault'
  params: {
    keyVaultName: keyVault.keyVaultName
    location: location
    tenantId: tenantId
    purgeProtectionEnabled: keyVault.purgeProtectionEnabled
    softDeleteRetentionInDays: keyVault.softDeleteRetentionInDays
  }
}

module workloadIdentityMod 'workload-identity.json' = {
  name: 'workload-identity'
  params: {
    location: location
    oidcIssuerUrl: aksMod.outputs.oidcIssuerUrl
    keyVaultName: keyVaultMod.outputs.keyVaultName
    tenantId: tenantId
    uamiNamePrefix: workloadIdentity.uamiNamePrefix
    services: workloadIdentity.services
  }
}

module gatewayPipMod 'gateway-pip.json' = if (createGatewayPip) {
  name: 'gateway-pip'
  params: {
    pipName: gatewayPipName
    location: location
    sku: edge.?sku ?? 'Standard'
  }
}

// PIP-scoped Network Contributor for the AKS *cluster* managed identity (not
// kubelet). Required when the static gateway PIP lives in the stack RG and
// Services reference it via service.beta.kubernetes.io/azure-pip-name +
// azure-load-balancer-resource-group. Without this, the cloud provider reports
// "PublicIP ... doesn't exist" because it cannot read cross-RG PIPs.
resource gatewayPublicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' existing = if (createGatewayPip) {
  name: gatewayPipName
  dependsOn: [
    gatewayPipMod
  ]
}

resource gatewayPipClusterNetworkContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createGatewayPip) {
  scope: gatewayPublicIp!
  // Stable per PIP + cluster (principalId omitted — Bicep BCP120). If the
  // cluster identity is ever rotated, delete this assignment and re-apply.
  name: guid(gatewayPublicIp!.id, aks.clusterName, 'cluster-gateway-pip-network-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4d97b98b-1d4f-4787-a291-c67834d212e7')
    principalId: aksMod.outputs.clusterIdentityObjectId
    principalType: 'ServicePrincipal'
  }
}

module dnsZoneMod 'dns-zone.json' = if (createDnsZone && createGatewayPip) {
  name: 'dns-zone'
  params: {
    zoneName: dns.zoneName
    dnsName: dns.dnsName
    appRecordName: dns.?appRecordName ?? 'app'
    authRecordName: dns.?authRecordName ?? 'auth'
    targetIpAddress: gatewayPipMod!.outputs.ipAddress
  }
}

@description('AKS cluster name.')
output clusterName string = aksMod.outputs.clusterName

@description('AKS OIDC issuer URL (workload identity federation).')
output oidcIssuerUrl string = aksMod.outputs.oidcIssuerUrl

@description('AKS kubelet identity objectId.')
output kubeletIdentityObjectId string = aksMod.outputs.kubeletIdentityObjectId

@description('AKS kubelet identity clientId (Trident ANF managedIdentityClientID).')
output kubeletIdentityClientId string = aksMod.outputs.kubeletIdentityClientId

@description('AKS cluster managed identity objectId (LoadBalancer / cross-RG PIP).')
output clusterIdentityObjectId string = aksMod.outputs.clusterIdentityObjectId

@description('ANF account name.')
output anfAccountName string = anfMod.outputs.anfAccountName

@description('Primary ANF capacity pool name (first entry in anf.pools).')
output anfPoolName string = anf.pools[0].name

@description('VNet name for Trident backend.')
output vnetName string = networking.vnetName

@description('ANF delegated subnet name for Trident backend.')
output anfSubnetName string = networking.anfSubnetName

@description('Container registry login server (shared or stack-created).')
output acrLoginServer string = useSharedAcr ? containerRegistry.loginServer : acrMod!.outputs.loginServer

@description('Key Vault URI.')
output keyVaultUri string = keyVaultMod.outputs.keyVaultUri

@description('Gateway public IP name for edge Helm (azure-pip-name annotation).')
output gatewayPipName string = createGatewayPip ? gatewayPipMod!.outputs.pipName : ''

@description('Gateway public IP address.')
output gatewayIpAddress string = createGatewayPip ? gatewayPipMod!.outputs.ipAddress : ''

@description('ANF delegated subnet ID (for Trident backend virtualNetwork).')
output anfSubnetId string = networkingMod.outputs.anfSubnetId

@description('Azure DNS zone name when createZone=true.')
output dnsZoneName string = (createDnsZone && createGatewayPip) ? dnsZoneMod!.outputs.zoneName : ''
