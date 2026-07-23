import { useState } from "react"
import type React from "react"
import {
  IconDatabase,
  IconRefresh,
  IconChevronRight,
  IconDots,
  IconChevronDown,
  IconCloud,
  IconServer,
  IconBrandAws,
  IconClock,
  IconShieldCheck,
} from "@tabler/icons-react"
import { toast } from "@/ui-lib/base-components/toast/toast"

import { Button } from "@/ui-lib/base-components/button/button"
import { Card } from "./card"
import { CardHeader } from "./card.header"
import { CardContent } from "./card.content"
import { CardFooter } from "./card.footer"
import {
  CardBlock,
  CardBlockLabel,
  CardBlockValue,
  CardBlockMetric,
  CardBlockStatus,
} from "./card.block"
import "./card.demo.scss"

export default function CardDemo(): React.JSX.Element {
  const [clickCount, setClickCount] = useState(0)

  return (
    <div className="card-demo">
      <h2 className="card-demo__title">Card Component</h2>

      {/* ---- Header Variations ---- */}
      <h3 className="card-demo__subtitle">Header Variations</h3>
      <div className="card-demo__grid">
        <Card>
          <CardHeader title="Title Only" />
        </Card>

        <Card>
          <CardHeader title="Title" subtitle="With subtitle" />
        </Card>

        <Card>
          <CardHeader title="Vertical" subtitle="Orientation" orientation="vertical" />
        </Card>

        <Card>
          <CardHeader icon={<IconDatabase />} title="With Icon" subtitle="Icon + subtitle" />
        </Card>

        <Card>
          <CardHeader
            icon={<IconBrandAws />}
            title="Logo + Action"
            actions={[
              <Button variant="icon" size="small" icon={<IconDots />} aria-label="More" key="more" />,
            ]}
          />
        </Card>

        <Card>
          <CardHeader
            icon={<IconCloud />}
            title="Two Actions"
            subtitle="Icon + subtitle"
            actions={[
              <Button variant="icon" size="small" icon={<IconDots />} aria-label="More" key="more" />,
              <Button variant="icon" size="small" icon={<IconChevronDown />} aria-label="Expand" key="expand" />,
            ]}
          />
        </Card>
      </div>

      {/* ---- Footer Variations ---- */}
      <h3 className="card-demo__subtitle">Footer — Default Variant</h3>
      <div className="card-demo__grid">
        <Card>
          <CardHeader title="1 Action (end)" />
          <CardFooter
            alignment="end"
            actions={[{ variant: "solid", size: "medium", label: "Save" }]}
          />
        </Card>

        <Card>
          <CardHeader title="2 Actions (end)" />
          <CardFooter
            alignment="end"
            actions={[
              { variant: "outline", size: "medium", label: "Draft" },
              { variant: "solid", size: "medium", label: "Publish" },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Cancel + 2 Actions" />
          <CardFooter
            alignment="end"
            cancelButton={{ variant: "flat", size: "medium", label: "Cancel" }}
            actions={[
              { variant: "outline", size: "medium", label: "Draft" },
              { variant: "solid", size: "medium", label: "Apply" },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Default + Separator" />
          <CardContent>
            <CardBlock type="key-value">
              <CardBlockLabel>Status</CardBlockLabel>
              <CardBlockValue>Active</CardBlockValue>
            </CardBlock>
          </CardContent>
          <CardFooter
            hasSeparator
            alignment="end"
            actions={[{ variant: "solid", size: "medium", label: "Save" }]}
          />
        </Card>

        <Card>
          <CardHeader title="Aligned Center" />
          <CardFooter
            alignment="center"
            actions={[{ variant: "solid", size: "medium", label: "Confirm" }]}
          />
        </Card>

        <Card>
          <CardHeader title="Aligned Start" />
          <CardFooter
            alignment="start"
            actions={[{ variant: "solid", size: "medium", label: "Submit" }]}
          />
        </Card>
      </div>

      <h3 className="card-demo__subtitle">Footer — Fill Variant</h3>
      <div className="card-demo__grid">
        <Card>
          <CardHeader title="Fill — 2 Actions" />
          <CardFooter
            variant="fill"
            actions={[
              { label: "Edit" },
              { label: "Delete" },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Fill — 1 Action" />
          <CardFooter
            variant="fill"
            actions={[{ label: "View Details" }]}
          />
        </Card>

        <Card>
          <CardHeader icon={<IconDatabase />} title="Fill + Separator" subtitle="With content above" />
          <CardContent>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Region</CardBlockLabel>
              <CardBlockValue>US-East-1</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value">
              <CardBlockLabel>Provider</CardBlockLabel>
              <CardBlockValue>AWS</CardBlockValue>
            </CardBlock>
          </CardContent>
          <CardFooter
            variant="fill"
            hasSeparator
            actions={[
              { label: "Configure" },
              { label: "View Details" },
            ]}
          />
        </Card>
      </div>

      <h3 className="card-demo__subtitle">Footer — Direct Children</h3>
      <div className="card-demo__grid">
        <Card>
          <CardHeader title="Timestamp Footer" />
          <CardContent>
            <CardBlock type="status">
              <CardBlockStatus status="success">All systems operational</CardBlockStatus>
            </CardBlock>
          </CardContent>
          <CardFooter hasSeparator>
            <IconClock size={14} style={{ color: "var(--text-secondary)" }} />
            <span style={{ fontSize: 12, color: "var(--text-secondary)", marginInlineStart: 6 }}>
              Last updated: 5 min ago
            </span>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader title="Badge Footer" />
          <CardContent>
            <CardBlock type="key-value">
              <CardBlockLabel>Encryption</CardBlockLabel>
              <CardBlockValue>AES-256</CardBlockValue>
            </CardBlock>
          </CardContent>
          <CardFooter hasSeparator>
            <IconShieldCheck size={16} style={{ color: "var(--status-success)" }} />
            <span style={{ fontSize: 12, color: "var(--status-success)", marginInlineStart: 6, fontWeight: 600 }}>
              Verified
            </span>
            <span style={{ marginInlineStart: "auto", fontSize: 12, color: "var(--text-secondary)" }}>
              Cert expires Dec 2026
            </span>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader title="Mixed Layout" />
          <CardContent>
            <CardBlock type="metric">
              <CardBlockMetric value="99.9" units="%" subtitle="Uptime (30d)" />
            </CardBlock>
          </CardContent>
          <CardFooter hasSeparator>
            <Button variant="flat" size="small" label="View History" />
            <span style={{ marginInlineStart: "auto", fontSize: 12, color: "var(--text-secondary)" }}>
              3 incidents this month
            </span>
          </CardFooter>
        </Card>
      </div>

      {/* ---- Block Types ---- */}
      <h3 className="card-demo__subtitle">Block Types</h3>
      <div className="card-demo__grid">
        <Card>
          <CardHeader title="Key-Value" />
          <CardContent>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Region</CardBlockLabel>
              <CardBlockValue>US-East-1</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Provider</CardBlockLabel>
              <CardBlockValue>AWS</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value">
              <CardBlockLabel>Status</CardBlockLabel>
              <CardBlockValue>Active</CardBlockValue>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Metric — Value + Units" />
          <CardContent>
            <CardBlock type="metric">
              <CardBlockMetric value="1,234" units="TB" subtitle="Total Storage" />
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Metric — With Icon" />
          <CardContent>
            <CardBlock type="metric">
              <CardBlockMetric
                value="3"
                units="nodes"
                subtitle="Running instances"
                icon={<IconServer size={32} />}
              />
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Metric — Vertical" />
          <CardContent>
            <CardBlock type="metric">
              <CardBlockMetric
                value="99.9"
                units="%"
                subtitle="Uptime (30d)"
                icon={<IconCloud size={32} />}
                orientation="vertical"
              />
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Metric — Custom Sizes" />
          <CardContent>
            <CardBlock type="metric">
              <CardBlockMetric
                value="256"
                units="GB"
                valueSize="fs24"
                valueType="semibold"
                unitSize="fs14"
                subtitle="Memory allocated"
              />
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Description" />
          <CardContent>
            <CardBlock type="description">
              <CardBlockLabel>
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed semper nibh ut aliquam
                ultrices. Vivamus sodales tincidunt volutpat.
              </CardBlockLabel>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Status" />
          <CardContent>
            <CardBlock type="status" hasSeparator>
              <CardBlockStatus status="success">Cluster healthy</CardBlockStatus>
            </CardBlock>
            <CardBlock type="status" hasSeparator>
              <CardBlockStatus status="error">Node unreachable</CardBlockStatus>
            </CardBlock>
            <CardBlock type="status">
              <CardBlockStatus status="warning">High memory usage</CardBlockStatus>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="List" />
          <CardContent>
            <CardBlock type="list">
              <CardBlockLabel>Node 1 — us-east-1a</CardBlockLabel>
              <CardBlockLabel>Node 2 — us-east-1b</CardBlockLabel>
              <CardBlockLabel>Node 3 — us-west-2a</CardBlockLabel>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Info Row" />
          <CardContent>
            <CardBlock type="info-row" hasSeparator>
              <IconServer size={20} />
              <CardBlockLabel>3 nodes running</CardBlockLabel>
            </CardBlock>
            <CardBlock type="info-row">
              <IconCloud size={20} />
              <CardBlockLabel>Cloud provider: AWS</CardBlockLabel>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Link Row" />
          <CardContent>
            <CardBlock type="link-row" onClick={() => toast.info("View cluster details")} hasSeparator>
              <CardBlockLabel>View cluster details</CardBlockLabel>
              <IconChevronRight size={16} />
            </CardBlock>
            <CardBlock type="link-row" onClick={() => toast.info("Manage backups")}>
              <CardBlockLabel>Manage backups</CardBlockLabel>
              <IconChevronRight size={16} />
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Progress" />
          <CardContent>
            <CardBlock type="progress">
              <CardBlockLabel>Storage used</CardBlockLabel>
              <CardBlockValue>150 / 200 GB</CardBlockValue>
            </CardBlock>
          </CardContent>
        </Card>
      </div>

      {/* ---- Separators ---- */}
      <h3 className="card-demo__subtitle">Separators</h3>
      <div className="card-demo__grid">
        <Card>
          <CardHeader title="Bottom Separators" />
          <CardContent>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Name</CardBlockLabel>
              <CardBlockValue>Production Cluster</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Version</CardBlockLabel>
              <CardBlockValue>7.10.2</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value">
              <CardBlockLabel>Region</CardBlockLabel>
              <CardBlockValue>US-East-1</CardBlockValue>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Side Separators" />
          <CardContent>
            <CardBlock type="key-value" hasSideSeparator>
              <CardBlockLabel>Nodes</CardBlockLabel>
              <CardBlockValue>3</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value" hasSideSeparator>
              <CardBlockLabel>Region</CardBlockLabel>
              <CardBlockValue>US-East-1</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value">
              <CardBlockLabel>Provider</CardBlockLabel>
              <CardBlockValue>AWS</CardBlockValue>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Both Separators" />
          <CardContent>
            <CardBlock type="key-value" hasSeparator hasSideSeparator>
              <CardBlockLabel>Nodes</CardBlockLabel>
              <CardBlockValue>3</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value" hasSeparator hasSideSeparator>
              <CardBlockLabel>Version</CardBlockLabel>
              <CardBlockValue>7.10.2</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value">
              <CardBlockLabel>Region</CardBlockLabel>
              <CardBlockValue>US-East-1</CardBlockValue>
            </CardBlock>
          </CardContent>
        </Card>
      </div>

      {/* ---- Interactive ---- */}
      <h3 className="card-demo__subtitle">Interactive</h3>
      <div className="card-demo__grid">
        <Card onClick={() => setClickCount((c) => c + 1)}>
          <CardHeader title="Clickable Card" subtitle={`Clicked ${clickCount} times`} />
          <CardContent>
            <CardBlock type="description">
              <CardBlockLabel>Click this card or press Enter/Space when focused.</CardBlockLabel>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Clickable Blocks" />
          <CardContent>
            <CardBlock type="link-row" onClick={() => toast.info("Block 1 clicked")} hasSeparator>
              <CardBlockLabel>Click this block</CardBlockLabel>
              <IconChevronRight size={16} />
            </CardBlock>
            <CardBlock type="link-row" onClick={() => toast.info("Block 2 clicked")}>
              <CardBlockLabel>Click this one too</CardBlockLabel>
              <IconChevronRight size={16} />
            </CardBlock>
          </CardContent>
        </Card>
      </div>

      {/* ---- States ---- */}
      <h3 className="card-demo__subtitle">States</h3>
      <div className="card-demo__grid">
        <Card isDisabled onClick={() => {}}>
          <CardHeader title="Disabled Card" subtitle="Cannot interact" />
          <CardContent>
            <CardBlock type="key-value">
              <CardBlockLabel>Status</CardBlockLabel>
              <CardBlockValue>Unavailable</CardBlockValue>
            </CardBlock>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Disabled Blocks" />
          <CardContent>
            <CardBlock type="key-value" isDisabled hasSeparator>
              <CardBlockLabel>Disabled</CardBlockLabel>
              <CardBlockValue>Cannot click</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value">
              <CardBlockLabel>Enabled</CardBlockLabel>
              <CardBlockValue>Normal</CardBlockValue>
            </CardBlock>
          </CardContent>
        </Card>
      </div>

      {/* ---- Full Compositions ---- */}
      <h3 className="card-demo__subtitle">Full Compositions</h3>
      <div className="card-demo__grid">
        <Card>
          <CardHeader
            icon={<IconBrandAws />}
            title="Storage Overview"
            subtitle="Last 30 days"
            actions={[
              <Button variant="icon" size="small" icon={<IconDots />} aria-label="More" key="more" />,
              <Button variant="icon" size="small" icon={<IconChevronDown />} aria-label="Expand" key="expand" />,
            ]}
          />
          <CardContent>
            <CardBlock type="metric" hasSeparator>
              <CardBlockMetric value="5" units="TB" subtitle="Total capacity" />
            </CardBlock>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Region</CardBlockLabel>
              <CardBlockValue>US-East-1</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Provider</CardBlockLabel>
              <CardBlockValue>AWS</CardBlockValue>
            </CardBlock>
            <CardBlock type="status">
              <CardBlockStatus status="success">Cluster healthy</CardBlockStatus>
            </CardBlock>
          </CardContent>
          <CardFooter
            cancelButton={{ variant: "flat", size: "medium", label: "Cancel" }}
            actions={[{ variant: "solid", size: "medium", label: "Action" }]}
          />
        </Card>

        <Card>
          <CardHeader icon={<IconDatabase />} title="Cluster Details" />
          <CardContent>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Name</CardBlockLabel>
              <CardBlockValue>prod-cluster-01</CardBlockValue>
            </CardBlock>
            <CardBlock type="key-value" hasSeparator>
              <CardBlockLabel>Version</CardBlockLabel>
              <CardBlockValue>7.10.2</CardBlockValue>
            </CardBlock>
            <CardBlock type="info-row" hasSeparator>
              <IconServer size={20} />
              <CardBlockLabel>3 nodes across 2 availability zones</CardBlockLabel>
            </CardBlock>
            <CardBlock type="link-row" onClick={() => toast.info("View all nodes")}>
              <CardBlockLabel>View all nodes</CardBlockLabel>
              <IconChevronRight size={16} />
            </CardBlock>
          </CardContent>
          <CardFooter
            variant="fill"
            hasSeparator
            actions={[
              { label: "Edit Cluster" },
              { label: "Deploy" },
            ]}
          />
        </Card>

        <Card>
          <CardHeader
            icon={<IconRefresh />}
            title="Sync Status"
            subtitle="Auto-refresh enabled"
          />
          <CardContent>
            <CardBlock type="status" hasSeparator>
              <CardBlockStatus status="success">Primary: synced</CardBlockStatus>
            </CardBlock>
            <CardBlock type="status" hasSeparator>
              <CardBlockStatus status="warning">Replica 1: syncing</CardBlockStatus>
            </CardBlock>
            <CardBlock type="status">
              <CardBlockStatus status="error">Replica 2: failed</CardBlockStatus>
            </CardBlock>
          </CardContent>
          <CardFooter hasSeparator>
            <IconClock size={14} style={{ color: "var(--text-secondary)" }} />
            <span style={{ fontSize: 12, color: "var(--text-secondary)", marginInlineStart: 6 }}>
              Last sync: 2 min ago
            </span>
            <Button variant="flat" size="small" label="Retry" style={{ marginInlineStart: "auto" }} />
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
