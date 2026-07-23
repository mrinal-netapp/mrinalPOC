import { useCallback, useMemo, useState, type ReactElement } from "react";
import { IconChevronDown, IconChevronRight, IconCopy, IconExternalLink } from "@tabler/icons-react";
import { Link } from "react-router";

import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ROUTES } from "@/routes/routes.consts";
import { AGENTS_STRINGS } from "../../../agents.consts";
import type { PlaygroundExecutionStep } from "../../agent-playground.types";
import {
  getExecutionStepDisplayName,
  isKbRetrievalStep as isKbRetrievalStepFromUtils,
} from "../../agent-playground-execution.utils";
import "./run-details-execution-tab.scss";

const LOG_PREVIEW_MAX_LINES = 6;

type RunDetailsExecutionTabProps = {
  steps: PlaygroundExecutionStep[];
  isLoading: boolean;
  emptyMessage: string;
};

function formatDuration(value: number | null): string {
  return value !== null ? `${value} ms` : "—";
}

function stringifyStepValue(value: unknown): string {
  if (value === undefined) {
    return AGENTS_STRINGS.EXECUTION_RESULT_EMPTY;
  }
  return JSON.stringify(value, null, 2);
}

function isKbRetrievalStep(step: PlaygroundExecutionStep): boolean {
  // Prefer MAF's explicit ``toolType`` discriminator; fall back to the
  // legacy ``search_knowledge_base`` name match for agent-service-shape
  // payloads that don't carry a tool type yet.
  return isKbRetrievalStepFromUtils(step.toolName, step.toolType);
}

function getStepTitle(step: PlaygroundExecutionStep): string {
  return step.displayName ?? getExecutionStepDisplayName(step.toolName);
}

function ExecutionStepStatus({
  step,
  showElapsed = true,
}: {
  step: PlaygroundExecutionStep;
  showElapsed?: boolean;
}): ReactElement {
  if (step.status === "running") {
    return (
      <span className="run-details-execution__step-status">
        <Spinner size="cell" className="run-details-execution__step-spinner" />
        {showElapsed ? (
          <Typography Component="span" fontSize="fs12" color="var(--text-secondary)">
            {formatDuration(step.elapsedMs ?? null)}
          </Typography>
        ) : null}
      </span>
    );
  }

  if (step.status === "failed") {
    return (
      <Typography Component="span" fontSize="fs12" color="var(--color-danger, #d04437)">
        {AGENTS_STRINGS.EXECUTION_STATUS_FAILED}
        {showElapsed ? (
          <>
            {" · "}
            {formatDuration(step.elapsedMs ?? null)}
          </>
        ) : null}
      </Typography>
    );
  }

  return (
    <Typography Component="span" fontSize="fs12" color="var(--text-secondary)">
      {AGENTS_STRINGS.EXECUTION_STATUS_COMPLETED}
      {showElapsed ? (
        <>
          {" · "}
          {formatDuration(step.elapsedMs ?? null)}
        </>
      ) : null}
    </Typography>
  );
}

