/** Which Add-Model sub-flow opened the modal (chooses the body layout). */
type ConfigureModalFlow = "providers" | "self-hosted";

/** Public props for the `ModelProviderConfigureModal` component. */
type ModelProviderConfigureModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flow: ConfigureModalFlow;
  /** When `flow` is providers, the row selected in the table (may be null). */
  providerId: string | null;
  providerName: string | null;
  /**
   * Fired when the user saves the connection. For the providers flow the
   * resolved credential id (existing or newly created) is passed back so the
   * Add-Model screen can attach it to the model registration payload.
   */
  onSave?: (credentialId?: string) => void;
};

export type { ConfigureModalFlow, ModelProviderConfigureModalProps };
