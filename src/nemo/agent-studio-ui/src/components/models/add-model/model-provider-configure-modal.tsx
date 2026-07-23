import { IconAlertCircle, IconInfoCircle } from "@tabler/icons-react";
import { useId, useMemo, useState, type ReactElement } from "react";

import { CredentialSecretFields } from "@/components/credential-secret-fields/credential-secret-fields";
import { PROVIDER_PRESETS } from "@/constants/providerPresets";
import {
  useCreateCredentialMutation,
  useListCredentialsQuery,
  useValidateCredentialMutation,
  useValidateCredentialDraftMutation,
} from "@/routes/pages/credentials/credential-api.slice";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { Button } from "@/ui-lib/base-components/button/button";
import { Chip } from "@/ui-lib/base-components/chip-list/chip-list";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Input } from "@/ui-lib/base-components/input/input";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import type { SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types";
import { TabContent, TabGroup } from "@/ui-lib/base-components/tab/tab-group";
import type { TabItem } from "@/ui-lib/base-components/tab/tab";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import {
  SELF_HOSTED_MODAL_SUBTITLE,
  SELF_HOSTED_MODAL_TITLE,
} from "./model-provider-configure-modal.consts";
import type {
  ModelProviderConfigureModalProps,
} from "./model-provider-configure-modal.types";

import "./model-provider-configure-modal.scss";

function toProviderTagLabel(providerName: string | null): string {
  if (providerName == null || providerName.trim().length === 0) return "Provider";
  // Keep the tag compact; the design shows a short label in the pill.
  if (providerName === "AWS Bedrock") return "Bedrock";
  if (providerName === "Azure OpenAI") return "Azure";
  if (providerName.startsWith("Google")) return "Google";
  return providerName.split(" ")[0] ?? providerName;
}

/**
 * Normalize the Add-Model provider id onto the credential/provider-preset key
 * (`openai`, `azure`, `aws_bedrock`, `google`, …). The catalog already uses
 * the config-service keys, but we map a few legacy aliases defensively so the
 * credential list/create + `PROVIDER_PRESETS` lookups always resolve.
 */
function normalizeCredentialProvider(providerId: string | null): string {
  switch (providerId) {
    case "azure-openai":
      return "azure";
    case "aws-bedrock":
    case "bedrock":
      return "aws_bedrock";
    case "vertex-ai":
      return "google";
    default:
      return providerId ?? "";
  }
}

/** Best-effort human-readable message from an RTK Query error. */
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      data?: { error?: unknown; errors?: Array<{ msg?: unknown }> } | string;
    };
    if (typeof e.data === "string" && e.data.trim()) return e.data;
    if (e.data && typeof e.data === "object") {
      if (typeof e.data.error === "string" && e.data.error.trim()) return e.data.error;
      const firstMsg = e.data.errors?.[0]?.msg;
      if (typeof firstMsg === "string" && firstMsg.trim()) return firstMsg;
    }
  }
  return "Failed to save the credential. Please try again.";
}

function providerInfoCopy(provider: string): string {
  if (provider === "azure") {
    return "Credentials are stored as Kubernetes Secrets; only metadata (endpoint, API version) is saved to the database. Set the Azure endpoint and an API version (e.g. 2023-03-15-preview) so deployments resolve correctly.";
  }
  return "Credentials are stored securely as Kubernetes Secrets; only non-secret metadata is saved to the database. Reuse an existing credential or create a new one to connect this provider.";
}

function ModelProviderConfigureModal({
  open,
  onOpenChange,
  flow,
  providerId,
  providerName,
  onSave,
}: ModelProviderConfigureModalProps): ReactElement {
  const handleClose = (): void => {
    onOpenChange(false);
  };

  if (flow === "providers") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} size="lg">
        <DialogPopup className="model-provider-configure-modal__dialog-popup--wide">
          {/*
           * Remount the body whenever the selected provider changes or the
           * dialog reopens so the credential form resets to a clean state.
           */}
          <ProviderCredentialConfigureBody
            key={`${providerId ?? "none"}-${open ? "open" : "closed"}`}
            provider={normalizeCredentialProvider(providerId)}
            providerName={providerName}
            onClose={handleClose}
            onSaved={(credentialId) => {
              onSave?.(credentialId);
              onOpenChange(false);
            }}
          />
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogPopup>
        <Card>
          <CardHeader
            title={SELF_HOSTED_MODAL_TITLE}
            subtitle={SELF_HOSTED_MODAL_SUBTITLE}
            hasSeparator
          />
          <CardContent>
            <div className="model-provider-configure-modal__body">
              <SelfHostedConfigureBody />
            </div>
          </CardContent>
          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              { variant: "outline", label: "Cancel", onClick: handleClose },
              {
                variant: "solid",
                label: "Validate",
                onClick: () => {
                  onSave?.();
                  handleClose();
                },
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  );
}

