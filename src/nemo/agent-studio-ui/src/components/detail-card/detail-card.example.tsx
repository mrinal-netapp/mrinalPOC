import type { ReactElement } from "react"

import { DetailCard, TabContent } from "./detail-card"
import type { DetailCardRow } from "./detail-card.types"
import { Typography } from "@/ui-lib/base-components/typography/typography"

const SAMPLE_ROWS: DetailCardRow[] = [
  { label: "Name", value: "sample-entity-01" },
  { label: "Type", value: "Custom" },
  { label: "Created", value: "Feb 10, 2026, 7:15:06 AM" },
]

// Most common case — the built-in "Details" tab only.
// Reach for this when the surface you're describing is a flat list of
// label/value pairs with no other shapes to show.
function Basic(): ReactElement {
  return <DetailCard rows={SAMPLE_ROWS} />
}

// Adds a second tab alongside Details for content that isn't a key/value list
// (here: a cost summary card). The consumer owns the extra tab's content via
// `<TabContent tabId="...">` so DetailCard stays unopinionated about layout.
function WithExtraTab(): ReactElement {
  return (
    <DetailCard
      rows={SAMPLE_ROWS}
      extraTabs={[{ id: "cost", label: "Cost configuration" }]}
    >
      <TabContent tabId="cost">
        <Typography fontSize="fs14">
          Inject cost configuration content here.
        </Typography>
      </TabContent>
    </DetailCard>
  )
}

// Multiple extra tabs — pick this when the entity has 2+ secondary aspects
// (e.g. cost configuration AND advanced settings) that don't belong in the
// primary key/value list but should travel with the entity's card.
function WithMultipleExtraTabs(): ReactElement {
  return (
    <DetailCard
      rows={SAMPLE_ROWS}
      extraTabs={[
        { id: "cost", label: "Cost configuration" },
        { id: "advanced", label: "Advanced" },
      ]}
    >
      <TabContent tabId="cost">
        <Typography fontSize="fs14">Cost details here.</Typography>
      </TabContent>
      <TabContent tabId="advanced">
        <Typography fontSize="fs14">Advanced settings here.</Typography>
      </TabContent>
    </DetailCard>
  )
}

export { Basic, WithExtraTab, WithMultipleExtraTabs }
