import type React from "react"
import {
  IconDatabase,
  IconDots,
  IconChevronDown,
  IconRefresh,
} from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { TabGroup } from "@/ui-lib/base-components/tab/tab-group"
import { Card } from "./card"
import { CardHeader } from "./card.header"
import { CardContent } from "./card.content"
import { CardContentLayout } from "./card.content-layout"
import { CardBlock, CardBlockLabel, CardBlockValue, CardBlockStatus, CardBlockKeyValueList } from "./card.block"
import "./card.datasource.demo.scss"

// ── Info Bar ──────────────────────────────────────────────────────────

function InfoBar(): React.JSX.Element {
  return (
    <Card>
      <CardContentLayout columns={4}>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>production-nfs-share</CardBlockValue>
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
          <CardBlockLabel>Scan status</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric">
          <CardBlockValue>45,892 files</CardBlockValue>
          <CardBlockLabel>Scanned data</CardBlockLabel>
        </CardBlock>
      </CardContentLayout>
    </Card>
  )
}

// ── Overview Card ────────────────────────────────────────────────────

const OVERVIEW_ROWS = [
  { label: "Name", value: "production-nfs-share" },
  { label: "Description", value: "A data source provides a secure link to your storage assets and endpoints for integrated data" },
  { label: "Labels", value: "Staging, NFS" },
  { label: "Type", value: "NFS" },
  { label: "Server name (IP address)", value: "nfs.example.com" },
  { label: "Path", value: "/vol/data" },
  { label: "Username", value: "test" },
  { label: "Password", value: "••••••••••" },
  { label: "Added", value: "Feb 10, 2026, 7:15:06 AM" },
] as const

function OverviewCard(): React.JSX.Element {
  return (
    <div>
      <TabGroup
        tabs={[{ id: "details", label: "Data source details" }]}
        activeTabId="details"
        fitting="fit-content"
        variant="card"
      />
      <Card>
        <CardContent>
          <CardBlockKeyValueList rows={[...OVERVIEW_ROWS]} />
        </CardContent>
      </Card>
    </div>
  )
}

// ── Scanned Data Card ───────────────────────────────────────────────

function ScannedDataCard(): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        icon={<IconRefresh />}
        title="Scan details"
        hasSeparator
        actions={[
          <Button variant="flat" size="small" label="Scan" key="scan" />,
          <Button variant="icon" size="small" icon={<IconDots />} aria-label="More" key="more" />,
          <Button variant="icon" size="small" icon={<IconChevronDown />} aria-label="Expand" key="expand" />,
        ]}
      />
      <CardContentLayout columns={3}>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockStatus status="success">
            <CardBlockValue>Completed</CardBlockValue>
          </CardBlockStatus>
          <CardBlockLabel>Scan status</CardBlockLabel>
        </CardBlock>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>Top 5 folder levels</CardBlockValue>
          <CardBlockLabel>Configuration</CardBlockLabel>
        </CardBlock>
        <CardBlock type="metric">
          <CardBlockValue>Feb 10, 2026, 7:15:06 AM</CardBlockValue>
          <CardBlockLabel>Last completed scan</CardBlockLabel>
        </CardBlock>

        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>45,892</CardBlockValue>
          <CardBlockLabel>Files</CardBlockLabel>
        </CardBlock>
        <CardBlock type="metric" hasSideSeparator>
          <CardBlockValue>1,081</CardBlockValue>
          <CardBlockLabel>Folders</CardBlockLabel>
        </CardBlock>
        <CardBlock type="metric">
          <CardBlockValue>45,892 GB</CardBlockValue>
          <CardBlockLabel>Size</CardBlockLabel>
        </CardBlock>
      </CardContentLayout>
    </Card>
  )
}

// ── Access Config Card ──────────────────────────────────────────────

function AccessConfigCard(): React.JSX.Element {
  return (
    <Card>
      <CardHeader
        icon={<IconDatabase />}
        title="Data source"
        hasSeparator
        actions={[
          <Button variant="flat" size="small" label="Modify" key="modify" />,
        ]}
      />
      <CardContent>
        <CardBlock type="key-value" hasSeparator>
          <CardBlockLabel>Connection status</CardBlockLabel>
          <CardBlockStatus status="success">
            <CardBlockLabel>Healthy</CardBlockLabel>
          </CardBlockStatus>
        </CardBlock>
        <CardBlock type="key-value" hasSeparator>
          <CardBlockLabel>Type</CardBlockLabel>
          <CardBlockLabel>NFS share</CardBlockLabel>
        </CardBlock>
        <CardBlock type="key-value" hasSeparator>
          <CardBlockLabel>Server name</CardBlockLabel>
          <CardBlockLabel>nfs.example.com</CardBlockLabel>
        </CardBlock>
        <CardBlock type="key-value" hasSeparator>
          <CardBlockLabel>Username</CardBlockLabel>
          <CardBlockLabel>test</CardBlockLabel>
        </CardBlock>
        <CardBlock type="key-value">
          <CardBlockLabel>Password</CardBlockLabel>
          <CardBlockLabel>••••••••••</CardBlockLabel>
        </CardBlock>
      </CardContent>
    </Card>
  )
}

// ── Page ─────────────────────────────────────────────────────────────

export default function DatasourceDemo(): React.JSX.Element {
  return (
    <div className="ds-demo">
      <h2 className="ds-demo__title">Datasource Page</h2>

      <h3 className="ds-demo__subtitle">Info Bar</h3>
      <InfoBar />

      <h3 className="ds-demo__subtitle">Overview</h3>
      <OverviewCard />

      <h3 className="ds-demo__subtitle">Scanned Data</h3>
      <ScannedDataCard />

      <h3 className="ds-demo__subtitle">Access Config</h3>
      <AccessConfigCard />
    </div>
  )
}
