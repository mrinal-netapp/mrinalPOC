/*
 * FS-005 — Reusable usage examples for AddEntityForm.
 *
 * Each named export demonstrates one canonical way to compose the form
 * with realistic props. These examples compile but are not imported by
 * the test suite — they serve as living documentation for consumers.
 *
 * AddEntityForm already wraps every entry in `sections` inside a
 * CardBlock that lives inside an outer Card. Consumers therefore pass
 * the *content* of a section (heading + fields), never a Card or any
 * other component that renders its own Card — doing so produces a
 * nested-Card layout with stacked padding and double borders, which
 * is not the intended composition.
 */
import { useState, type ReactElement } from "react"

import { Typography } from "@/ui-lib/base-components/typography/typography"

import { AddEntityForm } from "./add-entity-form"

/* Minimal usage — a single inline section with a heading and one field. */
export function BasicAddEntity(): ReactElement {
  const [open, setOpen] = useState(true)

  return (
    <AddEntityForm
      open={open}
      title="Add tool"
      entityName="My new tool"
      entityDescription="Configure the tool that agents can call."
      onAdd={() => setOpen(false)}
      onCancel={() => setOpen(false)}
      sections={[
        <div key="details">
          <Typography Component="h3" fontSize="fs16" boldness="semibold">
            Details
          </Typography>
          <Typography fontSize="fs14" color="var(--text-secondary)">
            Name and description.
          </Typography>
          <input type="text" placeholder="Tool name" aria-label="Tool name" />
        </div>,
      ]}
    />
  )
}

/* Multiple sections — each section is plain content; the form draws the
 * outer card and the dividers between sections automatically. */
export function AddToolMultiSection(): ReactElement {
  return (
    <AddEntityForm
      open
      title="Add tool"
      entityName="GitHub MCP"
      entityDescription="Access GitHub repositories from agents."
      addLabel="Save"
      onAdd={() => undefined}
      onCancel={() => undefined}
      sections={[
        <div key="details">
          <Typography Component="h3" fontSize="fs16" boldness="semibold">
            Details
          </Typography>
          <input type="text" placeholder="Tool name" aria-label="Tool name" />
        </div>,
        <div key="connection">
          <Typography Component="h3" fontSize="fs16" boldness="semibold">
            Connection
          </Typography>
          <input
            type="text"
            placeholder="Endpoint URL"
            aria-label="Endpoint URL"
          />
        </div>,
      ]}
    />
  )
}

/* Closed dialog — sanity-check that the form renders nothing when closed. */
export function ClosedAddEntity(): ReactElement | null {
  return (
    <AddEntityForm
      open={false}
      title="Add tool"
      entityName="Hidden"
      entityDescription="You should not see this."
      onAdd={() => undefined}
      onCancel={() => undefined}
      sections={[<div key="x">Hidden section</div>]}
    />
  )
}
