import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate, useBlocker } from "react-router";
import { useForm } from "@tanstack/react-form";
import { IconX } from "@tabler/icons-react";

import type {
  DataSourceDetail,
  DataSourceProtocol,
  DataSourceStatus,
  ScanDepth,
} from "@/api/data-source.types";
import { ScanningSettingsDialog } from "../../scanning-settings-dialog";
import {
  useCreateDataSourceMutation,
  useUpdateDataSourceMutation,
  useRecordConnectionTestResultMutation,
} from "@/api/data-source-api.slice";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useListCredentialsQuery } from "@/routes/pages/credentials/credential-api.slice";
import { Form, runFormHandleSubmit } from "@/ui-lib/base-components/form";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { dataManagementPaths } from "../../../data-management.consts";

import { withClearedConnectorConfigFields } from "./connector-config-validation";
import { buildDefaultValues, DEFAULT_LABEL_ITEMS } from "./data-source-form.consts";
import { DetailsSection } from "./details-section";
import { AccessConfigSection } from "./access-config-section";
import { AccessConfigDialog, type ConnectionTestStatus } from "./access-config-dialog";
import { ScanningSection } from "./scanning-section";
import "./data-source-form.scss";

// -- Props --

// Scanning configuration is temporarily hidden from the register/edit page
// until the scan integration is ready. Flip to true to restore the UI.
const SHOW_SCANNING = false;

interface DataSourceFormProps {
  isEdit?: boolean;
  initialData?: DataSourceDetail;
}

// -- Component --

