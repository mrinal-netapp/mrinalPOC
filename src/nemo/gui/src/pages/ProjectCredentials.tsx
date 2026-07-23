import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  Badge,
  Input,
  Field,
  Tooltip,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  DialogActions,
  Combobox,
  Option,
} from '@fluentui/react-components'
import {
  Add24Regular,
  Edit24Regular,
  Delete24Regular,
  Search24Regular,
  ShieldCheckmark24Regular,
  ArrowClockwise24Regular,
} from '@fluentui/react-icons'
import { credentialApi, Credential, CreateCredentialRequest, DependentsPage, getApiErrorMessage, getDependentsFromError } from '../services/api'
import { DependentsCell, DependentsBlockerList } from '../components/DependentsCell'
import { CredentialSecretFields } from '../components/CredentialSecretFields'
import { useToast } from '../contexts/ToastContext'
import { PROVIDER_OPTIONS, PROVIDER_PRESETS } from '../constants/providerPresets'
import { normalizeProviderSecretData } from '../utils/gcpServiceAccountJson'

const useStyles = makeStyles({
  container: { display: 'flex', flexDirection: 'column', gap: '16px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: '24px', fontWeight: 600, color: tokens.colorNeutralForeground1 },
})

const providerBadgeColor: Record<string, 'informative' | 'success' | 'warning' | 'severe'> = {
  postgresql: 'informative',
  mysql: 'informative',
  s3: 'success',
  gcs: 'warning',
  openai: 'informative',
  openai_compatible: 'informative',
  aws_bedrock: 'success',
  azure: 'warning',
  google: 'severe',
  tavily: 'informative',
}

function toDateInput(value?: string): string {
  return value ? new Date(value).toISOString().slice(0, 10) : ''
}

function daysToExpiry(expiresAt?: string): number | null {
  if (!expiresAt) return null
  const end = new Date(expiresAt).getTime()
  const now = Date.now()
  return Math.ceil((end - now) / (1000 * 60 * 60 * 24))
}

export default function ProjectCredentials() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const { showToast } = useToast()

  const [credentials, setCredentials] = useState<Credential[]>([])
  const [filteredCredentials, setFilteredCredentials] = useState<Credential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingCredential, setEditingCredential] = useState<Credential | null>(null)
  const [showRotateDialog, setShowRotateDialog] = useState(false)
  const [rotatingCredential, setRotatingCredential] = useState<Credential | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [rotateError, setRotateError] = useState<string | null>(null)

  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formProvider, setFormProvider] = useState<string>('postgresql')
  const [formSecretData, setFormSecretData] = useState<Record<string, string>>({})
  const [formMetadata, setFormMetadata] = useState<Record<string, string>>({})
  const [formLabels, setFormLabels] = useState('')
  const [formExpiresAt, setFormExpiresAt] = useState('')

  const [rotateSecretData, setRotateSecretData] = useState<Record<string, string>>({})
  const [rotateExpiresAt, setRotateExpiresAt] = useState('')

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [credentialToDelete, setCredentialToDelete] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteBlockers, setDeleteBlockers] = useState<DependentsPage | null>(null)
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set())

  const loadCredentials = async () => {
    if (!projectId) return
    try {
      setLoading(true)
      setError(null)
      const data = await credentialApi.list(projectId)
      setCredentials(data)
      setFilteredCredentials(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load credentials')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCredentials()
  }, [projectId])

  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredCredentials(credentials)
      return
    }
    const query = searchQuery.toLowerCase()
    setFilteredCredentials(
      credentials.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.provider.toLowerCase().includes(query) ||
          (c.description || '').toLowerCase().includes(query)
      )
    )
  }, [searchQuery, credentials])

  const resetForm = () => {
    setFormName('')
    setFormDescription('')
    setFormProvider('postgresql')
    setFormSecretData({})
    setFormMetadata({})
    setFormLabels('')
    setFormExpiresAt('')
    setFormError(null)
    setEditingCredential(null)
  }

  const openCreateDialog = () => {
    resetForm()
    setShowCreateDialog(true)
  }

  const openEditDialog = (cred: Credential) => {
    setFormName(cred.name)
    setFormDescription(cred.description || '')
    setFormProvider(cred.provider)
    setFormLabels(cred.labels?.join(', ') || '')
    setFormMetadata((cred.metadata as Record<string, string>) || {})
    setFormExpiresAt(toDateInput(cred.expiresAt))
    setFormSecretData({})
    setFormError(null)
    setEditingCredential(cred)
    setShowCreateDialog(true)
  }

  const openRotateDialog = (cred: Credential) => {
    setRotatingCredential(cred)
    setRotateSecretData({})
    setRotateExpiresAt(toDateInput(cred.expiresAt))
    setRotateError(null)
    setShowRotateDialog(true)
  }

  const validateRequiredSecrets = (provider: string, secretData: Record<string, string>) => {
    const preset = PROVIDER_PRESETS[provider]
    if (preset) {
      const missing = preset.secretFields
        .filter((f) => f.required)
        .filter((f) => !secretData[f.key]?.trim())
      if (missing.length) {
        return `Required fields: ${missing.map((f) => f.label).join(', ')}`
      }
      return null
    }
    const hasAny = Object.entries(secretData).some(([k, v]) => k.trim() && v.trim())
    return hasAny ? null : 'Add at least one secret field'
  }

  const handleSubmit = async () => {
    if (!projectId) return
    if (!formName.trim()) return setFormError('Name is required')
    if (!formProvider.trim()) return setFormError('Provider is required')

    try {
      setSubmitting(true)
      setFormError(null)
      const labels = formLabels.trim() ? formLabels.split(',').map((l) => l.trim()).filter(Boolean) : undefined

      if (editingCredential) {
        await credentialApi.update(projectId, editingCredential.id, {
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          metadata: Object.keys(formMetadata).length ? formMetadata : undefined,
          labels,
          expiresAt: formExpiresAt || undefined,
        })
        showToast(`Credential "${formName}" updated`, 'success')
      } else {
        const secretError = validateRequiredSecrets(formProvider, formSecretData)
        if (secretError) return setFormError(secretError)

        const normalized = normalizeProviderSecretData(formProvider.trim(), formSecretData)
        if (!normalized.ok) return setFormError(normalized.message)

        const req: CreateCredentialRequest = {
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          provider: formProvider.trim(),
          metadata: Object.keys(formMetadata).length ? formMetadata : undefined,
          labels,
          expiresAt: formExpiresAt || undefined,
          secretData: normalized.secretData,
        }
        await credentialApi.create(projectId, req)
        showToast(`Credential "${formName}" created`, 'success')
      }

      setShowCreateDialog(false)
      resetForm()
      loadCredentials()
    } catch (err: any) {
      setFormError(err.response?.data?.error || err.message || 'Operation failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRotate = async () => {
    if (!projectId || !rotatingCredential) return
    const secretError = validateRequiredSecrets(rotatingCredential.provider, rotateSecretData)
    if (secretError) return setRotateError(secretError)
    const normalizedRotate = normalizeProviderSecretData(rotatingCredential.provider, rotateSecretData)
    if (!normalizedRotate.ok) return setRotateError(normalizedRotate.message)
    try {
      setSubmitting(true)
      setRotateError(null)
      await credentialApi.rotate(projectId, rotatingCredential.id, {
        secretData: normalizedRotate.secretData,
        expiresAt: rotateExpiresAt || undefined,
      })
      showToast(`Credential "${rotatingCredential.name}" rotated`, 'success')
      setShowRotateDialog(false)
      setRotatingCredential(null)
      loadCredentials()
    } catch (err: any) {
      setRotateError(err.response?.data?.error || err.message || 'Rotation failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteClick = (id: string, name: string) => {
    setCredentialToDelete({ id, name })
    setDeleteBlockers(null)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!projectId || !credentialToDelete) return
    try {
      setDeleting(true)
      await credentialApi.delete(projectId, credentialToDelete.id)
      showToast(`Credential "${credentialToDelete.name}" deleted`, 'success')
      setDeleteDialogOpen(false)
      setCredentialToDelete(null)
      setDeleteBlockers(null)
      loadCredentials()
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Failed to delete credential')
      const blockers = getDependentsFromError(err)
      if (blockers) {
        setDeleteBlockers(blockers)
        showToast(msg, 'warning')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setDeleting(false)
    }
  }

  const handleValidate = async (cred: Credential) => {
    if (!projectId) return
    setValidatingIds((prev) => new Set(prev).add(cred.id))
    try {
      const result = await credentialApi.validate(projectId, cred.id)
      if (result.valid) showToast(`Credential "${cred.name}" is valid`, 'success')
      else showToast(result.error || `Credential "${cred.name}" validation failed`, 'error')
    } catch (err: any) {
      showToast(err.message || 'Validation failed', 'error')
    } finally {
      setValidatingIds((prev) => {
        const next = new Set(prev)
        next.delete(cred.id)
        return next
      })
    }
  }

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}><Spinner label="Loading credentials..." /></div>
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Credentials</h1>
        <Button appearance="primary" icon={<Add24Regular />} onClick={openCreateDialog}>Create Credential</Button>
      </div>

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', paddingBottom: '0' }}>
          <Search24Regular />
          <Input placeholder="Search credentials..." value={searchQuery} onChange={(_, data) => setSearchQuery(data.value)} style={{ flex: 1 }} />
        </div>
        {filteredCredentials.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <Text size={300} style={{ color: tokens.colorNeutralForeground3 }}>
              {credentials.length === 0 ? 'No credentials yet. Create one to get started.' : 'No credentials match your search.'}
            </Text>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Provider</TableHeaderCell>
                <TableHeaderCell>Description</TableHeaderCell>
                <TableHeaderCell>Expiry</TableHeaderCell>
                <TableHeaderCell>Version</TableHeaderCell>
                <TableHeaderCell>Used by</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCredentials.map((cred) => {
                const isValidating = validatingIds.has(cred.id)
                const days = daysToExpiry(cred.expiresAt)
                const expiryColor = days == null ? 'informative' : days < 0 ? 'severe' : days <= 30 ? 'warning' : 'success'
                return (
                  <TableRow key={cred.id}>
                    <TableCell><Text weight="semibold">{cred.name}</Text></TableCell>
                    <TableCell>
                      <Badge appearance="outline" color={providerBadgeColor[cred.provider] || 'informative'} size="small">
                        {PROVIDER_PRESETS[cred.provider]?.label || cred.provider}
                      </Badge>
                    </TableCell>
                    <TableCell><Text size={200}>{cred.description || '-'}</Text></TableCell>
                    <TableCell>
                      {cred.expiresAt ? (
                        <Badge appearance="tint" color={expiryColor} size="small">
                          {new Date(cred.expiresAt).toLocaleDateString()}
                        </Badge>
                      ) : <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>-</Text>}
                    </TableCell>
                    <TableCell><Text size={200}>{cred.rotationVersion || 1}</Text></TableCell>
                    <TableCell>
                      {projectId && (
                        <DependentsCell
                          projectId={projectId}
                          targetKind="credential"
                          targetId={cred.id}
                          summary={cred.dependentsSummary}
                        />
                      )}
                    </TableCell>
                    <TableCell><Text size={200}>{new Date(cred.createdAt).toLocaleDateString()}</Text></TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <Tooltip content="Validate credential" relationship="label">
                          <Button appearance="subtle" size="small" icon={isValidating ? <Spinner size="tiny" /> : <ShieldCheckmark24Regular />} onClick={() => handleValidate(cred)} disabled={isValidating} />
                        </Tooltip>
                        <Button appearance="subtle" size="small" icon={<Edit24Regular />} onClick={() => openEditDialog(cred)} title="Edit Credential" />
                        <Button appearance="subtle" size="small" icon={<ArrowClockwise24Regular />} onClick={() => openRotateDialog(cred)} title="Rotate Secrets" />
                        <Button appearance="subtle" size="small" icon={<Delete24Regular />} onClick={() => handleDeleteClick(cred.id, cred.name)} title="Delete Credential" />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={showCreateDialog} onOpenChange={(_, data) => { if (!data.open) { setShowCreateDialog(false); resetForm() } }}>
        <DialogSurface style={{ maxWidth: '620px' }}>
          <DialogTitle>{editingCredential ? 'Edit Credential' : 'Create Credential'}</DialogTitle>
          <DialogBody>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {formError && <MessageBar intent="error"><MessageBarBody>{formError}</MessageBarBody></MessageBar>}
                <Field label="Name" required><Input value={formName} onChange={(_, d) => setFormName(d.value)} disabled={submitting} /></Field>
                <Field label="Description"><Input value={formDescription} onChange={(_, d) => setFormDescription(d.value)} disabled={submitting} /></Field>
                {editingCredential ? (
                  <Field label="Provider"><Text size={300} weight="semibold" style={{ padding: '6px 0' }}>{editingCredential.provider}</Text></Field>
                ) : (
                  <Field label="Provider" required>
                    <Combobox
                      freeform
                      value={formProvider}
                      selectedOptions={[formProvider]}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) {
                          setFormProvider(data.optionValue)
                          setFormSecretData({})
                          setFormMetadata({})
                        }
                      }}
                      onChange={(e) => setFormProvider((e.target as HTMLInputElement).value)}
                      placeholder="Select or type provider key"
                      disabled={submitting}
                    >
                      {PROVIDER_OPTIONS.map((opt) => (
                        <Option key={opt.value} value={opt.value} text={`${opt.category} · ${opt.label} (${opt.value})`}>
                          {`${opt.category} · ${opt.label} (${opt.value})`}
                        </Option>
                      ))}
                    </Combobox>
                  </Field>
                )}
                {!editingCredential && (
                  <CredentialSecretFields
                    provider={formProvider}
                    secretData={formSecretData}
                    onChange={setFormSecretData}
                    metadata={formMetadata}
                    onMetadataChange={setFormMetadata}
                    disabled={submitting}
                  />
                )}
                {editingCredential && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        Secret data cannot be viewed in edit mode. Use Rotate Secrets to update secret values.
                      </MessageBarBody>
                    </MessageBar>
                    {PROVIDER_PRESETS[formProvider]?.metadataFields?.map((field) => (
                      <Field key={field.key} label={field.label} required={field.required}>
                        <Input
                          value={formMetadata[field.key] || ''}
                          onChange={(_, d) => setFormMetadata({ ...formMetadata, [field.key]: d.value })}
                          placeholder={field.placeholder}
                          disabled={submitting}
                        />
                      </Field>
                    ))}
                  </>
                )}
                <Field label="Expires On (optional)">
                  <Input type="date" value={formExpiresAt} onChange={(_, d) => setFormExpiresAt(d.value)} disabled={submitting} />
                </Field>
                <Field label="Labels (optional)">
                  <Input value={formLabels} onChange={(_, d) => setFormLabels(d.value)} placeholder="label1, label2" disabled={submitting} />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => { setShowCreateDialog(false); resetForm() }} disabled={submitting}>Cancel</Button>
              <Button appearance="primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? (editingCredential ? 'Updating...' : 'Creating...') : (editingCredential ? 'Update Credential' : 'Create Credential')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={showRotateDialog} onOpenChange={(_, data) => { if (!data.open) setShowRotateDialog(false) }}>
        <DialogSurface style={{ maxWidth: '620px' }}>
          <DialogTitle>Rotate Secrets{rotatingCredential ? `: ${rotatingCredential.name}` : ''}</DialogTitle>
          <DialogBody>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {rotateError && <MessageBar intent="error"><MessageBarBody>{rotateError}</MessageBarBody></MessageBar>}
                {rotatingCredential && (
                  <>
                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                      The credential ID stays unchanged. Referencing MCP servers, connectors, and models will use the new secret values.
                    </Text>
                    <CredentialSecretFields
                      provider={rotatingCredential.provider}
                      secretData={rotateSecretData}
                      onChange={setRotateSecretData}
                      disabled={submitting}
                    />
                    <Field label="New Expiry (optional)">
                      <Input type="date" value={rotateExpiresAt} onChange={(_, d) => setRotateExpiresAt(d.value)} disabled={submitting} />
                    </Field>
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setShowRotateDialog(false)} disabled={submitting}>Cancel</Button>
              <Button appearance="primary" onClick={handleRotate} disabled={submitting}>Rotate Secrets</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) {
          setCredentialToDelete(null)
          setDeleteBlockers(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Delete Credential</DialogTitle>
          <DialogBody>
            <DialogContent>
              {deleteBlockers ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Text>
                    Cannot delete credential &quot;{credentialToDelete?.name}&quot; while it is still in use by:
                  </Text>
                  {projectId && (
                    <DependentsBlockerList projectId={projectId} page={deleteBlockers} />
                  )}
                  <Text style={{ marginTop: 4, color: tokens.colorNeutralForeground2 }}>
                    Update or remove these references, then try deleting again.
                  </Text>
                </div>
              ) : (
                <Text>
                  Are you sure you want to delete credential &quot;{credentialToDelete?.name}&quot;? Any connectors, MCP servers, and models using this credential may lose access.
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
                {deleteBlockers ? 'Close' : 'Cancel'}
              </Button>
              {!deleteBlockers && (
                <Button appearance="primary" onClick={handleDeleteConfirm} disabled={deleting}>{deleting ? 'Deleting...' : 'Delete'}</Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
