import { useState } from "react"
import type React from "react"
import {
  IconFileText,
  IconClock,
  IconCurrencyDollar,
  IconTransform,
  IconDatabase,
  IconListSearch,
  IconSparkles,
} from "@tabler/icons-react"

import { Input } from "@/ui-lib/base-components/input/input"
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button"
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper"
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group"
import { Card } from "./card"
import { CardHeader } from "./card.header"
import { CardContent } from "./card.content"
import { CardContentLayout } from "./card.content-layout"
import { CardFooter } from "./card.footer"
import { CardBlock, CardBlockLabel, CardBlockValue, CardBlockMetric, CardBlockStatus } from "./card.block"
import "./card.kb.demo.scss"

// ── Index & Build Info Bar (Design 1) ────────────────────────────────
// Two metric blocks with icons: index size and build time

function IndexBuildInfoBar(): React.JSX.Element {
  return (
    <Card>
      <CardContentLayout columns={2}>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockMetric
            value="2.4"
            units="GB"
            subtitle="Index size"
            icon={<IconFileText />}
          />
        </CardBlock>

        <CardBlock type="metric">
          <CardBlockMetric
            value="25-35"
            units="minutes"
            subtitle="Build time"
            icon={<IconClock />}
          />
        </CardBlock>
      </CardContentLayout>
    </Card>
  )
}

// ── KB Top Info Bar (Design 2) ───────────────────────────────────────
// Six status/metric blocks in a horizontal row

function KbTopInfoBar(): React.JSX.Element {
  return (
    <Card>
      <CardContentLayout columns={6}>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>kb-product-documentation</CardBlockValue>
          <CardBlockLabel>Name</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockStatus status="success">
            <CardBlockValue>Healthy</CardBlockValue>
          </CardBlockStatus>
          <CardBlockLabel>Status</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockStatus status="success">
            <CardBlockValue>Completed</CardBlockValue>
          </CardBlockStatus>
          <CardBlockLabel>Synchronization status</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>Version 5</CardBlockValue>
          <CardBlockLabel>Version</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>Feb 10, 2026, 7:15:06 AM</CardBlockValue>
          <CardBlockLabel>Last completed synchronization</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric">
          <CardBlockValue>HR-Documents-Dataset</CardBlockValue>
          <CardBlockLabel>Assigned dataset</CardBlockLabel>
        </CardBlock>
      </CardContentLayout>
    </Card>
  )
}

// ── Chunk Details Card (Design 3) ────────────────────────────────────
// Card with header and key-value rows for file metadata

function ChunkDetailsCard(): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        icon={<IconSparkles />}
        title="Chunk details"
        hasSeparator
      />
      <CardContent>
        <CardBlock type="metric" >
          <CardBlockValue>File size</CardBlockValue>
          <CardBlockLabel>2 GiB</CardBlockLabel>
        </CardBlock>
        <CardBlock type="metric" >
          <CardBlockValue>File format</CardBlockValue>
          <CardBlockLabel>DOC</CardBlockLabel>
        </CardBlock>
        <CardBlock type="metric" >
          <CardBlockValue>File path</CardBlockValue>
          <CardBlockLabel>/srv-emr01/patient_records/diabetes/</CardBlockLabel>
        </CardBlock>
        <CardBlock type="metric" >
          <CardBlockValue>Last updated</CardBlockValue>
          <CardBlockLabel>Feb 2, 2019 07:28 PM</CardBlockLabel>
        </CardBlock>
        <CardBlock type="metric">
          <CardBlockValue>Date the file was created</CardBlockValue>
          <CardBlockLabel>Feb 2, 2019 07:28 PM</CardBlockLabel>
        </CardBlock>
      </CardContent>
    </Card>
  )
}

// ── Cost Dashboard (Design 4) ────────────────────────────────────────
// Four cost metric blocks with icons in a horizontal row

