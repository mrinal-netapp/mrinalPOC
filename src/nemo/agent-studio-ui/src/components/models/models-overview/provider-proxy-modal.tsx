import { useState, type ReactElement } from "react";

import { useUpdateProviderMutation } from "@/routes/pages/models/models.api";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { CardFooter } from "@/ui-lib/base-components/card/card.footer";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { Input } from "@/ui-lib/base-components/input/input";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { toast } from "@/ui-lib/base-components/toast/toast";

/** Minimal provider shape the modal needs to seed + submit the proxy edit. */
type ProviderProxyTarget = {
  provider_id: string;
  name: string;
  concurrent_requests: number;
  buffer_size: number;
};

type ProviderProxyModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  provider: ProviderProxyTarget | null;
};

/** Positive integer or null (blank / zero / non-numeric are rejected). */
function parsePositiveInt(value: string): number | null {
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ProviderProxyModalBody({
  provider,
  projectId,
  onClose,
}: {
  provider: ProviderProxyTarget;
  projectId: string | null;
  onClose: () => void;
}): ReactElement {
  const [concurrentRequests, setConcurrentRequests] = useState(
    String(provider.concurrent_requests || ""),
  );
  const [bufferSize, setBufferSize] = useState(String(provider.buffer_size || ""));
  const [showErrors, setShowErrors] = useState(false);
  const [updateProvider, { isLoading }] = useUpdateProviderMutation();

  const concurrentValue = parsePositiveInt(concurrentRequests);
  const bufferValue = parsePositiveInt(bufferSize);
  const concurrentInvalid = showErrors && concurrentValue == null;
  const bufferInvalid = showErrors && bufferValue == null;

  const handleSave = (): void => {
    if (concurrentValue == null || bufferValue == null) {
      setShowErrors(true);
      return;
    }
    if (!projectId) {
      toast.error("No active project selected.");
      return;
    }
    void updateProvider({
      projectId,
      providerId: provider.provider_id,
      body: { concurrentRequests: concurrentValue, bufferSize: bufferValue },
    })
      .unwrap()
      .then(() => {
        toast.success(`Proxy configuration updated for ${provider.name}.`);
        onClose();
      })
      .catch(() => {
        toast.error(`Couldn't update proxy configuration for ${provider.name}.`);
      });
  };

  return (
    <Card>
      <CardHeader title="Edit proxy configuration" hasSeparator />
      <CardContent>
        <CardBlock type="description">
          <div className="provider-proxy-modal__fields">
            <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
              Gateway proxy limits for
              {" "}
              <Typography Component="span" fontSize="fs14" boldness="semibold">
                {provider.name}
              </Typography>
              .
            </Typography>
            <Input
              type="number"
              min={1}
              label="Concurrent requests"
              placeholder="Enter concurrent requests"
              value={concurrentRequests}
              isError={concurrentInvalid}
              onChange={(e) => setConcurrentRequests(e.target.value)}
            />
            <Input
              type="number"
              min={1}
              label="Buffer size"
              placeholder="Enter buffer size"
              value={bufferSize}
              isError={bufferInvalid}
              onChange={(e) => setBufferSize(e.target.value)}
            />
            {(concurrentInvalid || bufferInvalid) && (
              <Typography Component="p" fontSize="fs13" color="var(--notification-error)">
                Enter a positive whole number for both fields.
              </Typography>
            )}
          </div>
        </CardBlock>
      </CardContent>
      <CardFooter
        hasSeparator
        alignment="end"
        actions={[
          {
            variant: "solid",
            size: "medium",
            label: "Save",
            loading: isLoading,
            onClick: handleSave,
          },
          {
            variant: "outline",
            size: "medium",
            label: "Cancel",
            onClick: onClose,
            isDisabled: isLoading,
          },
        ]}
      />
    </Card>
  );
}

/**
 * Edit a provider's gateway proxy tuning (concurrent requests + buffer size)
 * from the Providers overview kebab menu. Seeds from the row's current values
 * and saves via `PUT /providers/:providerId`; the mutation's tag invalidation
 * refetches the table so the new values render on the row.
 */
function ProviderProxyModal({
  open,
  onOpenChange,
  projectId,
  provider,
}: ProviderProxyModalProps): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
    >
      <DialogPopup showCloseButton={false} className="provider-proxy-modal__popup">
        {open && provider != null ? (
          <ProviderProxyModalBody
            key={provider.provider_id}
            provider={provider}
            projectId={projectId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

export { ProviderProxyModal };
export type { ProviderProxyModalProps, ProviderProxyTarget };
