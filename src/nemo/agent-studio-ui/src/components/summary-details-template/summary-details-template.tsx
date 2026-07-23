import { useState, type ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { Breadcrumb } from "@/ui-lib/base-components/breadcrumb/breadcrumb"
import { TabContent, TabGroup } from "@/ui-lib/base-components/tab/tab-group"
import type { TabItem } from "@/ui-lib/base-components/tab/tab"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import type { SummaryDetailsTemplateProps, SummaryField } from "./summary-details-template.types"
import "./summary-details-template.scss"

function SummaryStripField({
  field,
  showDividerAfter,
  isLeadingField = false,
}: {
  field: SummaryField
  showDividerAfter: boolean
  isLeadingField?: boolean
}): ReactElement {
  return (
    <div className="summary-details-template__summary-group">
      <div
        className={`summary-details-template__summary-field${isLeadingField ? " summary-details-template__summary-field--leading" : ""}`}
      >
        <Typography fontSize="fs14" color="var(--text-secondary)">
          {field.label}
        </Typography>
        <div className="summary-details-template__summary-value">
          {typeof field.value === "string" || typeof field.value === "number" ? (
            <Typography fontSize="fs14" boldness="semibold">
              {field.value}
            </Typography>
          ) : (
            field.value
          )}
        </div>
      </div>
      {showDividerAfter && (
        <div className="summary-details-template__summary-divider" />
      )}
    </div>
  )
}

/**
 * Reusable layout for "entity details" screens (Model, Toolset, Dataset…).
 *
 * Composes (top to bottom):
 *   1. Breadcrumbs + page title + action slot
 *   2. Summary strip rendering `summaryFields` as label/value pairs
 *   3. `<TabGroup>` whose panels come straight from `tabPanels`
 *
 * Reach for this template when a screen needs all three pieces. If you only
 * need one, use the underlying component directly (`<TabGroup>`); the
 * template doesn't add value when the layout is partial.
 *
 * See `summary-details-template.example.tsx` for usage patterns (Basic,
 * `WithDisabledTab`, etc.).
 */
function SummaryDetailsTemplate({
  title,
  breadcrumbs,
  actions,
  summaryFields,
  summaryStripLayout = "row",
  tabPanels,
  className,
}: SummaryDetailsTemplateProps): ReactElement {
  const firstActiveTab = tabPanels.find((p) => !p.tab.isDisabled)?.tab.id ?? tabPanels[0]?.tab.id ?? ""
  const [requestedActiveTabId, setRequestedActiveTabId] = useState(firstActiveTab)

  const tabs: TabItem[] = tabPanels.map((p) => p.tab)
  const requestedActivePanel = tabPanels.find((panel) => panel.tab.id === requestedActiveTabId)
  const activeTabId = requestedActivePanel && !requestedActivePanel.tab.isDisabled
    ? requestedActiveTabId
    : firstActiveTab

  return (
    <div className={`summary-details-template${className ? ` ${className}` : ""}`}>
      <div className="summary-details-template__header">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <Breadcrumb items={breadcrumbs} />
        )}
        <div className="summary-details-template__title-row">
          <Typography Component="h1" fontSize="fs24" boldness="semibold">
            {title}
          </Typography>
          {actions && (
            <div className="summary-details-template__actions">{actions}</div>
          )}
        </div>
      </div>

      {/* Summary strip — inlined; not exposed as its own component because
          the strip is tightly coupled to this template's layout and has no
          other consumers in the product. */}
      <Card className="summary-details-template__summary">
        <CardContent>
          <div
            className={`summary-details-template__summary-grid${
              summaryStripLayout === "split" ? " summary-details-template__summary-grid--split" : ""
            }`}
          >
            {summaryStripLayout === "split" && summaryFields.length > 0 ? (
              <>
                <SummaryStripField
                  key={`${summaryFields[0].label}-0`}
                  field={summaryFields[0]}
                  showDividerAfter={false}
                  isLeadingField
                />
                {summaryFields.length > 1 && (
                  <div className="summary-details-template__summary-trailing">
                    {summaryFields.slice(1).map((field, idx, trailingFields) => (
                      <SummaryStripField
                        key={`${field.label}-${idx + 1}`}
                        field={field}
                        showDividerAfter={idx < trailingFields.length - 1}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              summaryFields.map((field, idx) => (
                <SummaryStripField
                  key={`${field.label}-${idx}`}
                  field={field}
                  showDividerAfter={idx < summaryFields.length - 1}
                />
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <TabGroup
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={setRequestedActiveTabId}
        ariaLabel={`${title} sections`}
      >
        {tabPanels.map((panel) => (
          <TabContent key={panel.tab.id} tabId={panel.tab.id}>
            {panel.content ?? (
              <div className="summary-details-template__tab-placeholder">
                Content for "{panel.tab.label}" goes here
              </div>
            )}
          </TabContent>
        ))}
      </TabGroup>
    </div>
  )
}

export { SummaryDetailsTemplate }
export type { SummaryDetailsTemplateProps, SummaryField, TabPanel } from "./summary-details-template.types"
