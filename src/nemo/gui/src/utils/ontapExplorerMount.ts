import type { ExplorerNode } from '../services/api'
import type { BucketFormData } from '../types/bucket'
import { initialBucketFormData } from '../types/bucket'

/** Hostname from ONTAP management URL (fallback when REST did not return a data LIF). */
export function hostFromClusterUrl(clusterUrl: string): string {
  try {
    const u = new URL(clusterUrl.trim())
    return u.hostname || ''
  } catch {
    return ''
  }
}

/** Prefer SVM NFS data LIF from explorer metadata (`nfs_data_lif`), else management host. */
export function nfsEndpointHostFromVolumeNode(clusterUrl: string, node: ExplorerNode): string {
  const meta = node.metadata || {}
  const lif = typeof meta.nfs_data_lif === 'string' ? meta.nfs_data_lif.trim() : ''
  if (lif) return lif
  return hostFromClusterUrl(clusterUrl) || '<nfs-server>'
}

export interface OntapVolumeMountDraft {
  /** Suggested `volume_info.endpoint` for static NFS (verify SVM data LIF / export). */
  nfsEndpoint: string
  notes: string
  /** Partial shape aligned with project volume (bucket) create — paste or adapt in Storage UI. */
  bucketVolumeConfigSnippet: Record<string, unknown>
}

/** Default resilience options merged with NFS `vers=` (plan: soft, timeo, retrans, noac). */
const DEFAULT_NFS_OPTS = ['soft', 'timeo=50', 'retrans=3', 'noac'] as const

/** Build `vers=` from adapter `nfs_protocols` / `suggested_nfs_vers` metadata. */
export function nfsVersMountOptionsFromNode(node: ExplorerNode): string[] {
  const meta = node.metadata || {}
  const suggested =
    typeof meta.suggested_nfs_vers === 'string' && meta.suggested_nfs_vers.trim()
      ? meta.suggested_nfs_vers.trim()
      : ''
  if (suggested) {
    return [...DEFAULT_NFS_OPTS, suggested]
  }
  const p = meta.nfs_protocols as { v3?: boolean; v40?: boolean; v41?: boolean } | undefined
  if (p?.v3) return [...DEFAULT_NFS_OPTS, 'vers=3']
  if (p?.v41) return [...DEFAULT_NFS_OPTS, 'vers=4.1']
  if (p?.v40) return [...DEFAULT_NFS_OPTS, 'vers=4.0']
  return [...DEFAULT_NFS_OPTS, 'vers=3']
}

export interface OntapMountValidation {
  ok: boolean
  blocking: string[]
  warnings: string[]
}

/**
 * Read adapter-computed `mount_preflight` on a volume node.
 * Used to block Register Volume when the volume cannot mount (no LIF, NFS down, TCP refused, etc.).
 */
export function validateOntapVolumeMountReady(node: ExplorerNode): OntapMountValidation {
  const meta = node.metadata || {}
  const mp = meta.mount_preflight as { can_mount?: boolean; blocking?: string[]; warnings?: string[] } | undefined
  const blocking = Array.isArray(mp?.blocking) ? [...mp.blocking] : []
  const warnings = Array.isArray(mp?.warnings) ? [...mp.warnings] : []
  const ok = mp?.can_mount === true && blocking.length === 0
  return { ok, blocking, warnings }
}

/**
 * Build a draft NFS mount / volume config from an explorer volume node and connector cluster URL.
 */
