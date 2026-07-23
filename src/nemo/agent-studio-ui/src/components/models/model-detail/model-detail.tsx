import { IconArrowLeft, IconCircleCheck, IconCircleX } from "@tabler/icons-react";
import { useMemo, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router";

import { ROUTES } from "@/routes/routes.consts";
import { Button } from "@/ui-lib/base-components/button/button";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardBlock, CardBlockLabel, CardBlockValue } from "@/ui-lib/base-components/card/card.block";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import type { ModelDetailRow, ModelStatus } from "./model-detail.types";

import "./model-detail.scss";

const numberFormatter = new Intl.NumberFormat("en-US");

function ModelStatusBadge({ status }: { status: ModelStatus }): ReactElement {
  const visual = {
    Active: { Icon: IconCircleCheck, color: "var(--notification-success)" },
    Inactive: { Icon: IconCircleX, color: "var(--text-disabled)" },
    Failed: { Icon: IconCircleX, color: "var(--notification-error)" },
  }[status];

  return (
    <span className="model-detail__status">
      <visual.Icon size={16} stroke={1.75} color={visual.color} aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

function ModelDetail(): ReactElement {
  const { modelId } = useParams<{ modelId: string }>();
  const navigate = useNavigate();

  // TODO(backend): swap for `useGetModelQuery(modelId)` once the detail
  // contract lands. Until then this screen always renders the empty state.
  const model = useMemo<ModelDetailRow | null>(() => null, []);

  if (!model) {
    return (
      <div className="model-detail">
        <Card className="model-detail__panel card">
          <CardContent className="model-detail__panel-content">
            <Typography Component="h1" fontSize="fs20" boldness="semibold">
              Model not found
            </Typography>
            <Typography Component="p" fontSize="fs14" className="model-detail__subtitle">
              {`We couldn't find a model with id "${modelId ?? ""}".`}
            </Typography>
            <div className="model-detail__actions">
              <Button
                variant="outline"
                size="medium"
                label="Back to Models"
                icon={<IconArrowLeft size={16} stroke={1.5} />}
                onClick={() => navigate(`/${ROUTES.MODELS}`)}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="model-detail">
      <div className="model-detail__header">
        <Button
          variant="outline"
          size="small"
          label="Back to Models"
          icon={<IconArrowLeft size={16} stroke={1.5} />}
          onClick={() => navigate(`/${ROUTES.MODELS}`)}
        />
        <div className="model-detail__title-block">
          <Typography Component="h1" fontSize="fs20" boldness="semibold">
            {model.name}
          </Typography>
          <Typography Component="p" fontSize="fs14" className="model-detail__subtitle">
            {model.description}
          </Typography>
        </div>
      </div>

      <Card className="model-detail__panel card">
        <CardContent className="model-detail__panel-content">
          <Typography Component="h2" fontSize="fs16" boldness="semibold">
            Configuration
          </Typography>
          <div className="model-detail__grid">
            <CardBlock>
              <CardBlockLabel>Model ID</CardBlockLabel>
              <CardBlockValue>{model.model_id}</CardBlockValue>
            </CardBlock>
            <CardBlock>
              <CardBlockLabel>Type</CardBlockLabel>
              <CardBlockValue>{model.type}</CardBlockValue>
            </CardBlock>
            <CardBlock>
              <CardBlockLabel>Provider</CardBlockLabel>
              <CardBlockValue>{model.provider_name}</CardBlockValue>
            </CardBlock>
            <CardBlock>
              <CardBlockLabel>Version</CardBlockLabel>
              <CardBlockValue>{model.version}</CardBlockValue>
            </CardBlock>
            <CardBlock>
              <CardBlockLabel>Context window (tokens)</CardBlockLabel>
              <CardBlockValue>{numberFormatter.format(model.context_window)}</CardBlockValue>
            </CardBlock>
            <CardBlock>
              <CardBlockLabel>Status</CardBlockLabel>
              <CardBlockValue>
                <ModelStatusBadge status={model.status} />
              </CardBlockValue>
            </CardBlock>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export { ModelDetail };
// Exported for unit testing each status variant without the (currently
// unreachable) populated-detail render path.
export { ModelStatusBadge };
