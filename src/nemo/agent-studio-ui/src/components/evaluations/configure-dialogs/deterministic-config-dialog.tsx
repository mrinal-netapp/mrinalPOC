import { useCallback, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { IconChevronLeft, IconChevronRight, IconUpload, IconX } from '@tabler/icons-react';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/ui-lib/base-components/dialog/dialog';
import { Button } from '@/ui-lib/base-components/button/button';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui-lib/base-components/baseTableMcpBxp/table/table';
import type { EvalDatasetColumnMapping } from '@/routes/pages/evaluations/api/eval.types';

import './configure-dialog.scss';

const PREVIEW_PAGE_SIZE = 5;

type ParsedRow = Record<string, string>;

type ParsedFile = {
  columns: string[];
  rows: ParsedRow[];
};

type TestCaseRow = {
  id: string;
  query: string;
  expected?: string;
};

const ID_COLUMN_CANDIDATES = ['id'];
const QUERY_COLUMN_CANDIDATES = ['query', 'question', 'prompt', 'input'];
const EXPECTED_COLUMN_CANDIDATES = ['expected', 'expected answer', 'expected_answer', 'answer', 'output'];

/** Maps detected file columns to id / query / expected by common header names. */
function detectColumns(columns: string[]): EvalDatasetColumnMapping {
  const find = (candidates: string[]): string =>
    columns.find((column) => candidates.includes(column.toLowerCase())) ?? '';
  return {
    id: find(ID_COLUMN_CANDIDATES),
    query: find(QUERY_COLUMN_CANDIDATES),
    expected: find(EXPECTED_COLUMN_CANDIDATES) || undefined,
  };
}

type MetricDef = {
  id: string;
  title: string;
  description: string;
};

const METRIC_CATALOG: MetricDef[] = [
  { id: 'rag_quality', title: 'RAG quality', description: 'Groundedness and retrieval precision and recall of evidence versus the answer.' },
  { id: 'correctness', title: 'Correctness', description: 'Exact match, BLEU, ROUGE-L, and Token F1 versus expected answers.' },
  { id: 'performance', title: 'Performance', description: 'Average latency, P95 latency, and P99 latency versus budgets.' },
  { id: 'token_usage', title: 'Token usage', description: 'Average, maximum, and total tokens plus total cost for the run.' },
];

type DeterministicConfigSavePayload = {
  metricIds: string[];
  datasetColumnMapping: EvalDatasetColumnMapping;
  uploadedFileName: string;
  /**
   * Raw File the operator picked. Held alongside the parsed preview so
   * eval-form can PUT the bytes directly to S3 at submit time. ``null``
   * when the dialog is reopened without re-uploading.
   */
  uploadedFile: File | null;
};

type DeterministicConfigDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedMetricIds: string[];
  datasetColumnMapping: EvalDatasetColumnMapping;
  uploadedFileName: string;
  onSave: (payload: DeterministicConfigSavePayload) => void;
};

function normalizeRecord(value: unknown): ParsedRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: ParsedRow = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    record[key] = raw === null || raw === undefined ? '' : String(raw);
  }
  return record;
}

