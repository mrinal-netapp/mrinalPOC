import type { ReactElement } from "react";
import { IconDotsVertical } from "@tabler/icons-react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { Button } from "@/ui-lib/base-components/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui-lib/base-components/baseTableMcpBxp/table/table";
import type { EvalRunStatus } from "@/routes/pages/evaluations/api/eval.types";
import { EvalStatusCell } from "../columns/cells/eval-status-cell";

import "./eval-runs-nested-table.scss";

const CURRENT_BASELINE_LABEL = "Current baseline";

type EvalRunRow = {
  runId: string;
  name: string;
  status: EvalRunStatus;
  agentName: string;
  strategy: string;
  dimensions: string[];
  lastRun: string;
  triggeredBy: string;
  baselineStatus?: string;
};

type EvalRunsNestedTableProps = {
  runs: EvalRunRow[];
  onSetBaseline?: (run: EvalRunRow) => void;
  onRun?: (run: EvalRunRow) => void;
};

function EvalRunsNestedTable({ runs, onSetBaseline, onRun }: EvalRunsNestedTableProps): ReactElement {
  if (runs.length === 0) {
    return (
      <Typography Component="div" fontSize="fs14" boldness="regular" color="var(--text-disabled)">
        No evaluation runs yet.
      </Typography>
    );
  }

  return (
    <div className="eval-nested-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead style={{ width: 200 }}>Run name</TableHead>
            <TableHead style={{ width: 120 }}>Status</TableHead>
            <TableHead style={{ width: 180 }}>Associated agent</TableHead>
            <TableHead style={{ width: 200 }}>Strategy</TableHead>
            <TableHead style={{ width: 280 }}>Dimensions</TableHead>
            <TableHead style={{ width: 180 }}>Last run</TableHead>
            <TableHead style={{ width: 120 }}>Initiated by</TableHead>
            <TableHead style={{ width: 56 }} aria-label="Actions" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.runId}>
              <TableCell>
                <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                  {run.name}
                </Typography>
              </TableCell>
              <TableCell>
                <EvalStatusCell status={run.status} />
              </TableCell>
              <TableCell>
                <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                  {run.agentName}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography Component="span" fontSize="fs14" boldness="regular">
                  {run.strategy}
                </Typography>
              </TableCell>
              <TableCell>
                <ChipList
                  values={run.dimensions}
                  getLabel={(v) => String(v)}
                  isRemovable={false}
                  isDisabled={false}
                />
              </TableCell>
              <TableCell>
                <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                  {run.lastRun}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                  {run.triggeredBy}
                </Typography>
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="icon"
                        size="small"
                        icon={<IconDotsVertical size={16} />}
                        aria-label={`Actions for ${run.name}`}
                      />
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onRun?.(run)}>Run</DropdownMenuItem>
                    {run.baselineStatus !== CURRENT_BASELINE_LABEL && (
                      <DropdownMenuItem onClick={() => onSetBaseline?.(run)}>
                        Set as baseline
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export { EvalRunsNestedTable };
export type { EvalRunRow };
