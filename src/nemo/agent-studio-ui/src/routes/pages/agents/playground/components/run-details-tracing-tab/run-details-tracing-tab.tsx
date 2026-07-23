import { useCallback, useMemo, useState, type ReactElement } from "react";
import { IconChevronDown, IconChevronRight, IconCopy } from "@tabler/icons-react";

import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { AGENTS_STRINGS } from "../../../agents.consts";
import type { PlaygroundTracingStep } from "../../agent-playground-tracing.utils";
import "./run-details-tracing-tab.scss";

const VALUE_PREVIEW_MAX_LINES = 6;

type RunDetailsTracingTabProps = {
  steps: PlaygroundTracingStep[];
  isLoading: boolean;
  emptyMessage: string;
};

function formatDuration(value: number | null): string {
  return value !== null ? `${value} ms` : "—";
}

function TraceValuePanel({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string | null;
  copyLabel: string;
}): ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const displayValue = value ?? AGENTS_STRINGS.TRACING_INPUT_OUTPUT_EMPTY;
  const lines = displayValue.split("\n");
  const isTruncated = value !== null && lines.length > VALUE_PREVIEW_MAX_LINES;
  const visibleText = isExpanded || !isTruncated
    ? displayValue
    : `${lines.slice(0, VALUE_PREVIEW_MAX_LINES).join("\n")}\n…`;

  const handleCopy = (): void => {
    if (!value) {
      return;
    }
    void navigator.clipboard.writeText(value);
  };

  return (
    <div className="run-details-tracing__section">
      <Typography Component="p" fontSize="fs12" boldness="semibold">
        {label}
      </Typography>
      <div className="run-details-tracing__value-panel">
        {value ? (
          <button
            type="button"
            className="run-details-tracing__value-copy"
            onClick={handleCopy}
            aria-label={copyLabel}
          >
            <IconCopy size={16} />
          </button>
        ) : null}
        <pre className="run-details-tracing__value">{visibleText}</pre>
        {isTruncated ? (
          <button
            type="button"
            className="run-details-tracing__show-more"
            onClick={() => setIsExpanded((expanded) => !expanded)}
          >
            {isExpanded ? AGENTS_STRINGS.TRACING_SHOW_LESS : AGENTS_STRINGS.TRACING_SHOW_MORE}
            <IconChevronDown
              size={14}
              className={isExpanded ? "run-details-tracing__show-more-icon--expanded" : undefined}
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RunDetailsTracingTab({
  steps,
  isLoading,
  emptyMessage,
}: RunDetailsTracingTabProps): ReactElement {
  const stepIdSet = useMemo(() => new Set(steps.map((step) => step.id)), [steps]);
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(() => new Set());
  const visibleExpandedStepIds = useMemo(
    () => new Set([...expandedStepIds].filter((id) => stepIdSet.has(id))),
    [expandedStepIds, stepIdSet],
  );

  const toggleStep = useCallback((stepId: string): void => {
    setExpandedStepIds((current) => {
      const next = new Set(current);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div className="run-details-tracing__loading">
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
    <div className="run-details-tracing">
      {steps.map((step, index) => {
        const isExpanded = visibleExpandedStepIds.has(step.id);

        return (
          <div key={step.id} className="run-details-tracing__step">
            <button
              type="button"
              className="run-details-tracing__step-header"
              onClick={() => toggleStep(step.id)}
              aria-expanded={isExpanded}
            >
              <div className="run-details-tracing__step-title">
                <Typography Component="span" fontSize="fs14" boldness="semibold">
                  {AGENTS_STRINGS.EXECUTION_STEP_LABEL} {index + 1}: {step.name}
                </Typography>
                <Typography Component="span" fontSize="fs12" color="var(--text-secondary)">
                  {AGENTS_STRINGS.EXECUTION_STATUS_COMPLETED}
                  {" · "}
                  {formatDuration(step.durationMs)}
                </Typography>
              </div>
              {isExpanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
            </button>

            {isExpanded ? (
              <div className="run-details-tracing__step-body">
                <dl className="run-details-tracing__meta">
                  <div>
                    <dt>{AGENTS_STRINGS.TRACING_SPAN_KIND_LABEL}</dt>
                    <dd>{step.spanKind}</dd>
                  </div>
                  <div>
                    <dt>{AGENTS_STRINGS.EXECUTION_STEP_ELAPSED_LABEL}</dt>
                    <dd>{formatDuration(step.durationMs)}</dd>
                  </div>
                </dl>

                <TraceValuePanel
                  label={AGENTS_STRINGS.TRACING_INPUT_LABEL}
                  value={step.input}
                  copyLabel={AGENTS_STRINGS.TRACING_COPY_INPUT}
                />
                <TraceValuePanel
                  label={AGENTS_STRINGS.TRACING_OUTPUT_LABEL}
                  value={step.output}
                  copyLabel={AGENTS_STRINGS.TRACING_COPY_OUTPUT}
                />

                <button
                  type="button"
                  className="run-details-tracing__collapse-step"
                  onClick={() => toggleStep(step.id)}
                >
                  {AGENTS_STRINGS.TRACING_SHOW_LESS}
                  <IconChevronDown
                    size={14}
                    className="run-details-tracing__show-more-icon--expanded"
                  />
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export { RunDetailsTracingTab };
export type { RunDetailsTracingTabProps };
