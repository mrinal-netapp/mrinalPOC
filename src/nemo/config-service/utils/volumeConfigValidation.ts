/**
 * Volume config rules enforced on data source update (and unit-tested).
 * Express validators on create do not require volume_info.endpoint; static NFS
 * export paths are required here on PUT and again in storage-manager sync.
 */

export type VolumeConfigLike = {
  volume_info?: {
    provisioning_mode?: string;
    storage_class_name?: string;
    endpoint?: string;
    type?: string;
  };
};

/**
 * Returns an error message when a volume_config patch is invalid, or null if OK.
 */
export function validateVolumeConfigUpdate(
  patch: VolumeConfigLike | undefined,
  current: VolumeConfigLike | undefined,
): string | null {
  if (!patch?.volume_info) {
    return null;
  }
  const vi = patch.volume_info;
  if (vi.provisioning_mode === 'dynamic') {
    if (!vi.storage_class_name && !current?.volume_info?.storage_class_name) {
      return 'storage_class_name is required for dynamic provisioning';
    }
  }
  const currentMode = current?.volume_info?.provisioning_mode;
  const treatAsStatic =
    vi.provisioning_mode === 'static' ||
    (!vi.provisioning_mode && currentMode !== 'dynamic');
  if (treatAsStatic) {
    if (vi.endpoint === undefined && !current?.volume_info?.endpoint) {
      return 'volume_info.endpoint is required for static provisioning';
    }
  }
  return null;
}