type ProviderCredentialConfigureBodyProps = {
  provider: string;
  providerName: string | null;
  onClose: () => void;
  onSaved: (credentialId: string) => void;
};

type CredentialMode = "existing" | "new";

/** Segmented selector for the credential source (shared Tab component). */
const CREDENTIAL_MODE_TABS: TabItem[] = [
  { id: "existing", label: "Use existing" },
  { id: "new", label: "Create new" },
];

function ProviderCredentialConfigureBody({
  provider,
  providerName,
  onClose,
  onSaved,
}: ProviderCredentialConfigureBodyProps): ReactElement {
  const baseId = useId();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const preset = PROVIDER_PRESETS[provider];

  const { data: credentials = [], isFetching: isLoadingCredentials } =
    useListCredentialsQuery(
      { projectId, provider },
      { skip: !projectId || !provider },
    );
  const [createCredential, { isLoading: isCreating }] = useCreateCredentialMutation();
  const [validateCredential, { isLoading: isValidatingExisting }] =
    useValidateCredentialMutation();
  const [validateCredentialDraft, { isLoading: isValidating }] =
    useValidateCredentialDraftMutation();
  // Validating (live provider check) or persisting both block the form.
  const busy = isCreating || isValidating || isValidatingExisting;

  const [modeOverride, setModeOverride] = useState<CredentialMode | null>(null);
  // Default to "existing" once saved credentials exist, otherwise "new".
  const mode: CredentialMode =
    modeOverride ?? (credentials.length > 0 ? "existing" : "new");

  const [selectedCredentialId, setSelectedCredentialId] = useState<string>("");
  const [name, setName] = useState("");
  const [secretData, setSecretData] = useState<Record<string, string>>({});
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const dialogTitle = `Configure ${providerName ?? preset?.label ?? "provider"}`;
  const tagLabel = toProviderTagLabel(providerName ?? preset?.label ?? null);

  const credentialItems = useMemo(
    () => credentials.map((c) => ({ key: c.id, value: c.id, label: c.name })),
    [credentials],
  );

  const handleSave = async (): Promise<void> => {
    setError(null);

    // Selecting/creating a credential attaches it to the flow. The live
    // connection check + "Successful" status happen in Add Model, driven by the
    // model-list (`list-available`) call — that is the real provider round-trip
    // and it also populates the model dropdown, so we don't double-call here.
    if (mode === "existing") {
      if (!selectedCredentialId) {
        setError("Select a credential to continue.");
        return;
      }
      if (!projectId) {
        setError("No active project selected.");
        return;
      }
      try {
        const validation = await validateCredential({
          projectId,
          id: selectedCredentialId,
        }).unwrap();
        if (!validation.valid) {
          setError(
            validation.error?.trim()
              ? validation.error
              : "Connection failed — check the credentials.",
          );
          return;
        }
      } catch {
        setError("Couldn't validate this credential right now. Please try again.");
        return;
      }
      onSaved(selectedCredentialId);
      return;
    }

    if (!projectId) {
      setError("No active project selected.");
      return;
    }
    if (!name.trim()) {
      setError("Enter a name for this credential.");
      return;
    }

    const missing = [
      ...(preset?.secretFields ?? []).filter(
        (f) => f.required && !secretData[f.key]?.trim(),
      ),
      ...(preset?.metadataFields ?? []).filter(
        (f) => f.required && !metadata[f.key]?.trim(),
      ),
    ];
    if (missing.length > 0) {
      setError(`Fill in required fields: ${missing.map((f) => f.label).join(", ")}.`);
      return;
    }

    const cleanedSecret = Object.fromEntries(
      Object.entries(secretData).filter(([, v]) => v.trim() !== ""),
    );
    const cleanedMetadata = Object.fromEntries(
      Object.entries(metadata).filter(([, v]) => v.trim() !== ""),
    );
    const metadataArg = Object.keys(cleanedMetadata).length ? cleanedMetadata : undefined;

    // Validate the raw credentials against the live provider BEFORE persisting,
    // so a bad or unreachable credential is never stored. A timeout/network
    // failure surfaces its own message and likewise leaves nothing saved.
    try {
      const validation = await validateCredentialDraft({
        projectId,
        provider,
        secretData: cleanedSecret,
        metadata: metadataArg,
      }).unwrap();
      if (!validation.valid) {
        setError(
          validation.error?.trim()
            ? validation.error
            : "Connection failed — the provider rejected these credentials.",
        );
        return;
      }
    } catch {
      setError("Couldn't reach the provider to validate the connection. Please try again.");
      return;
    }

    try {
      const created = await createCredential({
        projectId,
        body: {
          name: name.trim(),
          provider,
          secretData: cleanedSecret,
          metadata: metadataArg,
        },
      }).unwrap();
      onSaved(created.id);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  return (
    <div
      className="model-provider-configure-modal-wide"
      style={{ maxHeight: "min(976px, calc(100vh - 4rem))" }}
    >
      <div className="model-provider-configure-modal-wide__title-bar">
        <Typography
          Component="h2"
          fontSize="fs20"
          boldness="regular"
          className="model-provider-configure-modal-wide__dialog-title"
        >
          {dialogTitle}
        </Typography>
      </div>

      <div className="model-provider-configure-modal-wide__body">
        <div className="model-provider-configure-modal-wide__section-head">
          <div className="model-provider-configure-modal-wide__section-head-text">
            <Typography Component="h3" fontSize="fs14" boldness="semibold" color="var(--text-primary)">
              Credentials
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-primary)">
              Use an existing saved credential or create a new one for this provider.
            </Typography>
          </div>
          <span aria-label="Provider">
            <Chip
              type="tag"
              color="tag1"
              size="regular"
              label={tagLabel}
              isRemovable={false}
              className="model-provider-configure-modal-wide__tag"
            />
          </span>
        </div>

        <TabGroup
          tabs={CREDENTIAL_MODE_TABS}
          activeTabId={mode}
          onTabChange={(id) => setModeOverride(id as CredentialMode)}
          disableAll={busy}
          ariaLabel="Credential source"
          className="model-provider-configure-modal-wide__cred-tabs"
        >
          <TabContent
            tabId="existing"
            className="model-provider-configure-modal-wide__fields"
          >
            {credentialItems.length === 0 ? (
              <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                {isLoadingCredentials
                  ? "Loading saved credentials…"
                  : "No saved credentials for this provider yet. Switch to “Create new” to add one."}
              </Typography>
            ) : (
              <div className="model-provider-configure-modal-wide__field">
                <SelectDropdown
                  id={`${baseId}-credential`}
                  label="Credential"
                  placeholder={isLoadingCredentials ? "Loading…" : "Select a credential"}
                  items={credentialItems}
                  value={selectedCredentialId as SelectDropdownValue}
                  onValueChange={(v) =>
                    setSelectedCredentialId(typeof v === "string" ? v : "")
                  }
                  options={{ isSearchable: true, isClearable: true }}
                  emptyMessage="No credentials found"
                />
              </div>
            )}
          </TabContent>

          <TabContent
            tabId="new"
            className="model-provider-configure-modal-wide__fields"
          >
            <div className="model-provider-configure-modal-wide__field">
              <Input
                id={`${baseId}-name`}
                label="Credential name"
                placeholder="e.g. azure-openai-prod"
                value={name}
                onChange={(e) => setName(e.target.value)}
                isDisabled={busy}
              />
            </div>
            <CredentialSecretFields
              provider={provider}
              secretData={secretData}
              onChange={setSecretData}
              metadata={metadata}
              onMetadataChange={setMetadata}
              disabled={busy}
            />
          </TabContent>
        </TabGroup>

        {error ? (
          <div className="model-provider-configure-modal-wide__error" role="alert">
            <IconAlertCircle
              size={16}
              className="model-provider-configure-modal-wide__error-icon"
              aria-hidden
            />
            <Typography Component="span" fontSize="fs14" color="var(--notification-error)">
              {error}
            </Typography>
          </div>
        ) : null}

        <div className="model-provider-configure-modal-wide__notice">
          <IconInfoCircle
            size={16}
            className="model-provider-configure-modal-wide__notice-icon"
            aria-hidden
          />
          <div className="model-provider-configure-modal-wide__notice-text">
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-primary)">
              {providerInfoCopy(provider)}
            </Typography>
          </div>
        </div>
      </div>

      <div className="model-provider-configure-modal-wide__footer">
        <div className="model-provider-configure-modal-wide__footer-sep" aria-hidden />
        <div className="model-provider-configure-modal-wide__footer-actions">
          <Button
            variant="solid"
            size="medium"
            label={isValidating ? "Validating…" : isCreating ? "Saving…" : "Save"}
            className="model-provider-configure-modal-wide__footer-btn"
            onClick={() => void handleSave()}
            isDisabled={busy}
          />
          <Button
            variant="outline"
            size="medium"
            label="Cancel"
            className="model-provider-configure-modal-wide__footer-btn"
            onClick={onClose}
            isDisabled={busy}
          />
        </div>
      </div>
    </div>
  );
}

function SelfHostedConfigureBody(): ReactElement {
  return (
    <CardBlock type="description">
      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
        Placeholder: self-hosted server URL, auth mode, and TLS options go here.
      </Typography>
    </CardBlock>
  );
}

export { ModelProviderConfigureModal };