function DataSourceForm({ isEdit = false, initialData }: DataSourceFormProps): ReactElement {
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  // API mutations
  const [createDataSource, { isLoading: isCreating }] = useCreateDataSourceMutation();
  const [updateDataSource, { isLoading: isUpdating }] = useUpdateDataSourceMutation();
  const [recordConnectionTestResult] = useRecordConnectionTestResultMutation();

  // Dialog state
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [scanDialogOpen, setScanDialogOpen] = useState(false);

  // Track whether a password has been configured (always true in edit mode)
  /* v8 ignore start -- isEdit=true with no initialData is unreachable; edit pages always supply initialData */
  const [passwordConfigured, setPasswordConfigured] = useState(() => isEdit && !!initialData);
  /* v8 ignore stop */
  const connectionStatus: DataSourceStatus = initialData?.status ?? "Healthy";

  // Connection test result — seeded from the backend's persisted Test Connection
  // outcome (edit mode) so the summary card reflects the saved status, then
  // updated by AccessConfigDialog after Add/Save.
  const initialTestStatus: ConnectionTestStatus =
    initialData?.connection_test_status === "success"
      ? "success"
      : initialData?.connection_test_status === "failed"
        ? "error"
        : "idle";
  const [testStatus, setTestStatus] = useState<ConnectionTestStatus>(initialTestStatus);
  // Mirror of testStatus readable from the form's onSubmit closure without going
  // stale, so the saved result can be persisted to the backend after save.
  const testStatusRef = useRef<ConnectionTestStatus>(initialTestStatus);

  // Saved credentials, used to resolve a connector's credential_id → display name
  // in the access-config summary card.
  const { data: allCredentials = [] } = useListCredentialsQuery(
    { projectId },
    { skip: !projectId },
  );

  const handleTestResult = useCallback((status: ConnectionTestStatus) => {
    setTestStatus(status);
    testStatusRef.current = status;
  }, []);

  // Persists the in-session Test Connection result to the backend (connectors
  // only) so the landing page + edit form show Success/Failed instead of
  // "Untested". Best-effort — a failure here must not block the save flow.
  const persistTestResult = useCallback(
    async (dsrcId: string, isConnector: boolean) => {
      const status = testStatusRef.current;
      if (!isConnector || (status !== "success" && status !== "error")) return;
      try {
        await recordConnectionTestResult({
          projectId,
          dsrcId,
          success: status === "success",
        }).unwrap();
      } catch {
        // Non-fatal: the data source was still saved; status just stays as-is.
      }
    },
    [projectId, recordConnectionTestResult],
  );

  const isSubmitting = isCreating || isUpdating;
  const pageTitle = isEdit ? "Edit data source" : "Register data source";
  const submitLabel = isEdit ? "Save" : "Register";

  const defaultValues = useMemo(() => buildDefaultValues(initialData), [initialData]);

  const [labelItems, setLabelItems] = useState(() => {
    const items = [...DEFAULT_LABEL_ITEMS];
    if (initialData?.labels) {
      for (const label of initialData.labels) {
        if (!items.some((item) => item.value === label)) {
          items.push({ key: label, value: label, label });
        }
      }
    }
    return items;
  });

  // Set right before an intentional post-submit navigation so the dirty-form
  // navigation guard (useBlocker below) doesn't pop the "Discard changes?"
  // dialog on a successful Register/Save. A ref (not state) keeps the value
  // readable inside the blocker callback at navigation time without depending
  // on a re-render landing first.
  const skipBlockerRef = useRef(false);

  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      try {
        if (isEdit && initialData) {
          // Connector-backed sources persist any access-config dialog changes by
          // sending the full connector_config (the backend merges it) + credential.
          const connector = value.connector;
          await updateDataSource({
            projectId,
            dsrcId: initialData.dsrc_id,
            body: {
              // Send "" / [] explicitly so the backend can clear persisted values.
              description: value.description,
              labels: (value.labels as string[]) ?? [],
              ...(connector
                ? {
                  connector_config: withClearedConnectorConfigFields(
                    {
                      scope: connector.scope,
                      provider: connector.provider,
                      connector_type: connector.connector_type,
                      ...connector.config,
                    },
                    initialData.connector_config ?? undefined,
                  ),
                  credential_id: connector.credential_id || undefined,
                }
                : {}),
              scan_config: value.scan_enabled
                ? {
                  scan_depth: value.scan_config.scan_depth,
                  custom_depth: value.scan_config.scan_depth === "custom"
                    ? (Number(value.scan_config.custom_depth) || 1)
                    : null,
                }
                : undefined,
            },
          }).unwrap();
          await persistTestResult(initialData.dsrc_id, !!connector);
          toast.success("Data source updated successfully.");
          skipBlockerRef.current = true;
          navigate(dataManagementPaths.dataSourceDetail(initialData.dsrc_id));
        } else {
          /* v8 ignore start -- source_type is required by form validation; this guard is never reached */
          if (!value.source_type) return;
          /* v8 ignore stop */

          const created = await createDataSource({
            projectId,
            body: {
              name: value.name,
              source_type: value.source_type as DataSourceProtocol,
              description: value.description || undefined,
              labels: value.labels as string[],
              connection: value.connection,
              connector: value.connector,
              scan_enabled: value.scan_enabled,
              scan_config: value.scan_config,
            },
          }).unwrap();
          await persistTestResult(created.dsrc_id, !!value.connector);
          toast.success("Data source registered successfully.");
          skipBlockerRef.current = true;
          navigate(dataManagementPaths.dataSources);
        }
      } catch (err) {
        // Surface the backend's specific message when present (e.g. the 409
        // "A data source with this name already exists in this project").
        const backendError = (err as { data?: { error?: string } } | undefined)?.data?.error;
        toast.error(
          backendError ?? (isEdit ? "Failed to update data source." : "Failed to register data source."),
        );
      }
    },
    // Cast required: ReactFormExtendedApi has 12 generic params that TS can't
    // structurally verify against the `any`-relaxed AnyReactFormApi alias used
    // by all UI-lib form components. This is by design — see form.types.ts.
  }) as unknown as AnyReactFormApi;

  const handleAddLabel = useCallback((value: string) => {
    const trimmed = value.trim().toLowerCase();
    /* v8 ignore if -- @preserve: SelectDropdown never calls onAddNew with blank text */
    if (!trimmed) return;
    setLabelItems((prev) => {
      /* v8 ignore if -- @preserve: SelectDropdown disables "Add" for existing items */
      if (prev.some((item) => item.value === trimmed)) return prev;
      return [...prev, { key: trimmed, value: trimmed, label: trimmed }];
    });
    const current = (form.state.values.labels as string[]) ?? [];
    if (!current.includes(trimmed)) {
      form.setFieldValue("labels", [...current, trimmed]);
    }
  }, [form]);

  // Block navigation when the form is dirty, but not during submission or after
  // a successful submit (which navigates away intentionally). Evaluated lazily
  // at navigation time so the post-submit `skipBlockerRef` bypass is honored
  // without relying on a re-render flushing isSubmitting back to false first.
  const blocker = useBlocker(
    useCallback(
      () => form.state.isDirty && !isSubmitting && !skipBlockerRef.current,
      [form, isSubmitting],
    ),
  );
  const isBlocked = blocker.state === "blocked";

  const navigateBack = useCallback(() => {
    if (isEdit && initialData) {
      navigate(dataManagementPaths.dataSourceDetail(initialData.dsrc_id));
    } else {
      navigate(dataManagementPaths.dataSources);
    }
  }, [isEdit, initialData, navigate]);

  const handleScanConfirm = useCallback((scanDepth: ScanDepth, customDepth: number | null) => {
    form.setFieldValue("scan_enabled", scanDepth !== "none");
    form.setFieldValue("scan_config.scan_depth", scanDepth);
    if (scanDepth === "custom" && customDepth != null) {
      form.setFieldValue("scan_config.custom_depth", customDepth);
    }
    setScanDialogOpen(false);
  }, [form]);

  // Name validation (create mode only — field is read-only in edit)
  const nameValidatorSync = useCallback(
    ({ value }: { value: string }): string | undefined => {
      if (isEdit) return undefined;
      const trimmed = value.trim();
      if (!trimmed) return "Name is required";
      if (trimmed.length < 3) return "Name must be at least 3 characters";
      return undefined;
    },
    [isEdit],
  );

  // Dynamic volumes have no server endpoint; they're "configured" once a
  // StorageClass is chosen. Static volumes / connectors still gate on server.
  const accessConn = form.state.values.connection;
  const accessConfigured =
    // Connector-backed sources (Object store, Database, Storage system, API) are
    // configured once the connector is present — they carry no volume server.
    !!form.state.values.connector ||
    accessConn.server.trim() !== "" ||
    (accessConn.provisioning_mode === "dynamic" && !!accessConn.storage_class_name);

  return (
    <div className="ds-form-page">
      {/* -- Top bar -- */}
      <div className="ds-form-page__top-bar">
        <Typography Component="h1" fontSize="fs16" boldness="semibold" className="ds-form-page__top-bar-title">
          {pageTitle}
        </Typography>
        <Button variant="icon" icon={<IconX size={20} />} onClick={navigateBack} aria-label="Close" />
      </div>

      {/* -- Scrollable body -- */}
      <div className="ds-form-page__body">
        <div className="ds-form-page__body-inner">
          <div className="ds-form-page__header">
            <Typography Component="h2" fontSize="fs20" boldness="semibold">
              Data source
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
              A data source provides a secure link to your storage assets and endpoints for integrated data management. A data source is defined by its connection type and protocol, enabling the specific scope and filtering required for your downstream datasets.
            </Typography>
          </div>
          <Card className="ds-form-page__form-card">
            <CardContent>
              <Form form={form}>
                <CardBlock type="description" hasSeparator>
                  <DetailsSection
                    form={form}
                    isEdit={isEdit}
                    labelItems={labelItems}
                    onAddLabel={handleAddLabel}
                    nameValidatorSync={nameValidatorSync}
                  />
                </CardBlock>

                <CardBlock type="description" hasSeparator={!isEdit && SHOW_SCANNING}>
                  <AccessConfigSection
                    configured={accessConfigured}
                    onOpenDialog={() => setAccessDialogOpen(true)}
                    sourceType={form.state.values.source_type}
                    server={form.state.values.connection.server}
                    volumeName={form.state.values.connection.volume_name}
                    username={form.state.values.connection.username}
                    passwordConfigured={passwordConfigured}
                    connectionStatus={connectionStatus}
                    testStatus={testStatus}
                    connector={form.state.values.connector}
                    credentialName={
                      allCredentials.find(
                        (c) =>
                          c.id ===
                          (form.state.values.connector?.credential_id ??
                            form.state.values.connection.username),
                      )?.name
                    }
                  />
                </CardBlock>

                {!isEdit && SHOW_SCANNING && (
                  <CardBlock type="description">
                    <ScanningSection
                      scanDepth={form.state.values.scan_config?.scan_depth}
                      customDepth={form.state.values.scan_config?.custom_depth}
                      onOpenDialog={() => setScanDialogOpen(true)}
                    />
                  </CardBlock>
                )}
              </Form>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* -- Sticky footer -- */}
      <div className="ds-form-page__footer">
        <Button variant="outline" label="Cancel" onClick={navigateBack} isDisabled={isSubmitting} />
        <Button
          variant="solid"
          label={submitLabel}
          loading={isSubmitting}
          onClick={async () => {
            await runFormHandleSubmit(form);
          }}
        />
      </div>

      {/* -- Access Config Dialog -- */}
      <AccessConfigDialog
        form={form}
        isEdit={isEdit}
        dsrcId={initialData?.dsrc_id}
        open={accessDialogOpen}
        onClose={() => setAccessDialogOpen(false)}
        onPasswordSet={(has) => setPasswordConfigured(isEdit || has)}
        onTestResult={handleTestResult}
      />

      {/* -- Scanning Dialog -- */}
      {SHOW_SCANNING && (
        <ScanningSettingsDialog
          open={scanDialogOpen}
          onClose={() => setScanDialogOpen(false)}
          initialScanDepth={form.state.values.scan_config.scan_depth as ScanDepth}
          initialCustomDepth={form.state.values.scan_config.custom_depth}
          onConfirm={handleScanConfirm}
        />
      )}

      {/* -- Discard Changes Dialog (driven by useBlocker) -- */}
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

export { DataSourceForm };
export type { DataSourceFormProps };
