import { IconCircleCheckFilled } from "@tabler/icons-react";

import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import type { PlaygroundAgentActivity } from "@/routes/pages/agents/playground/agent-playground.types";

import "./agent-activity-strip.scss";

type AgentActivityStripProps = {
  activity: PlaygroundAgentActivity[];
};

/**
 * Live per-agent progress for a multi-agent (team) run, rendered as a growing
 * list: one row per participant turn (in execution order) built from the
 * `agent_started` / `agent_completed` SSE events. A running agent shows a
 * spinner ("running…"); a finished agent shows a check + its turn duration. As
 * each agent starts, a new row is appended — so the user sees "Hello running",
 * then "Time running", then "random-num running → complete" rather than a
 * single opaque spinner. Renders nothing for single-agent runs (no activity).
 */
function AgentActivityStrip({ activity }: AgentActivityStripProps) {
  if (activity.length === 0) {
    return null;
  }

  return (
    <ul className="agent-activity-strip" aria-label="Team agent activity">
      {activity.map((turn, index) => (
        <li
          key={`${turn.agentName}-${index}`}
          className={`agent-activity-strip__row agent-activity-strip__row--${turn.status}`}
        >
          <span className="agent-activity-strip__icon" aria-hidden="true">
            {turn.status === "running" ? (
              <Spinner size="cell" />
            ) : (
              <IconCircleCheckFilled size={16} className="agent-activity-strip__check" />
            )}
          </span>
          <Typography Component="span" fontSize="fs13" boldness="semibold">
            {turn.agentName}
          </Typography>
          <Typography Component="span" fontSize="fs12" color="var(--text-secondary)">
            {turn.status === "running" ? "running…" : formatDuration(turn.durationMs)}
          </Typography>
        </li>
      ))}
    </ul>
  );
}

/** Compact "312ms" / "1.4s" duration label; "done" when unknown. */
function formatDuration(durationMs: number | undefined): string {
  if (typeof durationMs !== "number" || durationMs < 0) {
    return "done";
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export { AgentActivityStrip };
