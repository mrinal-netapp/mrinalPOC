import { useCallback, useMemo, type KeyboardEvent, type ReactElement } from "react";
import { IconLayoutGrid } from "@tabler/icons-react";

import type { AgentChunk } from "@/api/agent.types";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlockStatus } from "@/ui-lib/base-components/card/card.block";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { getRelevanceLabel } from "./kb-detail-playground.utils";
import "./playground-results-column.scss";

// -- Props --

type PlaygroundResultsColumnProps = {
  chunks: AgentChunk[];
  selectedChunkId: string | null;
  onSelectChunk: (chunkId: string) => void;
};

// -- Sub-component: DataChunkCard --

type DataChunkCardProps = {
  chunk: AgentChunk;
  isSelected: boolean;
  onSelect: () => void;
};

function DataChunkCard({ chunk, isSelected, onSelect }: DataChunkCardProps): ReactElement {
  const relevance = getRelevanceLabel(chunk.relevance_score);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect();
      }
    },
    [onSelect],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      className={`playground-results__chunk-card ${isSelected ? "playground-results__chunk-card--selected" : ""}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      aria-pressed={isSelected}
    >
      <div className="playground-results__chunk-header">
        <div className="playground-results__chunk-title">
          <Typography Component="span" fontSize="fs16" boldness="semibold" isEllipsis>
            {chunk.metadata.fileName}
          </Typography>
          {chunk.metadata.datasetName && (
            <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
              {chunk.metadata.datasetName}
            </Typography>
          )}
        </div>
        <CardBlockStatus status={relevance.status}>
          <Typography Component="span" fontSize="fs14">
            {relevance.label}
          </Typography>
        </CardBlockStatus>
      </div>

      <div className="playground-results__chunk-body">
        <Typography Component="p" fontSize="fs14" className="playground-results__chunk-content">
          {chunk.content}
        </Typography>
      </div>
    </div>
  );
}

// -- Component --

function PlaygroundResultsColumn({
  chunks,
  selectedChunkId,
  onSelectChunk,
}: PlaygroundResultsColumnProps): ReactElement {
  const sortedChunks = useMemo(
    () => [...chunks].sort((a, b) => b.relevance_score - a.relevance_score),
    [chunks],
  );

  return (
    <Card className="kb-playground__column kb-playground__column--results playground-results">
      <CardHeader
        icon={<IconLayoutGrid size={20} />}
        title="Retrieved results"
        hasSeparator
      />

      <CardContent className="kb-playground__column-body playground-results__body">
        {sortedChunks.length === 0 && (
          <div className="playground-results__empty">
            <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
              Send a query to see retrieved results
            </Typography>
          </div>
        )}

        {sortedChunks.map((chunk) => (
          <DataChunkCard
            key={chunk.chunkId}
            chunk={chunk}
            isSelected={selectedChunkId === chunk.chunkId}
            onSelect={() => onSelectChunk(chunk.chunkId)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

export { PlaygroundResultsColumn };
export type { PlaygroundResultsColumnProps };
