import { useMemo, type ReactElement } from "react";
import { IconFileText } from "@tabler/icons-react";

import type { AgentChunk } from "@/api/agent.types";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlockStatus } from "@/ui-lib/base-components/card/card.block";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { getRelevanceLabel } from "./kb-detail-playground.utils";
import "./playground-chunk-details.scss";

// -- Props --

type PlaygroundChunkDetailsProps = {
  chunk: AgentChunk | null;
};

// -- Helpers --

const FALLBACK = "---";

// -- Sub-component: field pair --

type DetailFieldProps = {
  label: string;
  children: React.ReactNode;
};

function DetailField({ label, children }: DetailFieldProps): ReactElement {
  return (
    <div className="playground-details__field">
      <Typography Component="dt" fontSize="fs14" boldness="semibold" className="playground-details__field-label">
        {label}
      </Typography>
      <Typography Component="dd" fontSize="fs14" className="playground-details__field-value">
        {children}
      </Typography>
    </div>
  );
}

// -- Component --

function PlaygroundChunkDetails({ chunk }: PlaygroundChunkDetailsProps): ReactElement {
  const relevance = useMemo(
    () => (chunk ? getRelevanceLabel(chunk.relevance_score) : null),
    [chunk],
  );

  return (
    <Card className="kb-playground__column kb-playground__column--details playground-details">
      <CardHeader
        icon={<IconFileText size={20} />}
        title="Chunk details"
        hasSeparator
      />

      <CardContent className="kb-playground__column-body playground-details__body">
        {!chunk && (
          <div className="playground-details__empty">
            <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
              Select a chunk to view details
            </Typography>
          </div>
        )}

        {chunk && relevance && (
          <dl className="playground-details__fields">
            <DetailField label="Score">
              <CardBlockStatus status={relevance.status}>
                <span>{relevance.label}</span>
              </CardBlockStatus>
              <Typography Component="p" fontSize="fs14" color="var(--text-secondary)" className="playground-details__score-description">
                {relevance.description}
              </Typography>
            </DetailField>

            <DetailField label="Full content">
              {chunk.content}
            </DetailField>

            <DetailField label="Source document">
              {chunk.metadata.fileName || FALLBACK}
            </DetailField>

            <DetailField label="Chunk position">
              {chunk.metadata.chunkIndex != null
                ? String(chunk.metadata.chunkIndex)
                : FALLBACK}
            </DetailField>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export { PlaygroundChunkDetails };
export type { PlaygroundChunkDetailsProps };
