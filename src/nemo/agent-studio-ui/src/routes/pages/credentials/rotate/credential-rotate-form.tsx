import { useState, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { IconX } from "@tabler/icons-react";

import type { Credential } from "../credential.types";
import { useRotateCredentialMutation } from "../credential-api.slice";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { CredentialSecretFields } from "@/components/credential-secret-fields/credential-secret-fields";
import { PROVIDER_OPTIONS, PROVIDER_PRESETS } from "@/constants/providerPresets";
import { normalizeProviderSecretData } from "@/utils/gcpServiceAccountJson";
import { credentialPaths } from "../credentials.consts";
import "../create-edit/credential-form.scss";

// -- Props --

interface CredentialRotateFormProps {
  credential: Credential;
}

// -- Helpers --

function toDateInputValue(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}

// -- Component --

function CredentialRotateForm({ credential }: CredentialRotateFormProps): ReactElement {
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [rotateCredential, { isLoading }] = useRotateCredentialMutation();

  const [secretData, setSecretData] = useState<Record<string, string>>({});
  const [expiresAt, setExpiresAt] = useState(toDateInputValue(credential.expiresAt));

  const navigateBack = (): void => {
    navigate(credentialPaths.root);
  };

  const handleRotate = async (): Promise<void> => {
    const preset = PROVIDER_PRESETS[credential.provider];
    if (preset) {
      const missing = preset.secretFields
        .filter((f) => f.required && !secretData[f.key]?.trim())
        .map((f) => f.label);
      if (missing.length) {
        toast.error(`Required fields missing: ${missing.join(", ")}`);
        return;
      }
    } else {
      const hasAny = Object.entries(secretData).some(([k, v]) => k.trim() && v.trim());
      if (!hasAny) {
        toast.error("Add at least one key/value secret field.");
        return;
      }
    }

    const normalized = normalizeProviderSecretData(credential.provider, secretData);
    if (!normalized.ok) {
      toast.error(normalized.message);
      return;
    }

    try {
      await rotateCredential({
        projectId,
        id: credential.id,
        body: {
          secretData: normalized.secretData,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        },
      }).unwrap();
      toast.success(`"${credential.name}" secrets rotated successfully.`);
      navigateBack();
    } catch {
      toast.error(`Failed to rotate "${credential.name}".`);
    }
  };

  const providerLabel =
    PROVIDER_OPTIONS.find((o) => o.value === credential.provider)?.label ?? credential.provider;

  return (
    <div className="cred-form-page">
      {/* -- Top bar -- */}
      <div className="cred-form-page__top-bar">
        <Typography Component="h1" fontSize="fs16" boldness="semibold" className="cred-form-page__top-bar-title">
          Rotate secrets
        </Typography>
        <Button variant="icon" icon={<IconX size={20} />} onClick={navigateBack} aria-label="Close" isDisabled={isLoading} />
      </div>

      {/* -- Scrollable body -- */}
      <div className="cred-form-page__body">
        <div className="cred-form-page__body-inner">
          <div className="cred-form-page__header">
            <Typography Component="h2" fontSize="fs20" boldness="semibold">
              {credential.name}
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
              The credential ID stays unchanged. All resources referencing this credential — models, data sources, MCP servers — will automatically use the new secret values.
            </Typography>
          </div>

          <Card className="cred-form-page__form-card">
            <CardContent>
              <CardBlock type="description">
                <div className="cred-form__section">
                  <div className="cred-form__section-header">
                    <Typography Component="h3" fontSize="fs16" boldness="semibold" className="cred-form__section-title">
                      New secrets
                    </Typography>
                    <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="cred-form__section-subtitle">
                      Enter the replacement secret values for this credential. Existing secrets will be overwritten.
                    </Typography>
                  </div>

                  <div className="cred-form__fields">
                    {/* Provider — read-only */}
                    <div className="cred-form__field">
                      <div className="cred-form__field-label-area">
                        <Typography Component="label" fontSize="fs14" boldness="regular">
                          Provider
                        </Typography>
                      </div>
                      <Typography Component="p" fontSize="fs14" boldness="semibold" className="cred-form__provider-readonly">
                        {providerLabel}
                      </Typography>
                    </div>

                    {/* Secret fields */}
                    <CredentialSecretFields
                      provider={credential.provider}
                      secretData={secretData}
                      onChange={setSecretData}
                      disabled={isLoading}
                    />

                    {/* New expiry date */}
                    <div className="cred-form__field">
                      <div className="cred-form__field-label-area">
                        <Typography Component="label" fontSize="fs14" boldness="regular" htmlFor="cred-rotate-expires">
                          New expiry
                        </Typography>
                        <Typography Component="span" fontSize="fs12" boldness="regular" color="var(--text-secondary)">
                          (optional)
                        </Typography>
                      </div>
                      <input
                        id="cred-rotate-expires"
                        type="date"
                        className="cred-form__date-input"
                        value={expiresAt}
                        disabled={isLoading}
                        onChange={(e) => setExpiresAt(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </CardBlock>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* -- Sticky footer -- */}
      <div className="cred-form-page__footer">
        <Button variant="outline" label="Cancel" onClick={navigateBack} isDisabled={isLoading} />
        <Button
          variant="solid"
          label="Rotate secrets"
          loading={isLoading}
          onClick={() => void handleRotate()}
        />
      </div>
    </div>
  );
}

export { CredentialRotateForm };
export type { CredentialRotateFormProps };
