import { describe, expect, it } from "vitest"

import { getToolsetSummaryStatusPresentation } from "./toolset-detail-status"

describe("getToolsetSummaryStatusPresentation", () => {
  it("[tag:toolset-detail] maps healthy statuses", () => {
    expect(getToolsetSummaryStatusPresentation("Healthy").className).toBe(
      "toolset-detail__status--healthy",
    )
    expect(getToolsetSummaryStatusPresentation("success").className).toBe(
      "toolset-detail__status--healthy",
    )
  })

  it("[tag:toolset-detail] maps unhealthy statuses", () => {
    expect(getToolsetSummaryStatusPresentation("Unhealthy").className).toBe(
      "toolset-detail__status--unhealthy",
    )
    expect(getToolsetSummaryStatusPresentation("failed").className).toBe(
      "toolset-detail__status--unhealthy",
    )
  })

  it("[tag:toolset-detail] maps unknown statuses to warning", () => {
    expect(getToolsetSummaryStatusPresentation("Unknown").className).toBe(
      "toolset-detail__status--warning",
    )
  })

  it("[tag:toolset-detail] maps deploying/provisioning statuses", () => {
    expect(getToolsetSummaryStatusPresentation("Deploying").className).toBe(
      "toolset-detail__status--deploying",
    )
    expect(getToolsetSummaryStatusPresentation("provisioning").className).toBe(
      "toolset-detail__status--deploying",
    )
  })
})
