import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate, useBlocker } from "react-router";
import { useForm } from "@tanstack/react-form";
import { useStore } from "@tanstack/react-store";
import { IconX } from "@tabler/icons-react";

import type { DatasetDetail, DatasetInputType, DatasetKind, DatasetManifestFile, UploadedFileInfo } from "@/api/dataset.types";
import {
  useCreateDatasetMutation,
  useUpdateDatasetMutation,
  useCreateDatasetSnapshotMutation,
  useListDatasetManifestsQuery,
  useLazyListDatasetManifestsQuery,
  useUpdateDatasetManifestStatusMutation,
} from "@/api/dataset-api.slice";
import { useLazyGetProjectQuery } from "@/api/project-api.slice";
import { parseProjectStorageRoot } from "@/api/project-storage";
import {
  putObject,
  runWithConcurrency,
  getFileRelativePath,
  sanitizeUploadRelativePath,
  MANUAL_UPLOAD_CONCURRENCY,
} from "@/api/s3-upload";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  Form,
  runFormHandleSubmit,
  collectFirstFormValidationError,
  scrollToFirstFormError,
} from "@/ui-lib/base-components/form";
import { extractApiErrorMessage } from "@/utils/api-error.utils";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock } from "@/ui-lib/base-components/card/card.block";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { dataManagementPaths } from "../../../data-management.consts";

import { DEFAULT_LABEL_ITEMS, toDataSourceOriginKind } from "./dataset-form.consts";
import { buildDefaultValues, buildSpecPayload, buildRefreshConfigPayload, buildEditDelta } from "./dataset-form.utils";
import { validateDatasetFormOnSubmit, getDatasetNameFieldError } from "./dataset-form.validation";
import { DetailsSection } from "./details-section";
import { DataSourceSection } from "./data-source-section";
import { SpecSection } from "./spec-section";
import { SyncSettingsSection } from "./sync-settings-section";
import "./dataset-form.scss";

// -- Props --

interface DatasetFormProps {
  isEdit?: boolean;
  initialData?: DatasetDetail;
}

// -- Component --

