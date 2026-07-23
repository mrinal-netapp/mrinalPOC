import { useCallback, useState, type ReactElement } from "react";
import { useNavigate, useBlocker } from "react-router";
import { IconX } from "@tabler/icons-react";

import type { Credential, CredentialCreateRequest, CredentialUpdateRequest } from "../credential.types";
import { useCreateCredentialMutation, useUpdateCredentialMutation } from "../credential-api.slice";
import {
  buildCredentialCreateBody,
  parseCredentialLabels,
  validateCredentialSecretFields,
} from "../credential-create.helpers";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { Button } from "@/ui-lib/base-components/button/button";
import { Input } from "@/ui-lib/base-components/input/input";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { CredentialSecretFields } from "@/components/credential-secret-fields/credential-secret-fields";
import { PROVIDER_OPTIONS, PROVIDER_PRESETS } from "@/constants/providerPresets";
import { credentialPaths } from "../credentials.consts";
import "./credential-form.scss";

// -- Props --

interface CredentialFormProps {
  isEdit?: boolean;
  initialData?: Credential;
}

// -- Helpers --

function toDateInputValue(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}

function toIsoString(dateInput: string): string | undefined {
  if (!dateInput) return undefined;
  return new Date(dateInput).toISOString();
}

function labelsToString(labels?: string[]): string {
  return (labels ?? []).join(", ");
}