function KbLogsPanel({ logs }: { logs: string[] }): ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const logText = logs.join("\n");
  const lines = logText.split("\n");
  const isTruncated = lines.length > LOG_PREVIEW_MAX_LINES;
  const visibleText = isExpanded || !isTruncated
    ? logText
    : `${lines.slice(0, LOG_PREVIEW_MAX_LINES).join("\n")}\n…`;

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(logText);
  };

  return (
    <div className="run-details-execution__section">
      <Typography Component="p" fontSize="fs12" boldness="semibold">
        {AGENTS_STRINGS.EXECUTION_KB_LOGS_LABEL}
      </Typography>
      <div className="run-details-execution__logs-panel">
        <button
          type="button"
          className="run-details-execution__logs-copy"
          onClick={handleCopy}
          aria-label={AGENTS_STRINGS.EXECUTION_KB_COPY_LOGS}
        >
          <IconCopy size={16} />
        </button>
        <pre className="run-details-execution__logs">{visibleText}</pre>
        {isTruncated ? (
          <button
            type="button"
            className="run-details-execution__show-more"
            onClick={() => setIsExpanded((expanded) => !expanded)}
          >
            {AGENTS_STRINGS.EXECUTION_KB_SHOW_MORE}
            <IconChevronDown
              size={14}
              className={isExpanded ? "run-details-execution__show-more-icon--expanded" : undefined}
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function KbRetrievalDetailsSection({
  details,
}: {
  details: NonNullable<PlaygroundExecutionStep["kbRetrievalDetails"]>;
}): ReactElement {
  const knowledgeBaseHref = details.knowledgeBaseId
    ? `/${ROUTES.KNOWLEDGE_BASES}/${details.knowledgeBaseId}`
    : undefined;

  return (
    <div className="run-details-execution__kb-details">
      <Typography Component="p" fontSize="fs12" boldness="semibold">
        {AGENTS_STRINGS.EXECUTION_KB_DETAILS_SECTION_TITLE}
      </Typography>

      <table className="run-details-execution__retrieval-table">
        <tbody>
          <tr>
            <th scope="row">{AGENTS_STRINGS.EXECUTION_KB_LABEL}</th>
            <td>
              {knowledgeBaseHref ? (
                <Link to={knowledgeBaseHref} className="run-details-execution__kb-link">
                  {details.knowledgeBaseId}
                  <IconExternalLink size={14} />
                </Link>
              ) : (
                AGENTS_STRINGS.EXECUTION_KB_UNKNOWN
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">{AGENTS_STRINGS.EXECUTION_KB_TOP_K_LABEL}</th>
            <td>{details.topKLabel ?? AGENTS_STRINGS.EXECUTION_KB_UNKNOWN}</td>
          </tr>
          <tr>
            <th scope="row">{AGENTS_STRINGS.EXECUTION_KB_TOTAL_CONTEXT_LABEL}</th>
            <td>{details.totalContextLabel ?? AGENTS_STRINGS.EXECUTION_KB_UNKNOWN}</td>
          </tr>
        </tbody>
      </table>

      <div className="run-details-execution__section">
        <Typography Component="p" fontSize="fs12" boldness="semibold">
          {AGENTS_STRINGS.EXECUTION_KB_QUERY_LABEL}
        </Typography>
        <Typography Component="p" fontSize="fs13">
          {details.query ?? AGENTS_STRINGS.EXECUTION_KB_UNKNOWN}
        </Typography>
      </div>

      <div className="run-details-execution__section">
        <Typography Component="p" fontSize="fs12" boldness="semibold">
          {AGENTS_STRINGS.EXECUTION_KB_CHUNKS_LABEL}
        </Typography>
        {details.chunks.length === 0 ? (
          <Typography Component="p" fontSize="fs13" color="var(--text-secondary)">
            {AGENTS_STRINGS.EXECUTION_KB_NO_CHUNKS}
          </Typography>
        ) : (
          <ul className="run-details-execution__chunks">
            {details.chunks.map((chunk, chunkIndex) => (
              <li key={`chunk-${chunkIndex}`}>
                <span className="run-details-execution__chunk-title">{chunk.fileLabel}</span>
                <span className="run-details-execution__chunk-score">
                  <span className="run-details-execution__chunk-dot" aria-hidden />
                  {chunk.scoreLabel}
                </span>
                <span className="run-details-execution__chunk-source">{chunk.path}</span>
                <span className="run-details-execution__chunk-tokens">{chunk.tokensLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {details.logs?.length ? <KbLogsPanel logs={details.logs} /> : null}
    </div>
  );
}

function RunDetailsExecutionTab({
  steps,
  isLoading,
  emptyMessage,
}: RunDetailsExecutionTabProps): ReactElement {
  const stepIdSet = useMemo(
    () => new Set(steps.map((step) => step.toolCallId)),
    [steps],
  );
  const [expandedCompletedIds, setExpandedCompletedIds] = useState<Set<string>>(() => new Set());
  const [collapsedRunningIds, setCollapsedRunningIds] = useState<Set<string>>(() => new Set());
  const visibleExpandedCompletedIds = useMemo(
    () => new Set([...expandedCompletedIds].filter((id) => stepIdSet.has(id))),
    [expandedCompletedIds, stepIdSet],
  );
  const visibleCollapsedRunningIds = useMemo(
    () => new Set([...collapsedRunningIds].filter((id) => stepIdSet.has(id))),
    [collapsedRunningIds, stepIdSet],
  );

  const isStepExpanded = useCallback(
    (step: PlaygroundExecutionStep): boolean => {
      if (step.status === "running") {
        return !visibleCollapsedRunningIds.has(step.toolCallId);
      }
      return visibleExpandedCompletedIds.has(step.toolCallId);
    },
    [visibleCollapsedRunningIds, visibleExpandedCompletedIds],
  );

  const toggleStep = useCallback((step: PlaygroundExecutionStep): void => {
    if (step.status === "running") {
      setCollapsedRunningIds((current) => {
        const next = new Set(current);
        if (next.has(step.toolCallId)) {
          next.delete(step.toolCallId);
        } else {
          next.add(step.toolCallId);
        }
        return next;
      });
      return;
    }

    setExpandedCompletedIds((current) => {
      const next = new Set(current);
      if (next.has(step.toolCallId)) {
        next.delete(step.toolCallId);
      } else {
        next.add(step.toolCallId);
      }
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div className="run-details-execution__loading">
        <Spinner size="cell" />
        <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
          {AGENTS_STRINGS.RUN_DETAILS_LOADING}
        </Typography>
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
        {emptyMessage}
      </Typography>
    );
  }

  return (
    <div className="run-details-execution">
      {steps.map((step, index) => {
        const isExpanded = isStepExpanded(step);
        const isKbStep = isKbRetrievalStep(step);
        const resultText = stringifyStepValue(step.result);
        const argsText = stringifyStepValue(step.args);
        const kbRetrievalDetails = isKbStep ? step.kbRetrievalDetails : undefined;

        return (
          <div key={step.toolCallId} className="run-details-execution__step">
            <button
              type="button"
              className="run-details-execution__step-header"
              onClick={() => toggleStep(step)}
              aria-expanded={isExpanded}
            >
              <div className="run-details-execution__step-title">
                <Typography Component="span" fontSize="fs14" boldness="semibold">
                  {AGENTS_STRINGS.EXECUTION_STEP_LABEL} {index + 1}: {getStepTitle(step)}
                </Typography>
                <ExecutionStepStatus step={step} />
              </div>
              {isExpanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
            </button>

            {isExpanded && (
              <div className="run-details-execution__step-body">
                {kbRetrievalDetails ? (
                  <KbRetrievalDetailsSection details={kbRetrievalDetails} />
                ) : (
                  <>
                    <dl className="run-details-execution__meta">
                      <div>
                        <dt>{AGENTS_STRINGS.EXECUTION_STEP_TOOL_CALL_ID_LABEL}</dt>
                        <dd>{step.toolCallId}</dd>
                      </div>
                      <div>
                        <dt>{AGENTS_STRINGS.EXECUTION_STEP_STATUS_LABEL}</dt>
                        <dd>
                          <ExecutionStepStatus step={step} showElapsed={false} />
                        </dd>
                      </div>
                      <div>
                        <dt>{AGENTS_STRINGS.EXECUTION_STEP_ELAPSED_LABEL}</dt>
                        <dd>{formatDuration(step.elapsedMs ?? null)}</dd>
                      </div>
                    </dl>

                    <div className="run-details-execution__section">
                      <Typography Component="p" fontSize="fs12" color="var(--text-secondary)">
                        {AGENTS_STRINGS.EXECUTION_STEP_ARGS_LABEL}
                      </Typography>
                      <pre className="run-details-execution__logs">{argsText}</pre>
                    </div>

                    <div className="run-details-execution__section">
                      <Typography Component="p" fontSize="fs12" color="var(--text-secondary)">
                        {AGENTS_STRINGS.EXECUTION_STEP_RESULT_LABEL}
                      </Typography>
                      <pre className="run-details-execution__logs">{resultText}</pre>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export { RunDetailsExecutionTab };
export type { RunDetailsExecutionTabProps };
