import type React from "react"
import {
  IconCalendar,
  IconDots,
  IconChevronDown,
  IconAlertTriangle,
} from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper"
import { Card } from "./card"
import { CardHeader } from "./card.header"
import { CardContent } from "./card.content"
import { CardContentLayout } from "./card.content-layout"
import { CardFooter } from "./card.footer"
import { CardBlock, CardBlockLabel, CardBlockValue, CardBlockStatus } from "./card.block"
import "./card.dataset.demo.scss"

const SCHEDULE_UNIT_ITEMS = [
  { key: "hours", value: "hours", label: "hours" },
  { key: "days", value: "days", label: "days" },
  { key: "weeks", value: "weeks", label: "weeks" },
] as const

// ── Sync Schedule Info Bar ───────────────────────────────────────────
// Card with header + 4 metric blocks in a horizontal row

function SyncScheduleInfoBar(): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        icon={<IconCalendar />}
        title="Synchronization schedule"
        hasSeparator
        actions={[
          <Button variant="flat" size="small" label="Scan" key="scan" />,
          <Button variant="icon" size="small" icon={<IconDots />} aria-label="Actions" key="actions" />,
          <Button variant="icon" size="small" icon={<IconChevronDown />} aria-label="Expand" key="expand" />,
        ]}
      />
      <CardContentLayout columns={4}>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockStatus status="success">
            <CardBlockValue>Completed</CardBlockValue>
          </CardBlockStatus>
          <CardBlockLabel>Status</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>Every 2 hours</CardBlockValue>
          <CardBlockLabel>Schedule</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>Feb 10, 2026, 7:15:06 AM</CardBlockValue>
          <CardBlockLabel>Last completed synchronization</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric">
          <CardBlockValue>Feb 10, 2026, 9:15:06 AM</CardBlockValue>
          <CardBlockLabel>Next scheduled synchronization</CardBlockLabel>
        </CardBlock>
      </CardContentLayout>
    </Card>
  )
}

// ── Modify Schedule (Enabled) ────────────────────────────────────────
// Dialog-like card: title, description, checkbox, input field, Save/Cancel

function ModifyScheduleEnabled(): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Modify synchronization schedule" hasSeparator />
      <CardContent>
        <CardBlock type="description">
          <CardBlockLabel>
            A synchronization schedule provides a fixed schedule to keep your dataset up to date with its data source.
          </CardBlockLabel>
        </CardBlock>
        <CardBlock type="status">
          <SelectorWrapper
            selectorType="checkbox"
            selectorProps={{ checked: true }}
            label="Enable dataset synchronization schedule"
          />
        </CardBlock>
        <CardBlock type="description">
          <SelectDropdown
            label="Synchronize every"
            items={[...SCHEDULE_UNIT_ITEMS]}
            defaultValue="hours"
            placeholder="2"
          />
        </CardBlock>
      </CardContent>
      <CardFooter
        hasSeparator
        alignment="end"
        actions={[
          { variant: "solid", size: "small", label: "Save" },
          { variant: "outline", size: "small", label: "Cancel" },
        ]}
      />
    </Card>
  )
}

// ── Modify Schedule (Disabled) ───────────────────────────────────────
// Same dialog but with unchecked checkbox and a warning message

function ModifyScheduleDisabled(): React.JSX.Element {
  return (
    <Card>
      <CardHeader title="Modify synchronization schedule" hasSeparator />
      <CardContent>
        <CardBlock type="description">
          <CardBlockLabel>
            A synchronization schedule provides a fixed schedule to keep your dataset up to date with its data source.
          </CardBlockLabel>
        </CardBlock>
        <CardBlock type="status">
          <SelectorWrapper
            selectorType="checkbox"
            selectorProps={{ checked: false }}
            label="Enable dataset synchronization schedule"
          />
        </CardBlock>
        <CardBlock type="status">
          <IconAlertTriangle size={16} style={{ color: "var(--notification-warning)", flexShrink: 0 }} />
          <CardBlockLabel>
            Disabling synchronization schedule will stop keeping your dataset up to date with its data source.
          </CardBlockLabel>
        </CardBlock>
      </CardContent>
      <CardFooter
        hasSeparator
        alignment="end"
        actions={[
          { variant: "solid", size: "small", label: "Save" },
          { variant: "outline", size: "small", label: "Cancel" },
        ]}
      />
    </Card>
  )
}

// ── Page ─────────────────────────────────────────────────────────────

export default function DatasetDemo(): React.JSX.Element {
  return (
    <div className="dataset-demo">
      <h2 className="dataset-demo__title">Dataset Page</h2>

      <h3 className="dataset-demo__subtitle">Synchronization Schedule Info Bar</h3>
      <SyncScheduleInfoBar />

      <h3 className="dataset-demo__subtitle">Modify Schedule (Enabled)</h3>
      <ModifyScheduleEnabled />

      <h3 className="dataset-demo__subtitle">Modify Schedule (Disabled)</h3>
      <ModifyScheduleDisabled />
    </div>
  )
}