function parseLabelsForEdit(input: string): string[] {
  return input
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

const PROVIDER_ITEMS = PROVIDER_OPTIONS.map((opt) => ({
  key: opt.value,
  value: opt.value,
  label: opt.label,
  sublabel: opt.category,
}));

// -- Component --

function CredentialForm({ isEdit = false, initialData }: CredentialFormProps): ReactElement {
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const [createCredential, { isLoading: isCreating }] = useCreateCredentialMutation();
  const [updateCredential, { isLoading: isUpdating }] = useUpdateCredentialMutation();

  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [provider, setProvider] = useState(initialData?.provider ?? "openai");
  const [secretData, setSecretData] = useState<Record<string, string>>({});
  const [metadata, setMetadata] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(initialData?.metadata ?? {}).map(([k, v]) => [k, String(v ?? "")]),
    ),
  );
  const [expiresAt, setExpiresAt] = useState(toDateInputValue(initialData?.expiresAt));
  const [labelsInput, setLabelsInput] = useState(labelsToString(initialData?.labels));

  const [isDirty, setIsDirty] = useState(false);
  const markDirty = useCallback(() => setIsDirty(true), []);

  const isSubmitting = isCreating || isUpdating;
  const pageTitle = isEdit ? "Edit credential" : "Add credential";
  const submitLabel = isEdit ? "Save" : "Add";

  const navigateBack = useCallback(() => {
    navigate(credentialPaths.root);
  }, [navigate]);

  const validate = (): string | null => {
    if (!name.trim()) return "Name is required";
    if (!isEdit && !provider.trim()) return "Provider is required";
    return null;
  };

  const validateSecretFields = (): string | null =>
    validateCredentialSecretFields(provider, secretData);

  const handleSubmit = async (): Promise<void> => {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }

    if (!isEdit) {
      const secretErr = validateSecretFields();
      if (secretErr) {
        toast.error(secretErr);
        return;
      }
    }

    const labels = isEdit ? parseLabelsForEdit(labelsInput) : parseCredentialLabels(labelsInput);
    const expiresAtIso = toIsoString(expiresAt);

    try {
      if (isEdit && initialData) {
        const body: CredentialUpdateRequest = {
          name: name.trim(),
          description: description.trim() || undefined,
          metadata: Object.keys(metadata).length ? metadata : undefined,
          labels,
          expiresAt: expiresAtIso,
        };
        await updateCredential({ projectId, id: initialData.id, body }).unwrap();
        toast.success("Credential updated successfully.");
      } else {
        const prepared = buildCredentialCreateBody(provider.trim(), name, secretData, {
          labels: labelsInput,
          description,
        });
        if (!prepared.ok) {
          toast.error(prepared.message);
          return;
        }
        const body: CredentialCreateRequest = {
          ...prepared.body,
          metadata: Object.keys(metadata).length ? metadata : undefined,
          expiresAt: expiresAtIso,
        };
        await createCredential({ projectId, body }).unwrap();
        toast.success("Credential added successfully.");
      }
      setIsDirty(false);
      navigateBack();
    } catch {
      toast.error(isEdit ? "Failed to update credential." : "Failed to add credential.");
    }
  };

  const blocker = useBlocker(isDirty && !isSubmitting);
  const isBlocked = blocker.state === "blocked";

  // Metadata fields for the current provider (endpoint, region, etc.)
  const metadataFields = PROVIDER_PRESETS[provider]?.metadataFields ?? [];

  return (
    <div className="cred-form-page">
      {/* -- Top bar -- */}
      <div className="cred-form-page__top-bar">
        <Typography Component="h1" fontSize="fs16" boldness="semibold" className="cred-form-page__top-bar-title">
          {pageTitle}
        </Typography>
        <Button variant="icon" icon={<IconX size={20} />} onClick={navigateBack} aria-label="Close" />
      </div>

      {/* -- Scrollable body -- */}
      <div className="cred-form-page__body">
        <div className="cred-form-page__body-inner">
          <div className="cred-form-page__header">
            <Typography Component="h2" fontSize="fs20" boldness="semibold">
              Credential
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
              Credentials store provider-specific secrets — API keys, service account JSON, certificates, and other authentication material — and are referenced by models, data sources, and other resources.
            </Typography>
          </div>

          <Card className="cred-form-page__form-card">
            <CardContent>
              {/* -- Details section -- */}
              <CardBlock type="description" hasSeparator>
                <div className="cred-form__section">
                  <div className="cred-form__section-header">
                    <Typography Component="h3" fontSize="fs16" boldness="semibold" className="cred-form__section-title">
                      Details
                    </Typography>
                    <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="cred-form__section-subtitle">
                      Provide identifying information for this credential.
                    </Typography>
                  </div>

                  <div className="cred-form__fields">
                    {/* Name */}
                    <div className="cred-form__field">
                      <Input
                        label="Name"
                        value={name}
                        placeholder="e.g. my-openai-key"
                        isDisabled={isSubmitting}
                        onChange={(e) => { setName(e.target.value); markDirty(); }}
                      />
                    </div>

                    {/* Description */}
                    <div className="cred-form__field">
                      <Input
                        label="Description"
                        isOptional
                        value={description}
                        placeholder="Short description of this credential"
                        isDisabled={isSubmitting}
                        onChange={(e) => { setDescription(e.target.value); markDirty(); }}
                      />
                    </div>

                    {/* Labels — comma-separated plain text input */}
                    <div className="cred-form__field">
                      <Input
                        label="Labels"
                        isOptional
                        value={labelsInput}
                        placeholder="label1, label2, label3"
                        isDisabled={isSubmitting}
                        onChange={(e) => { setLabelsInput(e.target.value); markDirty(); }}
                      />
                    </div>

                    {/* Expires on */}
                    <div className="cred-form__field">
                      <div className="cred-form__field-label-area">
                        <Typography Component="label" fontSize="fs14" boldness="regular" htmlFor="cred-expires-input">
                          Expires on
                        </Typography>
                        <Typography Component="span" fontSize="fs12" boldness="regular" color="var(--text-secondary)">
                          (optional)
                        </Typography>
                      </div>
                      <input
                        id="cred-expires-input"
                        type="date"
                        className="cred-form__date-input"
                        value={expiresAt}
                        disabled={isSubmitting}
                        onChange={(e) => { setExpiresAt(e.target.value); markDirty(); }}
                      />
                    </div>
                  </div>
                </div>
              </CardBlock>

              {/* -- Provider & secrets section -- */}
              <CardBlock type="description">
                <div className="cred-form__section">
                  <div className="cred-form__section-header">
                    <Typography Component="h3" fontSize="fs16" boldness="semibold" className="cred-form__section-title">
                      Provider &amp; secrets
                    </Typography>
                    <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="cred-form__section-subtitle">
                      {isEdit
                        ? "Secret values are write-only. To rotate secrets use the rotate action from the credentials list."
                        : "Select the provider and enter the secret values. Secret values are never returned after creation."}
                    </Typography>
                  </div>

                  <div className="cred-form__fields">
                    {/* Provider */}
                    <div className="cred-form__field">
                      {isEdit ? (
                        <>
                          <div className="cred-form__field-label-area">
                            <Typography Component="label" fontSize="fs14" boldness="regular">
                              Provider
                            </Typography>
                          </div>
                          <Typography Component="p" fontSize="fs14" boldness="semibold" className="cred-form__provider-readonly">
                            {PROVIDER_OPTIONS.find((o) => o.value === provider)?.label ?? provider}
                          </Typography>
                        </>
                      ) : (
                        <SelectDropdown
                          label="Provider"
                          placeholder="Select or type a provider key…"
                          value={provider}
                          items={PROVIDER_ITEMS}
                          size="fill"
                          options={{
                            isSearchable: true,
                            canAddNew: true,
                            isCellMultiline: true,
                          }}
                          disabled={isSubmitting}
                          onValueChange={(val) => {
                            setProvider(String(val ?? ""));
                            setSecretData({});
                            setMetadata({});
                            markDirty();
                          }}
                          onAddNew={(val) => {
                            setProvider(val);
                            setSecretData({});
                            setMetadata({});
                            markDirty();
                          }}
                        />
                      )}
                    </div>

                    {/* Create mode: all secret + metadata fields via CredentialSecretFields */}
                    {!isEdit && (
                      <CredentialSecretFields
                        provider={provider}
                        secretData={secretData}
                        onChange={(d) => { setSecretData(d); markDirty(); }}
                        metadata={metadata}
                        onMetadataChange={(m) => { setMetadata(m); markDirty(); }}
                      />
                    )}

                    {/* Edit mode: metadata fields only (endpoint, region, etc.) — secrets are write-only */}
                    {isEdit && metadataFields.map((field) => (
                      <div key={field.key} className="cred-form__field">
                        <Input
                          label={field.label}
                          isOptional={!field.required}
                          value={metadata[field.key] ?? ""}
                          placeholder={field.placeholder}
                          isDisabled={isSubmitting}
                          onChange={(e) => {
                            setMetadata((prev) => ({ ...prev, [field.key]: e.target.value }));
                            markDirty();
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </CardBlock>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* -- Sticky footer -- */}
      <div className="cred-form-page__footer">
        <Button variant="outline" label="Cancel" onClick={navigateBack} isDisabled={isSubmitting} />
        <Button
          variant="solid"
          label={submitLabel}
          loading={isSubmitting}
          onClick={() => void handleSubmit()}
        />
      </div>

      {/* -- Discard changes dialog -- */}
      <ConfirmDialog
        open={isBlocked}
        title="Discard changes?"
        description="You have unsaved changes. Are you sure you want to leave?"
        confirmLabel="Discard"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </div>
  );
}

export { CredentialForm };
export type { CredentialFormProps };
