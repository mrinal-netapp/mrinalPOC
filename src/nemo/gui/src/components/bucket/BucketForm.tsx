import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  DialogTrigger,
  Input,
  Field,
  Button,
  Badge,
  Text,
  Dropdown,
  Option,
  MessageBar,
  MessageBarBody,
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  TabList,
  Tab,
  Spinner,
} from '@fluentui/react-components'
import { Dismiss24Regular, Add24Regular } from '@fluentui/react-icons'
import { BucketFormData, initialBucketFormData } from '../../types/bucket'
import { Bucket, StorageClass, storageClassApi, deploymentApi } from '../../services/api'
import { validateBucketName, getBucketNameError } from '../../utils/bucketNameValidation'
import { inferVolumeConfigFromStorageClass } from '../../utils/bucketForm'
import styles from '../../styles/bucketForm.module.css'

interface BucketFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: BucketFormData) => Promise<void>
  onCancel: () => void
  initialData?: BucketFormData
  editingBucket?: Bucket | null
  submitting: boolean
  title: string
  submitLabel: string
}

export function BucketForm({
  open,
  onOpenChange,
  onSubmit,
  onCancel,
  initialData = initialBucketFormData,
  editingBucket,
  submitting,
  title,
  submitLabel,
}: BucketFormProps) {
  const [formData, setFormData] = useState<BucketFormData>(initialData)
  const [mountOptionInput, setMountOptionInput] = useState('')
  const [authExpanded, setAuthExpanded] = useState(false)
  const [metadataExpanded, setMetadataExpanded] = useState(false)
  const [metadataKeyInput, setMetadataKeyInput] = useState('')
  const [metadataValueInput, setMetadataValueInput] = useState('')
  // NEW: StorageClass and volume parameters state
  const [storageClasses, setStorageClasses] = useState<StorageClass[]>([])
  const [loadingStorageClasses, setLoadingStorageClasses] = useState(false)
  const [volumeParamsExpanded, setVolumeParamsExpanded] = useState(false)
  const [volumeParamKey, setVolumeParamKey] = useState('')
  const [volumeParamValue, setVolumeParamValue] = useState('')
  const [bucketNameError, setBucketNameError] = useState<string | undefined>(undefined)
  
  // Region state (populated from deployments)
  const [regions, setRegions] = useState<string[]>([])

  // Parse metadata from JSON string to key-value pairs
  const metadataPairs = useMemo(() => {
    if (!formData.metadata.trim()) {
      return []
    }
    try {
      const parsed = JSON.parse(formData.metadata)
      return Object.entries(parsed).map(([key, value]) => ({
        key,
        value: String(value),
      }))
    } catch {
      return []
    }
  }, [formData.metadata])

  const ontapExportPolicyWarning = useMemo(() => {
    if (!formData.metadata.trim()) return null
    try {
      const m = JSON.parse(formData.metadata) as Record<string, unknown>
      if (m.source !== 'ontap-connector-explorer') return null
      const mp = m.mount_preflight as { warnings?: string[] } | undefined
      const warnings = Array.isArray(mp?.warnings) ? mp.warnings : []
      const policy = typeof m.export_policy_name === 'string' ? m.export_policy_name : ''
      const rules = m.export_policy_rules
      if (!policy && !warnings.length && !Array.isArray(rules)) return null
      return { policy, rules, warnings }
    } catch {
      return null
    }
  }, [formData.metadata])

  // Fetch deployments and extract unique regions
  const fetchDeployments = useCallback(async () => {
    try {
      const deploymentList = await deploymentApi.list()
      
      // Extract unique regions from deployments
      const uniqueRegions = Array.from(
        new Set(deploymentList.map(d => d.region).filter(region => region && region.trim() !== ''))
      ).sort()
      
      setRegions(uniqueRegions)
    } catch (error) {
      console.error('Failed to fetch deployments:', error)
      // Even if fetch fails, "Auto" option will still be available
      setRegions([])
    }
  }, [])

  // Reset form data when dialog opens or initialData changes
  useEffect(() => {
    if (open) {
      // Ensure region defaults to "Auto" if not set
      const formDataWithDefaultRegion = {
        ...initialData,
        region: initialData.region || 'Auto'
      }
      setFormData(formDataWithDefaultRegion)
      setMountOptionInput('')
      setAuthExpanded(false)
      // Metadata accordion collapsed by default
      setMetadataExpanded(false)
      setMetadataKeyInput('')
      setMetadataValueInput('')
      setVolumeParamsExpanded(false)
      setVolumeParamKey('')
      setVolumeParamValue('')
      setBucketNameError(undefined)
      // Fetch deployments to populate regions
      fetchDeployments()
    }
  }, [open, initialData, fetchDeployments])

  // NEW: Fetch StorageClasses when dynamic mode is selected
  useEffect(() => {
    if (formData.provisioningMode === 'dynamic' && storageClasses.length === 0 && open) {
      fetchStorageClasses()
    }
  }, [formData.provisioningMode, open])

  // NEW: Fetch StorageClasses function
  const fetchStorageClasses = async () => {
    setLoadingStorageClasses(true)
    try {
      const classes = await storageClassApi.list()
      setStorageClasses(classes)
    } catch (error) {
      console.error('Failed to fetch StorageClasses:', error)
      // Allow manual entry if API fails
    } finally {
      setLoadingStorageClasses(false)
    }
  }

  // NEW: Add volume parameter
  const addVolumeParameter = () => {
    if (volumeParamKey.trim() && volumeParamValue.trim()) {
      const newParams = [
        ...(formData.volumeParameters || []),
        { key: volumeParamKey.trim(), value: volumeParamValue.trim() }
      ]
      setFormData({ ...formData, volumeParameters: newParams })
      setVolumeParamKey('')
      setVolumeParamValue('')
    }
  }

  // NEW: Remove volume parameter
  const removeVolumeParameter = (index: number) => {
    const newParams = (formData.volumeParameters || []).filter((_, i) => i !== index)
    setFormData({ ...formData, volumeParameters: newParams })
  }

  const handleSubmit = async () => {
    // Validate bucket name if not editing
    if (!editingBucket) {
      const validation = validateBucketName(formData.name)
      if (!validation.valid) {
        setBucketNameError(validation.error)
        return
      }
    }
    
    setBucketNameError(undefined)
    // Validate based on provisioning mode
    if (formData.provisioningMode === 'dynamic') {
      if (!formData.storageClassName) {
        // Show error: Storage Class is required
        alert('Storage Class is required for dynamic provisioning')
        return
      }
      if (!formData.storageSize) {
        // Show error: Storage Size is required
        alert('Storage Size is required for dynamic provisioning')
        return
      }
      // Validate storage size format
      const sizePattern = /^\d+[KMGTPE]i?$/
      if (!sizePattern.test(formData.storageSize)) {
        alert('Storage Size must be in format: <number><unit> (e.g., 10Gi, 100Gi)')
        return
      }
    } else {
      if (!formData.volumeEndpoint) {
        // Show error: Volume Endpoint is required
        alert('Volume Endpoint is required for static provisioning')
        return
      }
    }
    
    await onSubmit(formData)
  }

  const addMountOption = () => {
    if (mountOptionInput.trim()) {
      setFormData({
        ...formData,
        mountOptions: [...formData.mountOptions, mountOptionInput.trim()],
      })
      setMountOptionInput('')
    }
  }

  const removeMountOption = (index: number) => {
    setFormData({
      ...formData,
      mountOptions: formData.mountOptions.filter((_, i) => i !== index),
    })
  }

  const addMetadataPair = () => {
    if (metadataKeyInput.trim() && metadataValueInput.trim()) {
      const newPairs = [
        ...metadataPairs,
        { key: metadataKeyInput.trim(), value: metadataValueInput.trim() },
      ]
      const metadataObj = newPairs.reduce((acc, pair) => {
        acc[pair.key] = pair.value
        return acc
      }, {} as Record<string, string>)
      setFormData({
        ...formData,
        metadata: JSON.stringify(metadataObj, null, 2),
      })
      setMetadataKeyInput('')
      setMetadataValueInput('')
    }
  }

  const removeMetadataPair = (index: number) => {
    const newPairs = metadataPairs.filter((_, i) => i !== index)
    if (newPairs.length === 0) {
      setFormData({
        ...formData,
        metadata: '',
      })
    } else {
      const metadataObj = newPairs.reduce((acc, pair) => {
        acc[pair.key] = pair.value
        return acc
      }, {} as Record<string, string>)
      setFormData({
        ...formData,
        metadata: JSON.stringify(metadataObj, null, 2),
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface style={{ maxWidth: '800px', width: '90vw' }}>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <div className={styles.formSection}>
              <Text weight="semibold" style={{ marginBottom: '12px' }}>Volume Configuration</Text>
              
              {/* Provisioning Mode Tabs */}
              <TabList
                selectedValue={formData.provisioningMode}
                onTabSelect={(_, data) => {
                  const newMode = data.value as 'static' | 'dynamic'
                  const inferred = newMode === 'dynamic' ? inferVolumeConfigFromStorageClass(formData.storageClassName) : { volumeType: '', protocol: '' }
                  setFormData({ 
                    ...formData, 
                    provisioningMode: newMode,
                    volumeEndpoint: newMode === 'static' ? formData.volumeEndpoint : '',
                    storageClassName: newMode === 'dynamic' ? formData.storageClassName : undefined,
                    storageSize: newMode === 'dynamic' ? formData.storageSize : undefined,
                    volumeParameters: newMode === 'dynamic' ? formData.volumeParameters : [],
                    volumeType: newMode === 'dynamic' ? (formData.volumeType || inferred.volumeType) : formData.volumeType,
                    protocol: newMode === 'dynamic' ? (formData.protocol || inferred.protocol) : formData.protocol,
                  })
                }}
                style={{ marginBottom: '12px' }}
              >
                <Tab value="static">Existing Volume</Tab>
                <Tab value="dynamic">New Volume (Dynamic)</Tab>
              </TabList>

              {/* Static Provisioning Tab Content */}
              {formData.provisioningMode === 'static' && (
                <div style={{ padding: '8px 0' }}>
                  <div className={styles.formRow}>
                    <Field label="Volume Type" required={!editingBucket}>
                      <Dropdown
                        value={formData.volumeType}
                        onOptionSelect={(_, data) => {
                          if (data.optionValue) {
                            setFormData({ 
                              ...formData, 
                              volumeType: data.optionValue,
                              protocol: data.optionValue
                            })
                          }
                        }}
                        placeholder="Select volume type"
                      >
                        <Option value="NFS" text="NFS">NFS</Option>
                        <Option value="SMB" text="SMB">SMB</Option>
                      </Dropdown>
                    </Field>
                    
                    <Field label="Volume Endpoint" required={!editingBucket}>
                      <Input
                        value={formData.volumeEndpoint}
                        onChange={(_, data) => setFormData({ ...formData, volumeEndpoint: data.value })}
                        placeholder={formData.volumeType === 'NFS' 
                          ? "nfs://server/path or server:/path"
                          : "//smb-server/share or smb://server/share"}
                      />
                    </Field>
                  </div>
                  {formData.provisioningMode === 'static' && ontapExportPolicyWarning && (
                    <MessageBar intent="warning" style={{ marginTop: '12px' }}>
                      <MessageBarBody>
                        <Text weight="semibold" block>
                          Export policy / client access
                        </Text>
                        {ontapExportPolicyWarning.policy ? (
                          <Text size={200} block>
                            Export policy: <strong>{ontapExportPolicyWarning.policy}</strong>. Verify this policy allows your
                            Kubernetes worker node IPs (or a matching CIDR) for NFS.
                          </Text>
                        ) : null}
                        {Array.isArray(ontapExportPolicyWarning.rules) && ontapExportPolicyWarning.rules.length > 0 ? (
                          <Text size={200} block style={{ marginTop: '6px', fontFamily: 'monospace' }}>
                            Rules (summary): {JSON.stringify(ontapExportPolicyWarning.rules).slice(0, 500)}
                            {JSON.stringify(ontapExportPolicyWarning.rules).length > 500 ? '…' : ''}
                          </Text>
                        ) : null}
                        {ontapExportPolicyWarning.warnings.length > 0 ? (
                          <Text size={200} block style={{ marginTop: '6px' }}>
                            {ontapExportPolicyWarning.warnings.join(' ')}
                          </Text>
                        ) : null}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              )}

              {/* Dynamic Provisioning Tab Content */}
              {formData.provisioningMode === 'dynamic' && (
                <div style={{ padding: '8px 0' }}>
                  <div className={styles.formRow}>
                    <Field label="Storage Class" required>
                      {loadingStorageClasses ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Spinner size="tiny" />
                          <Text size={300}>Loading...</Text>
                        </div>
                      ) : (
                        <Dropdown
                          value={formData.storageClassName || ''}
                          onOptionSelect={(_, data) => {
                            if (data.optionValue) {
                              const inferred = inferVolumeConfigFromStorageClass(data.optionValue)
                              setFormData({
                                ...formData,
                                storageClassName: data.optionValue,
                                volumeType: inferred.volumeType,
                                protocol: inferred.protocol,
                              })
                            }
                          }}
                          placeholder="Select StorageClass"
                        >
                          {storageClasses.map((sc) => (
                            <Option key={sc.name} value={sc.name} text={`${sc.name} (${sc.provisioner})`}>
                              {sc.name} ({sc.provisioner})
                            </Option>
                          ))}
                        </Dropdown>
                      )}
                      {!loadingStorageClasses && storageClasses.length === 0 && (
                        <Text size={300} style={{ marginTop: '4px', color: 'var(--colorWarningForeground1)' }}>
                          No StorageClasses found
                        </Text>
                      )}
                    </Field>

                    <Field label="Volume Type" required>
                      <Dropdown
                        value={formData.volumeType || ''}
                        onOptionSelect={(_, data) => {
                          if (data.optionValue) {
                            setFormData({
                              ...formData,
                              volumeType: data.optionValue,
                              protocol: data.optionValue,
                            })
                          }
                        }}
                        placeholder="Select volume type (auto-filled from StorageClass)"
                      >
                        <Option value="NFS" text="NFS">NFS</Option>
                        <Option value="SMB" text="SMB">SMB</Option>
                      </Dropdown>
                    </Field>

                    <Field label="Protocol" required>
                      <Dropdown
                        value={formData.protocol || ''}
                        onOptionSelect={(_, data) => {
                          if (data.optionValue) {
                            setFormData({ ...formData, protocol: data.optionValue })
                          }
                        }}
                        placeholder="Select protocol (auto-filled from StorageClass)"
                      >
                        <Option value="NFS" text="NFS">NFS</Option>
                        <Option value="SMB" text="SMB">SMB</Option>
                      </Dropdown>
                    </Field>
                    
                    <Field label="Storage Size" required>
                      <Input
                        value={formData.storageSize || ''}
                        onChange={(_, data) => setFormData({ ...formData, storageSize: data.value })}
                        placeholder="10Gi, 100Gi, 1Ti"
                      />
                    </Field>
                  </div>

                  {/* Advanced Parameters Accordion (Dynamic) */}
                  <Accordion
                    collapsible
                    openItems={volumeParamsExpanded ? ['params'] : []}
                    onToggle={(_, data) => {
                      const isOpen = Array.isArray(data.openItems) 
                        ? data.openItems.includes('params') 
                        : data.openItems === 'params'
                      setVolumeParamsExpanded(isOpen)
                    }}
                    style={{ marginTop: '12px' }}
                  >
                    <AccordionItem value="params">
                      <AccordionHeader>Advanced Parameters (Optional)</AccordionHeader>
                      <AccordionPanel>
                        <div className={styles.metadataInputRow}>
                          <Field label="Key" style={{ flex: 1 }}>
                            <Input
                              value={volumeParamKey}
                              onChange={(_, data) => setVolumeParamKey(data.value)}
                              placeholder="e.g., type, iops"
                              onKeyPress={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  if (volumeParamValue.trim()) {
                                    addVolumeParameter()
                                  }
                                }
                              }}
                            />
                          </Field>
                          <Field label="Value" style={{ flex: 1 }}>
                            <Input
                              value={volumeParamValue}
                              onChange={(_, data) => setVolumeParamValue(data.value)}
                              placeholder="e.g., gp3, 3000"
                              onKeyPress={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  if (volumeParamKey.trim()) {
                                    addVolumeParameter()
                                  }
                                }
                              }}
                            />
                          </Field>
                          <Button
                            appearance="primary"
                            icon={<Add24Regular />}
                            onClick={addVolumeParameter}
                            disabled={!volumeParamKey.trim() || !volumeParamValue.trim()}
                            style={{ marginTop: '24px' }}
                          >
                            Add
                          </Button>
                        </div>
                        {(formData.volumeParameters || []).length > 0 && (
                          <div className={styles.metadataTagsContainer} style={{ marginTop: '12px' }}>
                            {(formData.volumeParameters || []).map((param, idx) => (
                              <div key={idx} className={styles.metadataTag}>
                                <Badge appearance="filled" color="brand" size="large">
                                  <span>{param.key}: {param.value}</span>
                                </Badge>
                                <Button
                                  appearance="subtle"
                                  icon={<Dismiss24Regular />}
                                  size="small"
                                  onClick={() => removeVolumeParameter(idx)}
                                  aria-label={`Remove parameter ${param.key}`}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </AccordionPanel>
                    </AccordionItem>
                  </Accordion>
                </div>
              )}

              <Text weight="semibold" style={{ marginTop: '20px', marginBottom: '12px' }}>Volume Details</Text>
              
              <div className={styles.formRow}>
                <Field 
                  label="Volume Name" 
                  required={!editingBucket}
                  validationMessage={bucketNameError}
                  validationState={bucketNameError ? 'error' : 'none'}
                >
                  <Input
                    value={formData.name}
                    onChange={(_, data) => {
                      const newName = data.value
                      setFormData({ ...formData, name: newName })
                      // Validate bucket name in real-time
                      if (!editingBucket) {
                        const error = getBucketNameError(newName)
                        setBucketNameError(error)
                      }
                    }}
                    onBlur={() => {
                      // Re-validate on blur
                      if (!editingBucket && formData.name) {
                        const error = getBucketNameError(formData.name)
                        setBucketNameError(error)
                      }
                    }}
                    placeholder="Enter volume name (e.g., my-volume-name)"
                    disabled={!!editingBucket}
                  />
                </Field>
                <Field label="Region" required={!editingBucket}>
                  <Dropdown
                    value={formData.region || 'Auto'}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {
                        setFormData({ ...formData, region: data.optionValue })
                      }
                    }}
                    placeholder="Select region"
                  >
                    <Option value="Auto" text="Auto">Auto</Option>
                    {regions.map((region) => (
                      <Option key={region} value={region} text={region}>
                        {region}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>

              {/* Mount Options - Available for both modes */}
              <Field label="Mount Options (Optional)" style={{ marginTop: '12px' }}>
                <div className={styles.mountOptionsList}>
                  <div className={styles.mountOptionInput}>
                    <Input
                      value={mountOptionInput}
                      onChange={(_, data) => setMountOptionInput(data.value)}
                      placeholder="e.g., noac, rsize, wsize"
                      onKeyPress={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addMountOption()
                        }
                      }}
                      style={{ flex: 1 }}
                    />
                    <Button onClick={addMountOption}>Add</Button>
                  </div>
                  {formData.mountOptions.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                      {formData.mountOptions.map((opt, idx) => (
                        <div key={idx} className={styles.mountOptionItem}>
                          <Badge appearance="outline">{opt}</Badge>
                          <Button appearance="subtle" size="small" onClick={() => removeMountOption(idx)}>
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Field>
              <Accordion
                collapsible
                openItems={authExpanded ? ['auth'] : []}
                onToggle={(_, data) => {
                  const isOpen = Array.isArray(data.openItems) ? data.openItems.includes('auth') : data.openItems === 'auth'
                  setAuthExpanded(isOpen)
                }}
              >
                <AccordionItem value="auth">
                  <AccordionHeader>Advanced: Authentication (Optional)</AccordionHeader>
                  <AccordionPanel>
                    <div className={styles.formRow}>
                      <Field label="Auth Type">
                        <Input
                          value={formData.authType}
                          onChange={(_, data) => setFormData({ ...formData, authType: data.value })}
                          placeholder="e.g., basic, aws"
                        />
                      </Field>
                      <Field label="Username">
                        <Input
                          value={formData.authUsername}
                          onChange={(_, data) => setFormData({ ...formData, authUsername: data.value })}
                          placeholder="Enter username"
                        />
                      </Field>
                    </div>
                    <Field label={editingBucket ? 'Password (leave blank to keep current)' : 'Password'}>
                      <Input
                        type="password"
                        value={formData.authPassword}
                        onChange={(_, data) => setFormData({ ...formData, authPassword: data.value })}
                        placeholder={editingBucket ? 'Enter new password' : 'Enter password'}
                      />
                    </Field>
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
              <Accordion
                collapsible
                openItems={metadataExpanded ? ['metadata'] : []}
                onToggle={(_, data) => {
                  const isOpen = Array.isArray(data.openItems) ? data.openItems.includes('metadata') : data.openItems === 'metadata'
                  setMetadataExpanded(isOpen)
                }}
              >
                <AccordionItem value="metadata">
                  <AccordionHeader>Metadata (Optional)</AccordionHeader>
                  <AccordionPanel>
                    <div className={styles.metadataSection}>
                      <Text size={300} style={{ marginBottom: '8px', color: 'var(--colorNeutralForeground2)' }}>
                        Add key-value pairs as metadata tags
                      </Text>
                      <div className={styles.metadataInputRow}>
                        <Field label="Key" style={{ flex: 1 }}>
                          <Input
                            value={metadataKeyInput}
                            onChange={(_, data) => setMetadataKeyInput(data.value)}
                            placeholder="Enter key"
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                if (metadataValueInput.trim()) {
                                  addMetadataPair()
                                }
                              }
                            }}
                          />
                        </Field>
                        <Field label="Value" style={{ flex: 1 }}>
                          <Input
                            value={metadataValueInput}
                            onChange={(_, data) => setMetadataValueInput(data.value)}
                            placeholder="Enter value"
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                if (metadataKeyInput.trim()) {
                                  addMetadataPair()
                                }
                              }
                            }}
                          />
                        </Field>
                        <Button
                          appearance="primary"
                          icon={<Add24Regular />}
                          onClick={addMetadataPair}
                          disabled={!metadataKeyInput.trim() || !metadataValueInput.trim()}
                          style={{ marginTop: '24px' }}
                        >
                          Add
                        </Button>
                      </div>
                      {metadataPairs.length > 0 && (
                        <div className={styles.metadataTagsContainer}>
                          {metadataPairs.map((pair, idx) => (
                            <div key={idx} className={styles.metadataTag}>
                              <Badge
                                appearance="filled"
                                color="brand"
                                size="large"
                                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                              >
                                <span className={styles.metadataTagKey}>{pair.key}</span>
                                <span className={styles.metadataTagSeparator}>:</span>
                                <span className={styles.metadataTagValue}>{pair.value}</span>
                              </Badge>
                              <Button
                                appearance="subtle"
                                icon={<Dismiss24Regular />}
                                size="small"
                                onClick={() => removeMetadataPair(idx)}
                                aria-label={`Remove ${pair.key}`}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                      {metadataPairs.length === 0 && (
                        <Text size={300} style={{ color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
                          No metadata tags added yet
                        </Text>
                      )}
                    </div>
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </DialogTrigger>
            <Button appearance="primary" onClick={handleSubmit} disabled={submitting}>
              {submitting ? (editingBucket ? 'Updating...' : 'Creating...') : submitLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}