function DatasetForm({ isEdit = false, initialData }: DatasetFormProps): ReactElement {
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  // API mutations
  const [createDataset, { isLoading: isCreating }] = useCreateDatasetMutation();
  const [updateDataset, { isLoading: isUpdating }] = useUpdateDatasetMutation();
  const [acquireDataset] = useCreateDatasetSnapshotMutation();
  const [commitManifest] = useUpdateDatasetManifestStatusMutation();
  const [fetchManifests] = useLazyListDatasetManifestsQuery();
  const [fetchProject] = useLazyGetProjectQuery();

  // Existing manual-upload files (edit mode). The committed manifest is the live
  // file set; we load it so the user can see, keep, or remove existing files.
  const isUploadEdit = isEdit && initialData?.input_type === "upload";
  const { data: manifests } = useListDatasetManifestsQuery(
    { projectId, dsetId: initialData?.dset_id ?? "" },
    { skip: !isUploadEdit || !projectId || !initialData?.dset_id },
  );
  // The live file set from the committed (or latest) manifest, before filtering.
  const sourceFiles = useMemo<DatasetManifestFile[]>(() => {
    if (!manifests?.length) return [];
    // Prefer the committed (live) manifest; fall back to the highest manifest_id.
    const committed = manifests.filter((m) => m.status === "committed");
    const source = committed.length
      ? committed.reduce((a, b) => (b.manifest_id > a.manifest_id ? b : a))
      : manifests.reduce((a, b) => (b.manifest_id > a.manifest_id ? b : a));
    return source.files;
  }, [manifests]);

  // Only files with a usable URI can be re-registered on save.
  const existingFiles = useMemo<DatasetManifestFile[]>(
    () => sourceFiles.filter((f) => Boolean(f.uri)),
    [sourceFiles],
  );

  // Older manifests may contain files without a URI. These can't be carried
  // forward when re-registering the manifest, so editing the file set would
  // silently drop them — we block file-set changes when any are present.
  const hasUnresolvableExistingFiles = useMemo(
    () => sourceFiles.some((f) => !f.uri),
    [sourceFiles],
  );

  // IDs of existing files the user removed in the edit screen (client-side until save).
  const [removedExistingIds, setRemovedExistingIds] = useState<Set<string>>(() => new Set());
  const toggleRemoveExisting = useCallback((id: string) => {
    setRemovedExistingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Manual-upload progress/errors, keyed by each file's upload-relative path.
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const [isUploading, setIsUploading] = useState(false);

  // Uploads files to the dataset's data_files/ prefix and returns the registered
  // file descriptors (caller decides whether to register/commit). Mirrors the GUI
  // manual-upload flow (ProjectDatasets.handleSubmit).
  const uploadFilesToS3 = useCallback(
    async (
      datasetId: string,
      files: File[],
    ): Promise<{ ok: boolean; files?: UploadedFileInfo[]; message?: string }> => {
      if (files.length === 0) return { ok: true, files: [] };
      // Resolve bucket + path prefix from the project home_dir (same source as config-service).
      let bucketName: string | undefined;
      let pathPrefix = "";
      try {
        const project = await fetchProject(projectId).unwrap();
        const root = parseProjectStorageRoot(project?.home_dir);
        if (root) {
          bucketName = root.bucketName;
          pathPrefix = root.pathPrefix;
        }
      } catch {
        // fall through to the no-bucket error below
      }
      if (!bucketName) {
        return {
          ok: false,
          message:
            "Could not determine project storage from the project home directory. Check project settings and try again.",
        };
      }
      const bucket = bucketName;

      // Reject duplicate normalized paths before uploading (they would overwrite in S3).
      const relPaths = files.map((f) => sanitizeUploadRelativePath(getFileRelativePath(f)));
      const counts = new Map<string, number>();
      relPaths.forEach((p) => counts.set(p, (counts.get(p) ?? 0) + 1));
      const duplicates = [...counts.entries()].filter(([, c]) => c > 1).map(([p]) => p);
      if (duplicates.length > 0) {
        return {
          ok: false,
          message: `Duplicate upload paths after normalization: ${duplicates.join(", ")}. Rename the files or use different folders.`,
        };
      }

      const basePath = pathPrefix
        ? `${pathPrefix}/datasets/${datasetId}/data_files`
        : `datasets/${datasetId}/data_files`;

      setIsUploading(true);
      setUploadProgress({});
      setUploadErrors({});

      const entries: (UploadedFileInfo | undefined)[] = new Array(files.length);
      const localErrors: Record<string, string> = {};

      const uploadOne = async (index: number) => {
        const file = files[index];
        const relativePath = getFileRelativePath(file);
        const s3Key = `${basePath}/${sanitizeUploadRelativePath(relativePath)}`;
        try {
          setUploadProgress((prev) => ({ ...prev, [relativePath]: 0 }));
          await putObject(bucket, s3Key, file, (uploaded, total) => {
            const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;
            setUploadProgress((prev) => ({ ...prev, [relativePath]: pct }));
          });
          setUploadProgress((prev) => ({ ...prev, [relativePath]: 100 }));
          entries[index] = {
            key: s3Key,
            url: `s3://${bucket}/${s3Key}`,
            size: file.size,
            originalName: relativePath,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to upload file";
          localErrors[relativePath] = message;
          setUploadErrors((prev) => ({ ...prev, [relativePath]: message }));
        }
      };

      await runWithConcurrency(files.length, MANUAL_UPLOAD_CONCURRENCY, uploadOne);
      setIsUploading(false);

      if (Object.keys(localErrors).length > 0) {
        return { ok: false, message: `Failed to upload ${Object.keys(localErrors).length} file(s).` };
      }

      const uploadedFiles = entries.filter((e): e is UploadedFileInfo => e != null);
      return { ok: true, files: uploadedFiles };
    },
    [fetchProject, projectId],
  );

  // Maps a kept existing manifest file → UploadedFileInfo for re-registration.
  // The backend only consumes `url` when rebuilding the manifest, so a derived
  // key + the original name are sufficient.
  const existingFileToUploadInfo = useCallback((file: DatasetManifestFile): UploadedFileInfo => {
    const url = file.uri as string;
    const key = url.replace(/^s3:\/\/[^/]+\//, "");
    return { key, url, originalName: file.file_name };
  }, []);

  // Registers the complete file list on the dataset (replaces the draft manifest)
  // and commits the draft so the import workflow runs. Used in edit mode where the
  // backend does NOT auto-commit. Returns ok=false (with a message) on failure.
  const registerAndCommit = useCallback(
    async (datasetId: string, files: UploadedFileInfo[]): Promise<{ ok: boolean; message?: string }> => {
      await updateDataset({ projectId, dsetId: datasetId, body: { uploaded_files: files } }).unwrap();
      // The register call created/replaced a draft manifest; find and commit it.
      const list = await fetchManifests({ projectId, dsetId: datasetId }).unwrap();
      const draft = list.find((m) => m.status === "draft");
      if (!draft) {
        return { ok: false, message: "Files were saved but the draft manifest could not be found to import." };
      }
      await commitManifest({ projectId, dsetId: datasetId, manifestId: draft.id, status: "committed" }).unwrap();
      return { ok: true };
    },
    [projectId, updateDataset, fetchManifests, commitManifest],
  );

  // Label items — start with defaults, allow user-added entries
  const [labelItems, setLabelItems] = useState(() => {
    const items = [...DEFAULT_LABEL_ITEMS];
    if (initialData?.labels) {
      for (const label of initialData.labels) {
        if (!items.some((i) => i.value === label)) {
          items.push({ key: label, value: label, label });
        }
      }
    }
    return items;
  });

  const isSubmitting = isCreating || isUpdating || isUploading;
  const pageTitle = isEdit ? "Edit dataset" : "Create dataset";
  const submitLabel = isEdit ? "Save" : "Add";

  const defaultValues = useMemo(() => buildDefaultValues(initialData), [initialData]);

  // Set right before an intentional post-submit navigation so the dirty-form
  // navigation guard (useBlocker below) doesn't pop the "Discard changes?"
  // dialog on a successful Add/Save. A ref (not state) keeps the value
  // readable inside the blocker callback at navigation time without depending
  // on a re-render landing first.
  const skipBlockerRef = useRef(false);

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: ({ value }) => validateDatasetFormOnSubmit({ value, isEdit }),
    },
    onSubmit: async ({ value }) => {
      try {
        if (isEdit && initialData) {
          const delta = buildEditDelta(value, initialData);
          const hasMetadataChanges = Object.keys(delta).length > 0;

          // Manual-upload file changes: newly added files and/or removed existing
          // files. Both count as changes even when no metadata field changed.
          const newFiles = value.input_type === "upload" ? (value.uploaded_files as File[]) : [];
          const keptExisting = existingFiles.filter((f) => !removedExistingIds.has(f.id));
          const removedCount = existingFiles.length - keptExisting.length;
          const fileSetChanged =
            value.input_type === "upload" && (newFiles.length > 0 || removedCount > 0);

          if (!hasMetadataChanges && !fileSetChanged) {
            toast.info("No changes to save.");
            return;
          }

          // A manual dataset must keep at least one file; the backend ignores an
          // empty file list (won't re-import), so block removing everything.
          if (fileSetChanged && keptExisting.length === 0 && newFiles.length === 0) {
            toast.warning("A dataset must contain at least one file. Add a file before removing the rest.");
            return;
          }

          // Re-registration rebuilds the manifest from the kept existing files plus
          // new uploads. Files without a URI can't be carried forward, so changing
          // the file set would silently drop them. Block the commit (metadata-only
          // edits are unaffected) rather than lose data.
          if (fileSetChanged && hasUnresolvableExistingFiles) {
            toast.warning(
              "Some existing files are missing their storage location and can't be preserved when the file set changes. Undo your file changes to save other edits.",
            );
            return;
          }

          if (hasMetadataChanges) {
            await updateDataset({
              projectId,
              dsetId: initialData.dset_id,
              body: delta,
            }).unwrap();
          }

          // Upload new files, merge with the kept existing files into the complete
          // list, register it (replaces the draft manifest), then commit so import
          // runs. Keep the user on the form if anything fails so they can retry.
          if (fileSetChanged) {
            const uploaded = await uploadFilesToS3(initialData.dset_id, newFiles);
            if (!uploaded.ok) {
              toast.warning(uploaded.message ?? "Some files failed to upload.");
              return;
            }
            const merged: UploadedFileInfo[] = [
              ...keptExisting.map(existingFileToUploadInfo),
              ...(uploaded.files ?? []),
            ];
            const committed = await registerAndCommit(initialData.dset_id, merged);
            if (!committed.ok) {
              toast.warning(committed.message ?? "Files uploaded, but the import could not be started.");
              return;
            }
            toast.success("Dataset updated. Files saved — import started.");
          } else {
            toast.success("Dataset updated successfully.");
          }
          skipBlockerRef.current = true;
          navigate(dataManagementPaths.datasetDetail(initialData.dset_id));
        } else {
          const spec = buildSpecPayload(value);
          const refreshConfig = buildRefreshConfigPayload(value);
          const sqlQuery = value.schema_query.trim() || undefined;
          const created = await createDataset({
            projectId,
            body: {
              name: value.name,
              input_type: value.input_type,
              kind: value.kind as DatasetKind,
              /* v8 ignore next 2 -- @preserve: dataSourceIdFieldValidators.onSubmit blocks submission with empty data_source_id, making the falsy path unreachable */
              data_source_id:
                value.input_type === "data-source" ? value.data_source_id || undefined : undefined,
              // Origin routing (originVolume vs originConnector). Derived from the
              // selected source's category; omitted when unknown so the slice
              // defaults to the volume origin.
              data_source_origin_kind:
                value.input_type === "data-source"
                  ? toDataSourceOriginKind(value.data_source_category)
                  : undefined,
              description: value.description || undefined,
              labels: value.labels as string[],
              spec,
              // Connector-resource selectors (object store / database / metrics).
              // Empty for volume sources, which scope via spec.paths.
              resource_selector:
                value.input_type === "data-source" && value.resource_selector?.length
                  ? value.resource_selector
                  : undefined,
              sql_query: sqlQuery,
              refresh_config:
                value.input_type === "data-source" ? refreshConfig : undefined,
            },
          }).unwrap();

          // Manual upload: push the selected files to S3 and register them on
          // the dataset (backend auto-commits the first batch → triggers import).
          const filesToUpload = value.input_type === "upload" ? (value.uploaded_files as File[]) : [];
          if (filesToUpload.length > 0 && created.dset_id) {
            const uploaded = await uploadFilesToS3(created.dset_id, filesToUpload);
            if (uploaded.ok) {
              // Registering the first batch auto-commits on the backend → import.
              await updateDataset({
                projectId,
                dsetId: created.dset_id,
                body: { uploaded_files: uploaded.files ?? [] },
              }).unwrap();
              toast.success("Dataset created. Uploading complete — import started.");
            } else {
              toast.warning(uploaded.message ?? "Dataset created, but some files failed to upload.");
            }
            skipBlockerRef.current = true;
            navigate(dataManagementPaths.datasetDetail(created.dset_id));
            return;
          }

          // Acquired (data-source) datasets: the Iceberg table is only created
          // when acquisition runs (this is also when the schema-scope SQL query,
          // if any, executes), so kick it off immediately after creation and send
          // the user to the detail page to watch the run. Mirrors the GUI, which
          // auto-acquires every newly created acquired dataset. We don't block
          // creation on the acquire call succeeding.
          const isAcquired =
            value.input_type === "data-source" && Boolean(value.data_source_id);
          if (isAcquired && created.dset_id) {
            try {
              await acquireDataset({ projectId, dsetId: created.dset_id }).unwrap();
              toast.success(
                sqlQuery
                  ? "Dataset created. Running query…"
                  : "Dataset created. Acquisition started.",
              );
            } catch {
              toast.warning("Dataset created, but acquisition could not be started.");
            }
            skipBlockerRef.current = true;
            navigate(dataManagementPaths.datasetDetail(created.dset_id));
          } else {
            toast.success("Dataset created successfully.");
            skipBlockerRef.current = true;
            navigate(dataManagementPaths.datasets);
          }
        }
      } catch (error) {
        const fallback = isEdit ? "Failed to update dataset." : "Failed to create dataset.";
        const message =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : extractApiErrorMessage(error, fallback);
        toast.error(message);
      }
    },
  }) as unknown as AnyReactFormApi;

  const handleAddLabel = useCallback((value: string) => {
    const trimmed = value.trim().toLowerCase();
    /* v8 ignore if -- @preserve: SelectDropdown never calls onAddNew with blank text */
    if (!trimmed) return;
    setLabelItems((prev) => {
      /* v8 ignore if -- @preserve: SelectDropdown disables "Add" for existing items */
      if (prev.some((i) => i.value === trimmed)) return prev;
      return [...prev, { key: trimmed, value: trimmed, label: trimmed }];
    });
    const current = (form.state.values.labels as string[]) ?? [];
    if (!current.includes(trimmed)) {
      form.setFieldValue("labels", [...current, trimmed]);
    }
  }, [form]);

  // Unsaved-changes guard. Metadata/scope edits arm it via a form-vs-defaults
  // comparison. `uploaded_files` is a File[] that doesn't serialize meaningfully,
  // so it's excluded here and the file set is checked separately below. Compared
  // against the form's defaults so it works for both create (empty defaults) and
  // edit (initialData-derived).
  const metadataDirty = useStore(form.store, (s) => {
    const { uploaded_files: _currentFiles, ...currentRest } = s.values;
    const { uploaded_files: _defaultFiles, ...defaultRest } = defaultValues;
    void _currentFiles;
    void _defaultFiles;
    return JSON.stringify(currentRest) !== JSON.stringify(defaultRest);
  });
  // Genuine file-set changes — newly staged uploads or removed committed files —
  // must also arm the prompt, mirroring the submit-time `fileSetChanged` check.
  // Otherwise removing a committed file (which lives in `removedExistingIds`,
  // separate from form state) and navigating away silently drops the removal.
  const stagedUploadCount = useStore(form.store, (s) =>
    s.values.input_type === "upload" ? ((s.values.uploaded_files as File[])?.length ?? 0) : 0,
  );
  const isUploadType = useStore(form.store, (s) => s.values.input_type === "upload");
  const fileSetDirty = isUploadType && (stagedUploadCount > 0 || removedExistingIds.size > 0);
  const hasUnsavedEdits = metadataDirty || fileSetDirty;
  // Block navigation when the form is dirty, but not during submission or after
  // a successful submit (which navigates away intentionally). Evaluated lazily
  // at navigation time so the post-submit `skipBlockerRef` bypass is honored
  // without relying on a re-render flushing isSubmitting back to false first.
  const blocker = useBlocker(
    useCallback(
      () => hasUnsavedEdits && !isSubmitting && !skipBlockerRef.current,
      [hasUnsavedEdits, isSubmitting],
    ),
  );
  const isBlocked = blocker.state === "blocked";

  const navigateBack = useCallback(() => {
    if (isEdit && initialData) {
      navigate(dataManagementPaths.datasetDetail(initialData.dset_id));
    } else {
      navigate(dataManagementPaths.datasets);
    }
  }, [isEdit, initialData, navigate]);

  // Name validation (create mode only)
  const nameValidatorSync = useCallback(
    ({ value }: { value: string }): string | undefined => {
      if (isEdit) return undefined;
      return getDatasetNameFieldError(value);
    },
    [isEdit],
  );

  const inputType: DatasetInputType = useStore(form.store, (s) => s.values.input_type);

  const handleInputTypeChange = useCallback((type: DatasetInputType) => {
    form.setFieldValue("input_type", type);
    form.setFieldValue("kind", "unstructured");
    // Reset type-specific fields
    form.setFieldValue("data_source_id", "");
    form.setFieldValue("data_source_category", null);
    form.setFieldValue("uploaded_files", []);
    // Reset data-source-only scope config so a previously configured folder/file
    // scope or schema query can't leak onto an upload dataset (which would
    // otherwise be sent as a stale filterSpec / sqlQuery and even flip the
    // dataset to `structured`). Restores the create-mode spec defaults.
    form.setFieldValue("spec.folder_scope", "all");
    form.setFieldValue("spec.paths", ["/"]);
    form.setFieldValue("spec.file_types", "");
    form.setFieldValue("spec.last_modified_filter", "all");
    form.setFieldValue("spec.max_file_size_bytes", "");
    form.setFieldValue("spec.exclude_patterns", "");
    form.setFieldValue("schema_query", "");
    if (type === "upload") {
      form.setFieldValue("sync_enabled", false);
    }
  }, [form]);

  return (
    <div className="dset-form-page">
      {/* Top bar */}
      <div className="dset-form-page__top-bar">
        <Typography Component="h1" fontSize="fs16" boldness="semibold" className="dset-form-page__top-bar-title">
          {pageTitle}
        </Typography>
        <Button variant="icon" icon={<IconX size={20} />} onClick={navigateBack} aria-label="Close" />
      </div>

      {/* Scrollable body */}
      <div className="dset-form-page__body">
        <div className="dset-form-page__body-inner">
          <div className="dset-form-page__header">
            <Typography Component="h2" fontSize="fs20" boldness="semibold">
              Dataset
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
              Select a data source or upload files, define the scope of content to include, and set a sync schedule. 
              <br />
              Your dataset provides the content for building a knowledge base and agents.
            </Typography>
          </div>

          <Card className="dset-form-page__form-card">
            <CardContent>
              <Form form={form}>
                {/* Details section */}
                <CardBlock type="description" hasSeparator>
                  <DetailsSection
                    form={form}
                    isEdit={isEdit}
                    labelItems={labelItems}
                    onAddLabel={handleAddLabel}
                    nameValidatorSync={nameValidatorSync}
                  />
                </CardBlock>

                {/* Data source / Upload section */}
                <CardBlock type="description" hasSeparator={inputType === "data-source"}>
                  <DataSourceSection
                    form={form}
                    isEdit={isEdit}
                    inputType={inputType}
                    onInputTypeChange={handleInputTypeChange}
                    initialData={initialData}
                    uploadProgress={uploadProgress}
                    uploadErrors={uploadErrors}
                    existingFiles={existingFiles}
                    removedExistingIds={removedExistingIds}
                    onToggleRemoveExisting={toggleRemoveExisting}
                  />
                </CardBlock>

                {/* Spec section (create mode only — edit mode scope is inside DataSourceSection) */}
                {inputType === "data-source" && !isEdit && (
                  <CardBlock type="description" hasSeparator>
                    <SpecSection form={form} />
                  </CardBlock>
                )}

                {/* Sync settings section (inline) */}
                <CardBlock type="description">
                  <SyncSettingsSection form={form} scheduleDisabled={inputType === "upload"} />
                </CardBlock>
              </Form>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Sticky footer */}
      <div className="dset-form-page__footer">
        <Button
          type="button"
          variant="solid"
          label={submitLabel}
          loading={isSubmitting}
          onClick={async () => {
            await runFormHandleSubmit(form);
            const validationError = collectFirstFormValidationError(form);
            if (validationError) {
              toast.error(validationError);
              scrollToFirstFormError();
            }
          }}
        />
        <Button type="button" variant="outline" label="Cancel" onClick={navigateBack} isDisabled={isSubmitting} />
      </div>

      {/* Discard Changes Dialog */}
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

export { DatasetForm };
export type { DatasetFormProps };
