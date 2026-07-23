import { useState, type ReactElement } from "react";
import { IconChevronDown } from "@tabler/icons-react";

import type { AgentCitation } from "../../../api/agents.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import type { PlaygroundChatMessage } from "../../agent-playground.types";
import type { PlaygroundModelLookup } from "../../agent-playground.utils";
import {
  formatCitationSourceLabel,
  formatPlaygroundLatency,
  formatPlaygroundModelLabel,
  formatPlaygroundTotalTokens,
  hasPlaygroundMessageMetadata,
} from "../../agent-playground.utils";

type PlaygroundChatMessageMetadataProps = {
  message: PlaygroundChatMessage;
  modelLookup?: PlaygroundModelLookup[];
};

function formatCitationScore(score: number | undefined): string | null {
  if (score === undefined || !Number.isFinite(score)) {
    return null;
  }
  const percent = score <= 1 ? score * 100 : score;
  return `${Math.round(percent)}%`;
}

function PlaygroundChatCitationItem({
  citation,
}: {
  citation: AgentCitation;
}): ReactElement {
  const label = formatCitationSourceLabel(citation.source);
  const score = formatCitationScore(citation.score);

  return (
    <li className="agent-playground-chat__source-item">
      <Typography Component="span" fontSize="fs13" className="agent-playground-chat__source-name">
        {label}
      </Typography>
      {citation.knowledgeBaseName ? (
        <Typography Component="span" fontSize="fs12" color="var(--text-secondary)">
          {citation.knowledgeBaseName}
        </Typography>
      ) : null}
      {score ? (
        <Typography Component="span" fontSize="fs12" color="var(--text-secondary)">
          {score}
        </Typography>
      ) : null}
    </li>
  );
}

function PlaygroundChatMessageMetadata({
  message,
  modelLookup = [],
}: PlaygroundChatMessageMetadataProps): ReactElement | null {
  const [sourcesExpanded, setSourcesExpanded] = useState(false);

  if (!hasPlaygroundMessageMetadata(message)) {
    return null;
  }

  const citations = message.citations ?? [];
  const latencyLabel = formatPlaygroundLatency(message.latencyMs);
  const totalTokensLabel = formatPlaygroundTotalTokens(message.usage?.totalTokens);
  const modelLabel = formatPlaygroundModelLabel(message.modelName, modelLookup);
  const showLegends =
    latencyLabel.length > 0 || totalTokensLabel.length > 0 || modelLabel.length > 0;

  return (
    <div className="agent-playground-chat__message-metadata">
      {showLegends ? (
        <div className="agent-playground-chat__legends" role="list">
          {latencyLabel ? (
            <span className="agent-playground-chat__legend" role="listitem">
              <span
                className="agent-playground-chat__legend-swatch agent-playground-chat__legend-swatch--latency"
                aria-hidden
              />
              <Typography Component="span" fontSize="fs13">
                Latency: {latencyLabel}
              </Typography>
            </span>
          ) : null}
          {totalTokensLabel ? (
            <span className="agent-playground-chat__legend" role="listitem">
              <span
                className="agent-playground-chat__legend-swatch agent-playground-chat__legend-swatch--tokens"
                aria-hidden
              />
              <Typography Component="span" fontSize="fs13">
                Total tokens: {totalTokensLabel}
              </Typography>
            </span>
          ) : null}
          {modelLabel ? (
            <span className="agent-playground-chat__legend" role="listitem">
              <span
                className="agent-playground-chat__legend-swatch agent-playground-chat__legend-swatch--model"
                aria-hidden
              />
              <Typography Component="span" fontSize="fs13">
                Model: {modelLabel}
              </Typography>
            </span>
          ) : null}
        </div>
      ) : null}

      {citations.length > 0 ? (
        <div className="agent-playground-chat__sources">
          <button
            type="button"
            className="agent-playground-chat__sources-toggle"
            aria-expanded={sourcesExpanded}
            onClick={() => setSourcesExpanded((expanded) => !expanded)}
          >
            <Typography Component="span" fontSize="fs13" boldness="semibold">
              Sources ({citations.length})
            </Typography>
            <IconChevronDown
              size={16}
              className={
                sourcesExpanded
                  ? "agent-playground-chat__sources-chevron agent-playground-chat__sources-chevron--expanded"
                  : "agent-playground-chat__sources-chevron"
              }
              aria-hidden
            />
          </button>
          {sourcesExpanded ? (
            <ul className="agent-playground-chat__sources-list">
              {citations.map((citation, index) => (
                <PlaygroundChatCitationItem
                  key={`${citation.documentId ?? citation.source ?? "source"}-${index}`}
                  citation={citation}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { PlaygroundChatMessageMetadata };
export type { PlaygroundChatMessageMetadataProps };
