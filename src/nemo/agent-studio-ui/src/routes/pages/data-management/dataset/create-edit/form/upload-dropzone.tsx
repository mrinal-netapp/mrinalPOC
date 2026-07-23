import { useState, useCallback, useRef, useEffect, type ReactElement, type ChangeEvent } from "react";
import { IconPlus, IconX, IconAlertCircle, IconInfoCircle, IconRestore } from "@tabler/icons-react";
import { useStore } from "@tanstack/react-store";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import type { DatasetManifestFile } from "@/api/dataset.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Button } from "@/ui-lib/base-components/button/button";

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB per file
const MAX_TOTAL_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB across all new uploads

interface FileEntry {
  id: string;
  file: File;
  displayPath: string;
  status: "ready" | "error";
  error?: string;
}

interface UploadDropzoneProps {
  form: AnyReactFormApi;
  /** Live upload progress (0–100), keyed by each file's upload-relative path. */
  uploadProgress?: Record<string, number>;
  /** Upload error messages, keyed by each file's upload-relative path. */
  uploadErrors?: Record<string, string>;
  /** Existing files already on the dataset (edit mode). */
  existingFiles?: DatasetManifestFile[];
  /** IDs of existing files the user marked for removal. */
  removedExistingIds?: Set<string>;
  /** Toggles removal of an existing file by id. */
  onToggleRemoveExisting?: (id: string) => void;
}

function getUploadKey(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function UploadDropzone({
  form,
  uploadProgress,
  uploadErrors,
  existingFiles,
  removedExistingIds,
  onToggleRemoveExisting,
}: UploadDropzoneProps): ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Keep form's uploaded_files in sync — used only to seed initial state
  const rawFiles: File[] | undefined = useStore(form.store, (s) => s.values.uploaded_files);

  const [entries, setEntries] = useState<FileEntry[]>(() =>
    (rawFiles ?? []).map((file, i) => ({
      id: `init-${i}-${file.name}`,
      file,
      displayPath: file.name,
      status: "ready",
    })),
  );

  // Set webkitdirectory imperatively to avoid TypeScript complaints
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
    }
  }, []);

  // Sync ready files back to the form whenever entries change. This runs in an
  // effect (after commit) instead of inside a setState updater, so it never
  // triggers a store update on other subscribers during render.
  useEffect(() => {
    const validFiles = entries.filter((e) => e.status === "ready").map((e) => e.file);
    form.setFieldValue("uploaded_files", validFiles);
  }, [entries, form]);

  const addFiles = useCallback((newFiles: File[], getPath?: (f: File) => string) => {
    const timestamp = Date.now();
    // Validate synchronously and append in a single update — file checks are
    // local/instant, so there's no async work to wait on (and no timer that
    // could fire after unmount).
    setEntries((prev) => {
      // Bytes already committed by ready files — new files are accepted only
      // while the running total stays within the 1 GB cap.
      let total = prev
        .filter((e) => e.status === "ready")
        .reduce((sum, e) => sum + e.file.size, 0);
      const newEntries: FileEntry[] = newFiles.map((file, i) => {
        const base = {
          id: `${timestamp}-${i}-${file.name}`,
          file,
          displayPath: getPath ? getPath(file) : file.name,
        };
        if (file.size > MAX_FILE_SIZE_BYTES) {
          return { ...base, status: "error" as const, error: "file exceeds 500 MB limit" };
        }
        if (total + file.size > MAX_TOTAL_UPLOAD_BYTES) {
          return { ...base, status: "error" as const, error: "total upload exceeds 1 GB limit" };
        }
        total += file.size;
        return { ...base, status: "ready" as const };
      });
      return [...prev, ...newEntries];
    });
  }, []);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      addFiles(Array.from(e.target.files));
      e.target.value = "";
    },
    [addFiles],
  );

  const handleFolderChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      addFiles(Array.from(e.target.files), (f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
      e.target.value = "";
    },
    [addFiles],
  );

  const handleRemove = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return (
    <div className="dset-form__upload">
      <div className="dset-form__upload-header">
        <Typography Component="h3" fontSize="fs14" boldness="semibold">
          Upload files
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          Upload PDF, DOCX, TXT, XLSX, PPTX, HTML, or MD files to your dataset. Individual files
          <br/>
          must be 500 MB or less, with a total upload limit of 1 GB. Note that folder and file
          scopes
          <br/>
          don&apos;t apply to these uploads.
        </Typography>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="dset-form__upload-input"
        onChange={handleFileChange}
        accept=".pdf,.docx,.txt,.xlsx,.pptx,.html,.md"
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="dset-form__upload-input"
        onChange={handleFolderChange}
        accept=".pdf,.docx,.txt,.xlsx,.pptx,.html,.md"
      />

      <div className="dset-form__upload-buttons">
        <Button
          variant="outline"
          label="Upload files"
          icon={<IconPlus size={16} />}
          onClick={() => fileInputRef.current?.click()}
        />
        <Button
          variant="outline"
          label="Upload folder"
          icon={<IconPlus size={16} />}
          onClick={() => folderInputRef.current?.click()}
        />
      </div>

      {existingFiles && existingFiles.length > 0 && (
        <div className="dset-form__upload-existing">
          <Typography Component="span" fontSize="fs14" boldness="semibold" color="var(--text-secondary)">
            Existing files
          </Typography>
          <div className="dset-form__upload-list">
            {existingFiles.map((file) => {
              const removed = removedExistingIds?.has(file.id) ?? false;
              return (
                <div
                  key={file.id}
                  className={[
                    "dset-form__upload-file",
                    removed ? "dset-form__upload-file--removed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <Typography
                    Component="span"
                    fontSize="fs14"
                    boldness="regular"
                    color={removed ? "var(--text-secondary)" : undefined}
                    className={removed ? "dset-form__upload-file-name--struck" : undefined}
                  >
                    {file.file_name}
                  </Typography>
                  <Button
                    variant="icon"
                    icon={removed ? <IconRestore size={16} /> : <IconX size={16} />}
                    onClick={() => onToggleRemoveExisting?.(file.id)}
                    aria-label={removed ? `Restore ${file.file_name}` : `Remove ${file.file_name}`}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="dset-form__upload-list">
          {entries.map((entry) => {
            const uploadKey = getUploadKey(entry.file);
            const progress = uploadProgress?.[uploadKey];
            const uploadErr = uploadErrors?.[uploadKey];
            const isUploadingFile = progress !== undefined && progress < 100 && !uploadErr;
            return (
              <div key={entry.id} className="dset-form__upload-file-wrapper">
                <div
                  className={[
                    "dset-form__upload-file",
                    entry.status === "error" || uploadErr ? "dset-form__upload-file--error" : "",
                    isUploadingFile ? "dset-form__upload-file--loading" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    {entry.displayPath}
                  </Typography>
                  {isUploadingFile ? (
                    <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                      {progress}%
                    </Typography>
                  ) : progress === 100 && !uploadErr ? (
                    <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                      Uploaded
                    </Typography>
                  ) : (
                    <Button
                      variant="icon"
                      icon={<IconX size={16} />}
                      onClick={() => handleRemove(entry.id)}
                      aria-label={`Remove ${entry.displayPath}`}
                    />
                  )}
                </div>
                {(uploadErr || (entry.status === "error" && entry.error)) && (
                  <div className="dset-form__upload-file-error">
                    <IconAlertCircle size={14} />
                    <Typography Component="span" fontSize="fs14" boldness="regular">
                      Error: {uploadErr ?? entry.error}
                    </Typography>
                    <IconInfoCircle size={14} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { UploadDropzone };
