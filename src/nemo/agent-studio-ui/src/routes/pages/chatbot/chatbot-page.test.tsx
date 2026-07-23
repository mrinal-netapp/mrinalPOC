import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { renderWithProviders } from "@test/render"

import { ChatbotPage } from "./chatbot-page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatbotPage", () => {
  it("[tag:chatbot-page] renders an iframe with the chatbot src", () => {
    renderWithProviders(<ChatbotPage />)

    const iframe = screen.getByTitle("Chatbot")
    expect(iframe).toBeInTheDocument()
    expect(iframe.tagName.toLowerCase()).toBe("iframe")
    expect(iframe).toHaveAttribute("src", expect.stringContaining("chatbot"))
  })
})