function splitCsvLine(line: string): string[] {
  // Minimal CSV split supporting double-quoted fields with embedded commas.
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Reads an uploaded CSV / JSON / JSONL file and returns the detected columns plus
 * all parsed rows so the user can map columns and preview the data. Returns empty
 * results when the file can't be parsed (mapping stays empty and Save is blocked).
 */
async function parseFile(file: File): Promise<ParsedFile> {
  const text = await file.text();
  const trimmed = text.trim();
  const empty: ParsedFile = { columns: [], rows: [] };
  if (!trimmed) return empty;

  const lowerName = file.name.toLowerCase();
  const looksJson = lowerName.endsWith('.json') || (!lowerName.endsWith('.csv') && (trimmed.startsWith('{') || trimmed.startsWith('[')));

  // JSON array / single object.
  if (looksJson && !lowerName.endsWith('.jsonl')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const rows = list.map(normalizeRecord).filter((row): row is ParsedRow => row !== null);
      if (rows.length === 0) return empty;
      return { columns: Object.keys(rows[0]), rows };
    } catch {
      return empty;
    }
  }

  // JSONL: one JSON object per line.
  if (lowerName.endsWith('.jsonl')) {
    const rows = trimmed
      .split(/\r?\n/)
      .map((line) => {
        try {
          return normalizeRecord(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((row): row is ParsedRow => row !== null);
    if (rows.length === 0) return empty;
    return { columns: Object.keys(rows[0]), rows };
  }

  // CSV: first line is the header row, remaining lines are records.
  // `trimmed` is non-empty here, so there is always at least one line.
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const columns = splitCsvLine(lines[0]).map((column) => column.replace(/^["']|["']$/g, '')).filter(Boolean);
  if (columns.length === 0) return empty;
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const record: ParsedRow = {};
    columns.forEach((column, idx) => {
      record[column] = (cells[idx] ?? '').replace(/^["']|["']$/g, '');
    });
    return record;
  });
  return { columns, rows };
}

function DeterministicConfigDialog({
  open,
  onOpenChange,
  selectedMetricIds,
  datasetColumnMapping,
  uploadedFileName,
  onSave,
}: DeterministicConfigDialogProps): ReactElement {
  const [draftIds, setDraftIds] = useState<string[]>(selectedMetricIds);
  const [draftMapping, setDraftMapping] = useState<EvalDatasetColumnMapping>(datasetColumnMapping);
  const [draftFileName, setDraftFileName] = useState<string>(uploadedFileName);
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [previewPage, setPreviewPage] = useState(1);
  const [fileError, setFileError] = useState<string>('');
  const [showFileRequired, setShowFileRequired] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset draft state during render when the dialog transitions to open, so each
  // open starts from the latest saved config without an effect-driven cascade.
  if (open && !wasOpen) {
    setWasOpen(true);
    setDraftIds(selectedMetricIds);
    setDraftMapping(datasetColumnMapping);
    setDraftFileName(uploadedFileName);
    setDraftFile(null);
    setParsedRows([]);
    setPreviewPage(1);
    setFileError('');
    setShowFileRequired(false);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const toggleMetric = useCallback((id: string) => {
    setDraftIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  }, []);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setDraftFileName(file.name);
    setDraftFile(file);
    setFileError('');
    setShowFileRequired(false);
    setPreviewPage(1);

    const { columns: parsedColumns, rows } = await parseFile(file);
    if (parsedColumns.length === 0) {
      setParsedRows([]);
      setFileError('Could not read this file. Use a CSV or JSON file with ID, Query, and Expected answer columns.');
      return;
    }

    const detected = detectColumns(parsedColumns);
    if (!detected.id || !detected.query) {
      setParsedRows([]);
      setFileError('File must contain ID and Query columns (Expected answer is optional).');
      return;
    }

    setParsedRows(rows);
    setDraftMapping(detected);
  }, []);

  const isUpload = true;
  const hasValidFile = isUpload && !!draftFileName && parsedRows.length > 0 && !fileError;

  const displayRows: TestCaseRow[] = useMemo(() => {
    if (!hasValidFile) return [];
    return parsedRows.map((row) => ({
      id: row[draftMapping.id] || '',
      query: row[draftMapping.query] || '',
      expected: draftMapping.expected ? row[draftMapping.expected] : undefined,
    }));
  }, [hasValidFile, parsedRows, draftMapping]);

  const totalPreviewPages = Math.max(1, Math.ceil(displayRows.length / PREVIEW_PAGE_SIZE));
  const previewPageSafe = Math.min(previewPage, totalPreviewPages);
  const previewRows = useMemo(() => {
    const start = (previewPageSafe - 1) * PREVIEW_PAGE_SIZE;
    return displayRows.slice(start, start + PREVIEW_PAGE_SIZE);
  }, [displayRows, previewPageSafe]);

  const handleSave = useCallback(() => {
    if (isUpload && !hasValidFile) {
      setShowFileRequired(true);
      return;
    }
    onSave({
      metricIds: draftIds,
      datasetColumnMapping: draftMapping,
      uploadedFileName: draftFileName,
      uploadedFile: draftFile,
    });
    onOpenChange(false);
  }, [isUpload, hasValidFile, onSave, draftIds, draftMapping, draftFileName, draftFile, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogPopup className="configure-dialog__popup">
        <DialogHeader>
          <DialogTitle>Configure deterministic metrics</DialogTitle>
        </DialogHeader>

        <div className="configure-dialog__body">
          <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
            Select metrics to run for this dataset and suite.
          </Typography>

          <div className="configure-dialog__table">
            <div className="configure-dialog__table-header">
              <span className="configure-dialog__table-cell configure-dialog__table-cell--check">
                <input
                  type="checkbox"
                  checked={draftIds.length === METRIC_CATALOG.length}
                  onChange={() => {
                    if (draftIds.length === METRIC_CATALOG.length) {
                      setDraftIds([]);
                    } else {
                      setDraftIds(METRIC_CATALOG.map((m) => m.id));
                    }
                  }}
                  aria-label="Select all metrics"
                />
              </span>
              <Typography Component="span" fontSize="fs12" boldness="semibold" color="var(--text-secondary)" className="configure-dialog__table-cell">
                Metric
              </Typography>
              <Typography Component="span" fontSize="fs12" boldness="semibold" color="var(--text-secondary)" className="configure-dialog__table-cell configure-dialog__table-cell--desc">
                Description
              </Typography>
            </div>
            {METRIC_CATALOG.map((metric) => (
              <div key={metric.id} className="configure-dialog__table-row">
                <span className="configure-dialog__table-cell configure-dialog__table-cell--check">
                  <input
                    type="checkbox"
                    checked={draftIds.includes(metric.id)}
                    onChange={() => toggleMetric(metric.id)}
                    aria-label={`Select ${metric.title}`}
                  />
                </span>
                <Typography Component="span" fontSize="fs14" boldness="regular" className="configure-dialog__table-cell">
                  {metric.title}
                </Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="configure-dialog__table-cell configure-dialog__table-cell--desc">
                  {metric.description}
                </Typography>
              </div>
            ))}
          </div>

          <div className="configure-dialog__test-cases">
            <div className="configure-dialog__test-cases-header">
              <Typography Component="span" fontSize="fs14" boldness="semibold">
                Upload test cases
              </Typography>
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                Select a CSV or JSON file to add test cases and expected results.
              </Typography>
            </div>

            <div className="configure-dialog__upload">
                <div className="configure-dialog__upload-row">
                  {/*
                    The file input is a transparent overlay on top of the styled span.
                    The user clicks the input DIRECTLY — no programmatic .click(), no
                    label indirection. This is the only approach that works in all
                    browsers and inside all dialog/portal contexts.
                  */}
                  <span className="configure-dialog__upload-trigger">
                    <span className="btn btn-variant-outline btn-size-medium configure-dialog__upload-label">
                      <span className="btn-icon"><IconUpload size={16} /></span>
                      <span className="btn-label">Select file</span>
                    </span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="configure-dialog__upload-trigger-input"
                      accept=".csv,.json,.jsonl,text/csv,application/json"
                      onChange={handleFileChange}
                    />
                  </span>
                  {draftFileName && (
                    <span className="configure-dialog__upload-file">
                      <Typography Component="span" fontSize="fs14" boldness="regular">
                        {draftFileName}
                      </Typography>
                      <Button
                        type="button"
                        variant="icon"
                        size="small"
                        icon={<IconX size={14} />}
                        aria-label="Remove file"
                        onClick={() => {
                          setDraftFileName('');
                          setParsedRows([]);
                          setPreviewPage(1);
                          setFileError('');
                          setDraftMapping({ id: '', query: '', expected: undefined });
                          // The input is always mounted while this Remove button is visible.
                          fileInputRef.current!.value = '';
                        }}
                      />
                    </span>
                  )}
                </div>

                {fileError && (
                  <Typography Component="p" fontSize="fs12" boldness="regular" color="var(--notification-error)">
                    {fileError}
                  </Typography>
                )}

                {showFileRequired && !draftFileName && !fileError && (
                  <Typography Component="p" fontSize="fs12" boldness="regular" color="var(--notification-error)">
                    File is required.
                  </Typography>
                )}

                <div className="configure-dialog__preview">
                  <Typography Component="span" fontSize="fs14" boldness="semibold">
                    Test cases preview
                  </Typography>
                  <Typography Component="span" fontSize="fs12" boldness="regular" color="var(--text-secondary)">
                    Your file must contain ID and Query columns. Expected answer is optional.
                  </Typography>
                  <div className="configure-dialog__preview-table">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead style={{ width: 80 }}>ID</TableHead>
                          <TableHead>Query</TableHead>
                          <TableHead>
                            Expected answer
                            <Typography Component="span" fontSize="fs12" boldness="regular" color="var(--text-secondary)">
                              {' '}(optional)
                            </Typography>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {previewRows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3}>
                              <Typography
                                Component="span"
                                fontSize="fs14"
                                boldness="regular"
                                color="var(--text-disabled)"
                                className="configure-dialog__preview-empty"
                              >
                                Upload a CSV or JSON file to preview test cases here.
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ) : (
                          previewRows.map((row, idx) => (
                            <TableRow key={`${row.id || 'row'}-${idx}`}>
                              <TableCell>
                                <Typography Component="span" fontSize="fs14" boldness="regular">
                                  {row.id || '—'}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography Component="span" fontSize="fs14" boldness="regular">
                                  {row.query || '—'}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                                  {row.expected || '—'}
                                </Typography>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  {hasValidFile && displayRows.length > PREVIEW_PAGE_SIZE && (
                    <div className="configure-dialog__preview-pagination">
                      <Typography Component="span" fontSize="fs12" boldness="regular" color="var(--text-secondary)">
                        {`Page ${previewPageSafe} of ${totalPreviewPages} · ${displayRows.length} test cases`}
                      </Typography>
                      <span className="configure-dialog__preview-pager">
                        <Button
                          type="button"
                          variant="icon"
                          size="small"
                          icon={<IconChevronLeft size={16} />}
                          aria-label="Previous page"
                          isDisabled={previewPageSafe <= 1}
                          onClick={() => setPreviewPage((page) => Math.max(1, page - 1))}
                        />
                        <Button
                          type="button"
                          variant="icon"
                          size="small"
                          icon={<IconChevronRight size={16} />}
                          aria-label="Next page"
                          isDisabled={previewPageSafe >= totalPreviewPages}
                          onClick={() => setPreviewPage((page) => Math.min(totalPreviewPages, page + 1))}
                        />
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="solid" label="Save" onClick={handleSave} />
          <Button type="button" variant="outline" label="Cancel" onClick={() => onOpenChange(false)} />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export { DeterministicConfigDialog, METRIC_CATALOG };
export type { DeterministicConfigSavePayload };
