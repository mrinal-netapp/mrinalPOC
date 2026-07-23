import React, { useState } from "react"
import { Tabs } from "@base-ui/react/tabs"

import { Tab } from "./tab"
import type { TabItem } from "./tab"
import { TabGroup, TabContent } from "./tab-group"
import "./tab.demo.scss"

const SampleIcon = (): React.JSX.Element => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="4" width="14" height="3" rx="1" fill="currentColor" />
    <rect x="5" y="9" width="10" height="3" rx="1" fill="currentColor" />
    <rect x="7" y="14" width="6" height="3" rx="1" fill="currentColor" />
  </svg>
)

const GENERAL_TABS: TabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "details", label: "Details" },
  { id: "settings", label: "Settings" },
  { id: "logs", label: "Logs" },
  { id: "disabled-tab", label: "Disabled", isDisabled: true },
]

const CARD_TABS: TabItem[] = [
  { id: "volumes", label: "Volumes" },
  { id: "snapshots", label: "Snapshots" },
  { id: "backups", label: "Backups" },
]

const COUNT_TABS: TabItem[] = [
  { id: "vol", label: "Volumes", count: 500 },
  { id: "snap", label: "Snapshots", count: 12 },
  { id: "bak", label: "Backups", count: 3 },
]

export default function TabDemo(): React.JSX.Element {
  const [controlledTab, setControlledTab] = useState("snapshots")

  return (
    <div className="tab-demo">
      {/* ===== Tab States Grid =====
          Individual Tab primitives are used here directly (via Tabs.Root) to
          showcase isolated states. TabGroup is used for all other sections. */}
      <h2 className="tab-demo__title">Tab — States</h2>

      <div className="tab-demo__grid">
        <div className="tab-demo__cell tab-demo__cell--header" />
        <div className="tab-demo__cell tab-demo__cell--header">General</div>
        <div className="tab-demo__cell tab-demo__cell--header">Card</div>

        <div className="tab-demo__cell tab-demo__cell--label">Default</div>
        <div className="tab-demo__cell">
          <Tabs.Root defaultValue="t1">
            <Tabs.List><Tab id="t1" label="{Label}" variant="general" /></Tabs.List>
          </Tabs.Root>
        </div>
        <div className="tab-demo__cell">
          <Tabs.Root defaultValue="none">
            <Tabs.List><Tab id="t2" label="{Label}" variant="card" /></Tabs.List>
          </Tabs.Root>
        </div>

        <div className="tab-demo__cell tab-demo__cell--label">Hover</div>
        <div className="tab-demo__cell" style={{ fontStyle: "italic", color: "var(--text-disabled)" }}>CSS :hover</div>
        <div className="tab-demo__cell" style={{ fontStyle: "italic", color: "var(--text-disabled)" }}>CSS :hover</div>

        <div className="tab-demo__cell tab-demo__cell--label">Active</div>
        <div className="tab-demo__cell">
          <Tabs.Root defaultValue="t3">
            <Tabs.List><Tab id="t3" label="{Label}" variant="general" /></Tabs.List>
          </Tabs.Root>
        </div>
        <div className="tab-demo__cell">
          <Tabs.Root defaultValue="t4">
            <Tabs.List><Tab id="t4" label="{Label}" variant="card" /></Tabs.List>
          </Tabs.Root>
        </div>

        <div className="tab-demo__cell tab-demo__cell--label">Disabled</div>
        <div className="tab-demo__cell">
          <Tabs.Root defaultValue="none">
            <Tabs.List><Tab id="t5" label="{Label}" variant="general" isDisabled /></Tabs.List>
          </Tabs.Root>
        </div>
        <div className="tab-demo__cell">
          <Tabs.Root defaultValue="none">
            <Tabs.List><Tab id="t6" label="{Label}" variant="card" isDisabled /></Tabs.List>
          </Tabs.Root>
        </div>
      </div>

      {/* ===== With Icon & Count ===== */}
      <h2 className="tab-demo__title">Tab — With Icon & Count</h2>
      <div className="tab-demo__section">
        <p className="tab-demo__subtitle">General — with icon and count</p>
        <div className="tab-demo__row">
          <Tabs.Root defaultValue="volumes">
            <Tabs.List>
              <Tab id="volumes" label="Volumes" icon={<SampleIcon />} count={500} variant="general" />
            </Tabs.List>
          </Tabs.Root>
        </div>

        <p className="tab-demo__subtitle">Card — with count</p>
        <div className="tab-demo__row">
          <Tabs.Root defaultValue="tab-c">
            <Tabs.List>
              <Tab id="tab-c" label="Volumes" count={12} variant="card" />
            </Tabs.List>
          </Tabs.Root>
        </div>
      </div>
      {/* =============== TabGroup  =============== */}
      {/* ===== Variant x Fitting Combinations ===== */}
      <h2 className="tab-demo__title">TabGroup — Variant x Fitting Combinations</h2>
      <div className="tab-demo__combos">
        <div className="tab-demo__combo">
          <p className="tab-demo__subtitle">General + Fit-content</p>
          <div className="tab-demo__combo-box">
            <TabGroup tabs={GENERAL_TABS} variant="general" fitting="fit-content" />
          </div>
        </div>

        <div className="tab-demo__combo">
          <p className="tab-demo__subtitle">General + Fill-container</p>
          <div className="tab-demo__combo-box">
            <TabGroup tabs={GENERAL_TABS} variant="general" fitting="fill-container" />
          </div>
        </div>

        <div className="tab-demo__combo">
          <p className="tab-demo__subtitle">Card + Fit-content</p>
          <div className="tab-demo__combo-box">
            <TabGroup tabs={GENERAL_TABS} variant="card" fitting="fit-content" />
          </div>
        </div>

        <div className="tab-demo__combo">
          <p className="tab-demo__subtitle">Card + Fill-container</p>
          <div className="tab-demo__combo-box">
            <TabGroup tabs={GENERAL_TABS} variant="card" fitting="fill-container" />
          </div>
        </div>
      </div>

      {/* ===== TabGroup — With Content Panels ===== */}
      <h2 className="tab-demo__title">TabGroup — With Content Panels</h2>
      <div className="tab-demo__section">
        <p className="tab-demo__subtitle">General + Fit-content (uncontrolled)</p>
        <div className="tab-demo__box">
          <TabGroup tabs={GENERAL_TABS} variant="general" fitting="fit-content">
            <TabContent tabId="overview">
              <p className="tab-demo__panel-content">Overview panel content</p>
            </TabContent>
            <TabContent tabId="details">
              <p className="tab-demo__panel-content">Details panel content</p>
            </TabContent>
            <TabContent tabId="settings">
              <p className="tab-demo__panel-content">Settings panel content</p>
            </TabContent>
            <TabContent tabId="logs">
              <p className="tab-demo__panel-content">Logs panel content</p>
            </TabContent>
          </TabGroup>
        </div>
        <p className="tab-demo__subtitle">Card + Fit-content (uncontrolled)</p>
        <div className="tab-demo__box" style={{ padding: 0 }}>
          <TabGroup tabs={CARD_TABS} variant="card" fitting="fit-content">
            <TabContent tabId="volumes">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Volumes panel content</p>
            </TabContent>
            <TabContent tabId="snapshots">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Snapshots panel content</p>
            </TabContent>
            <TabContent tabId="backups">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Backups panel content</p>
            </TabContent>
          </TabGroup>
        </div>
        <p className="tab-demo__subtitle">Card + Fill-container (uncontrolled)</p>
        <div className="tab-demo__box" style={{ padding: 0 }}>
          <TabGroup tabs={CARD_TABS} variant="card" fitting="fill-container">
            <TabContent tabId="volumes">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Volumes panel content</p>
            </TabContent>
            <TabContent tabId="snapshots">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Snapshots panel content</p>
            </TabContent>
            <TabContent tabId="backups">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Backups panel content</p>
            </TabContent>
          </TabGroup>
        </div>
      </div>

      {/* ===== TabGroup — With Counts ===== */}
      <h2 className="tab-demo__title">TabGroup — General, With Counts</h2>
      <div className="tab-demo__section">
        <div className="tab-demo__box">
          <TabGroup tabs={COUNT_TABS} variant="general" fitting="fit-content">
            <TabContent tabId="vol">
              <p className="tab-demo__panel-content">500 volumes listed here</p>
            </TabContent>
            <TabContent tabId="snap">
              <p className="tab-demo__panel-content">12 snapshots listed here</p>
            </TabContent>
            <TabContent tabId="bak">
              <p className="tab-demo__panel-content">3 backups listed here</p>
            </TabContent>
          </TabGroup>
        </div>
      </div>

      {/* ===== TabGroup — Controlled ===== */}
      <h2 className="tab-demo__title">TabGroup — Controlled, Card</h2>
      <div className="tab-demo__section">
        <p className="tab-demo__subtitle">
          Active tab: <strong>{controlledTab}</strong> (click tabs or buttons)
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {CARD_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setControlledTab(t.id)}
              style={{
                padding: "4px 12px",
                borderRadius: 4,
                border: "1px solid var(--border-main)",
                background: controlledTab === t.id ? "var(--text-button-primary)" : "var(--background-content)",
                color: controlledTab === t.id ? "white" : "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="tab-demo__box" style={{ padding: 0 }}>
          <TabGroup
            tabs={CARD_TABS}
            variant="card"
            fitting="fill-container"
            activeTabId={controlledTab}
            onTabChange={setControlledTab}
          >
            <TabContent tabId="volumes">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Volumes — controlled panel</p>
            </TabContent>
            <TabContent tabId="snapshots">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Snapshots — controlled panel</p>
            </TabContent>
            <TabContent tabId="backups">
              <p className="tab-demo__panel-content" style={{ padding: "16px" }}>Backups — controlled panel</p>
            </TabContent>
          </TabGroup>
        </div>
      </div>

      {/* ===== TabGroup — Disable All ===== */}
      <h2 className="tab-demo__title">TabGroup — Disabled All</h2>
      <div className="tab-demo__section">
        <div className="tab-demo__box">
          <TabGroup tabs={GENERAL_TABS.slice(0, 3)} variant="general" disableAll />
        </div>
      </div>

      {/* ===== TabGroup — Vertical ===== */}
      <h2 className="tab-demo__title">TabGroup — Vertical Orientation</h2>
      <div className="tab-demo__section">
        <div className="tab-demo__box">
          <TabGroup
            tabs={GENERAL_TABS.slice(0, 4)}
            variant="general"
            fitting="fit-content"
            orientation="vertical"
          >
            <TabContent tabId="overview">
              <p className="tab-demo__panel-content">Overview — vertical layout</p>
            </TabContent>
            <TabContent tabId="details">
              <p className="tab-demo__panel-content">Details — vertical layout</p>
            </TabContent>
            <TabContent tabId="settings">
              <p className="tab-demo__panel-content">Settings — vertical layout</p>
            </TabContent>
            <TabContent tabId="logs">
              <p className="tab-demo__panel-content">Logs — vertical layout</p>
            </TabContent>
          </TabGroup>
        </div>
      </div>
    </div>
  )
}