function CostDashboard(): React.JSX.Element {
  return (
    <Card>
      <CardContentLayout columns={4}>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockMetric
            value="$124.35"
            subtitle="Total (last 30 days)"
            icon={<IconCurrencyDollar />}
            orientation="vertical"
            valueSize="fs20"
          />
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockMetric
            value="$62.50"
            subtitle="Embedding cost"
            icon={<IconTransform />}
            orientation="vertical"
            valueSize="fs20"
          />
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockMetric
            value="$37.50"
            subtitle="Storage cost"
            icon={<IconDatabase />}
            orientation="vertical"
            valueSize="fs20"
          />
        </CardBlock>

        <CardBlock type="metric">
          <CardBlockMetric
            value="$24.80"
            subtitle="Indexing cost"
            icon={<IconListSearch />}
            orientation="vertical"
            valueSize="fs20"
          />
        </CardBlock>
      </CardContentLayout>
    </Card>
  )
}

// ── Modify Synchronization Schedule (Design 5) ──────────────────────
// Dialog-like card with radio options, tab group, cron input, and footer

const SYNC_OPTIONS = [
  {
    id: "manual",
    label: "Synchronize manually",
    description: "Updates must be applied manually.",
  },
  {
    id: "after-dataset",
    label: "Synchronize after dataset updates",
    description: "Starts automatically after each dataset synchronization completes.",
  },
  {
    id: "kb-schedule",
    label: "Sync on Knowledge Base schedule",
    description: "Updates based on the Knowledge Base schedule, independent of dataset updates.",
  },
] as const

function ModifySyncSchedule(): React.JSX.Element {
  const [selectedOption, setSelectedOption] = useState<string>("kb-schedule")
  const [activeTab, setActiveTab] = useState("cron")

  return (
    <Card>
      <CardHeader title="Modify synchronization schedule" hasSeparator />
      <CardContent>
        <CardBlock type="description">
          <CardBlockLabel>
            Select how the Knowledge Base stays up to date.
          </CardBlockLabel>
        </CardBlock>

        <RadioGroup value={selectedOption} onValueChange={(v) => setSelectedOption(v as string)}>
          {SYNC_OPTIONS.map((option) => (
            <CardBlock key={option.id} type="description">
              <SelectorWrapper
                selectorType="radioButton"
                selectorProps={{ value: option.id }}
                label={option.label}
                description={option.description}
              />
            </CardBlock>
          ))}
        </RadioGroup>

        {selectedOption === "kb-schedule" && (
          <CardBlock type="description">
            <TabGroup
              tabs={[
                { id: "builder", label: "Use schedule builder" },
                { id: "cron", label: "Use cron expression" },
              ]}
              activeTabId={activeTab}
              onTabChange={setActiveTab}
              fitting="fit-content"
            >
              <TabContent tabId="builder">
                <CardBlockLabel>Schedule builder content goes here.</CardBlockLabel>
              </TabContent>
              <TabContent tabId="cron">
                <Input
                  label="Cron expression"
                  tooltip="A cron expression defines the schedule frequency"
                  defaultValue="0 * * * *"
                />
              </TabContent>
            </TabGroup>
          </CardBlock>
        )}
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

export default function KbDemo(): React.JSX.Element {
  return (
    <div className="kb-demo">
      <h2 className="kb-demo__title">Knowledge Base Page</h2>

      <h3 className="kb-demo__subtitle">Index & Build Info Bar</h3>
      <IndexBuildInfoBar />

      <h3 className="kb-demo__subtitle">KB Top Info Bar</h3>
      <KbTopInfoBar />

      <h3 className="kb-demo__subtitle">Chunk Details</h3>
      <ChunkDetailsCard />

      <h3 className="kb-demo__subtitle">Cost Dashboard</h3>
      <CostDashboard />

      <h3 className="kb-demo__subtitle">Modify Synchronization Schedule</h3>
      <ModifySyncSchedule />
    </div>
  )
}