export function buildOntapVolumeMountDraft(clusterUrl: string, node: ExplorerNode): OntapVolumeMountDraft {
  const res = node.resource || {}
  const meta = node.metadata || {}
  const junction =
    typeof meta.junction_path === 'string' && meta.junction_path.trim() ? meta.junction_path.trim() : ''
  const svmName = typeof res.svm_name === 'string' ? res.svm_name : ''
  const volName = typeof res.volume_name === 'string' ? res.volume_name : ''
  const lifName = typeof meta.nfs_data_lif_name === 'string' ? meta.nfs_data_lif_name.trim() : ''
  const hostGuess = nfsEndpointHostFromVolumeNode(clusterUrl, node)
  const pathPart = junction || (volName ? `/${volName}` : '/')
  const nfsEndpoint = `${hostGuess}:${pathPart.startsWith('/') ? pathPart : `/${pathPart}`}`

  const fromApi = typeof meta.nfs_data_lif === 'string' && meta.nfs_data_lif.trim().length > 0
  const mountOpts = nfsVersMountOptionsFromNode(node)
  const versNote = mountOpts.find((o) => o.startsWith('vers=')) || 'vers=3'

  const notes = [
    'This is a draft for static NFS volume configuration.',
    svmName ? `SVM: ${svmName}` : null,
    fromApi
      ? `NFS data LIF from ONTAP: ${hostGuess}${lifName ? ` (${lifName})` : ''}`
      : 'No data_nfs LIF returned for this SVM; using cluster management host — set endpoint to your SVM data LIF if needed.',
    junction ? `Junction path from ONTAP: ${junction}` : null,
    `Suggested mount options include ${versNote} (plus soft, timeo, retrans, noac).`,
  ]
    .filter(Boolean)
    .join(' ')

  return {
    nfsEndpoint,
    notes,
    bucketVolumeConfigSnippet: {
      name: volName ? `ontap-${volName}`.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase() : 'ontap-volume',
      protocol: 'nfs',
      volume_info: {
        type: 'nfs',
        endpoint: nfsEndpoint,
        mount_options: mountOpts,
        provisioning_mode: 'static',
      },
      auth_info: {
        type: 'none',
      },
    },
  }
}

export interface OntapPrefillOptions {
  /** Explorer connector data source id — required for server-side preflight / repair. */
  connectorId?: string
}

/**
 * Values for the project **Register Volume** wizard (static NFS), prefilled from an ONTAP explorer node.
 */
export function bucketFormPrefillFromOntapVolume(
  clusterUrl: string,
  node: ExplorerNode,
  options?: OntapPrefillOptions
): BucketFormData {
  const d = buildOntapVolumeMountDraft(clusterUrl, node)
  const res = node.resource || {}
  const volName = typeof res.volume_name === 'string' ? res.volume_name : ''
  const slug = (d.bucketVolumeConfigSnippet.name as string) || 'ontap-volume'
  const meta = node.metadata || {}
  const mp = meta.mount_preflight

  const metaObj: Record<string, unknown> = {
    source: 'ontap-connector-explorer',
    ontap_cluster_url: clusterUrl,
    svm_name: res.svm_name,
    svm_uuid: res.svm_uuid,
    volume_uuid: res.volume_uuid,
    volume_name: volName,
    junction_path:
      node.metadata && typeof node.metadata.junction_path === 'string'
        ? node.metadata.junction_path
        : undefined,
    nfs_data_lif: node.metadata && typeof node.metadata.nfs_data_lif === 'string' ? node.metadata.nfs_data_lif : undefined,
    nfs_data_lif_name:
      node.metadata && typeof node.metadata.nfs_data_lif_name === 'string'
        ? node.metadata.nfs_data_lif_name
        : undefined,
    connector_id: options?.connectorId,
    mount_preflight: mp,
    export_policy_name: meta.export_policy_name,
    export_policy_rules: meta.export_policy_rules,
    nfs_protocols: meta.nfs_protocols,
    suggested_nfs_vers: meta.suggested_nfs_vers,
    nfs_service_enabled: meta.nfs_service_enabled,
    nfs_service_state: meta.nfs_service_state,
    tcp_2049_ok: meta.tcp_2049_ok,
    tcp_2049_error: meta.tcp_2049_error,
    tcp_2049: meta.tcp_2049,
  }

  return {
    ...initialBucketFormData,
    name: slug,
    region: 'Auto',
    protocol: 'NFS',
    provisioningMode: 'static',
    volumeType: 'NFS',
    volumeEndpoint: d.nfsEndpoint,
    mountOptions: nfsVersMountOptionsFromNode(node),
    storageClassName: undefined,
    storageSize: undefined,
    volumeParameters: [],
    authType: '',
    authUsername: '',
    authPassword: '',
    metadata: JSON.stringify(metaObj, null, 2),
  }
}
