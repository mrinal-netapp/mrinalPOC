import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { ModelDetail, ModelStatusBadge } from "./model-detail"
import type { ModelStatus } from "./model-detail.types"

describe("ModelStatusBadge", () => {
  it.each<ModelStatus>(["Active", "Inactive", "Failed"])(
    "[tag:model-detail] renders the %s status label",
    (status) => {
      renderWithProviders(<ModelStatusBadge status={status} />)
      expect(screen.getByText(status)).toBeInTheDocument()
    },
  )
})

describe("ModelDetail", () => {
  it("[tag:model-detail] renders the not-found empty state for the requested id", () => {
    renderWithProviders(undefined, {
      routeConfig: [
        { path: "/models/:modelId", element: <ModelDetail /> },
        { path: "/models", element: <div>Models list</div> },
      ],
      initialEntries: ["/models/missing-123"],
    })

    expect(screen.getByRole("heading", { name: "Model not found" })).toBeInTheDocument()
    expect(screen.getByText(/missing-123/)).toBeInTheDocument()
  })

  it("[tag:model-detail] navigates back to the models list", async () => {
    renderWithProviders(undefined, {
      routeConfig: [
        { path: "/models/:modelId", element: <ModelDetail /> },
        { path: "/models", element: <div>Models list</div> },
      ],
      initialEntries: ["/models/missing-123"],
    })

    await userEvent.click(screen.getByRole("button", { name: /Back to Models/ }))
    expect(await screen.findByText("Models list")).toBeInTheDocument()
  })
})
