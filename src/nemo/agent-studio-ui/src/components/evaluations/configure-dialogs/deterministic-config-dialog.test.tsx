import { fireEvent, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { EvalDatasetColumnMapping } from "@/routes/pages/evaluations/api/eval.types"
import { DeterministicConfigDialog, METRIC_CATALOG } from "./deterministic-config-dialog"

const EMPTY_MAPPING: EvalDatasetColumnMapping = { id: "", query: "", expected: undefined }

function setup(props: Partial<Parameters<typeof DeterministicConfigDialog>[0]> = {}) {
  const onOpenChange = vi.fn()
  const onSave = vi.fn()
  const utils = renderWithProviders(
    <DeterministicConfigDialog
      open
      onOpenChange={onOpenChange}
      selectedMetricIds={["correctness"]}
      datasetColumnMapping={EMPTY_MAPPING}
      uploadedFileName=""
      onSave={onSave}
      {...props}
    />,
  )
  return { onOpenChange, onSave, ...utils }
}

function fileInput(): HTMLInputElement {
  // The dialog body renders in a portal, so query the whole document.
  return document.querySelector<HTMLInputElement>(".configure-dialog__upload-trigger-input")!
}

function makeFile(content: string, name: string, type = "text/plain"): File {
  return new File([content], name, { type })
}

async function uploadSampleFile(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(fileInput(), makeFile("id,query\n1,Hello", "cases.csv", "text/csv"))
  await screen.findByText("Hello")
}

describe("DeterministicConfigDialog · metrics", () => {
  it("[tag:eval] renders the metric catalog and toggles a metric", async () => {
    const user = userEvent.setup()
    const { onSave } = setup()

    METRIC_CATALOG.forEach((m) => expect(screen.getByText(m.title)).toBeInTheDocument())

    const correctness = screen.getByRole("checkbox", { name: "Select Correctness" })
    expect(correctness).toBeChecked()
    await user.click(correctness) // remove
    await user.click(screen.getByRole("checkbox", { name: "Select RAG quality" })) // add

    await uploadSampleFile(user)
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ metricIds: ["rag_quality"] }),
    )
  })

  it("[tag:eval] select-all metrics selects then clears all", async () => {
    const user = userEvent.setup()
    const { onSave } = setup({ selectedMetricIds: [] })

    const selectAll = screen.getByRole("checkbox", { name: "Select all metrics" })
    await user.click(selectAll) // select all
    await uploadSampleFile(user)
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ metricIds: METRIC_CATALOG.map((m) => m.id) }),
    )
  })

  it("[tag:eval] select-all clears when starting from a full selection", async () => {
    const user = userEvent.setup()
    const { onSave } = setup({ selectedMetricIds: METRIC_CATALOG.map((m) => m.id) })

    await user.click(screen.getByRole("checkbox", { name: "Select all metrics" }))
    await uploadSampleFile(user)
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ metricIds: [] }))
  })

  it("[tag:eval] cancel closes without saving", async () => {
    const user = userEvent.setup()
    const { onOpenChange, onSave } = setup()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:eval] requires a file before saving", async () => {
    const user = userEvent.setup()
    const { onSave } = setup()

    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("File is required.")).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe("DeterministicConfigDialog · upload", () => {
  it("[tag:eval] shows the upload section and requires a file on save", async () => {
    const user = userEvent.setup()
    const { onSave } = setup()

    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByText("File is required.")).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:eval] parses a valid CSV (quoted commas) and saves the detected mapping", async () => {
    const user = userEvent.setup()
    const { onSave } = setup()

    const csv = [
      "id,query,expected",
      '1,"Hello, world","An ""apt"" reply"',
      "2,Second question,Second answer",
    ].join("\n")
    await user.upload(fileInput(), makeFile(csv, "cases.csv"))

    expect(await screen.findByText("Hello, world")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadedFileName: "cases.csv",
        datasetColumnMapping: { id: "id", query: "query", expected: "expected" },
      }),
    )
  })

  it("[tag:eval] parses a JSON array (null values coerced) without an expected column", async () => {
    const user = userEvent.setup()
    setup()

    const json = JSON.stringify([{ id: "1", query: "Q1", note: null }, 42])
    await user.upload(fileInput(), makeFile(json, "cases.json"))

    expect(await screen.findByText("Q1")).toBeInTheDocument()
  })

  it("[tag:eval] parses JSONL with one object per line", async () => {
    const user = userEvent.setup()
    setup()

    const jsonl = ['{"id":"1","query":"Line one"}', "not-json", '{"id":"2","query":"Line two"}'].join("\n")
    await user.upload(fileInput(), makeFile(jsonl, "cases.jsonl"))

    expect(await screen.findByText("Line one")).toBeInTheDocument()
  })

  it("[tag:eval] surfaces an error for an unreadable (empty) file", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile("   ", "empty.csv"))

    expect(await screen.findByText(/Could not read this file/)).toBeInTheDocument()
  })

  it("[tag:eval] surfaces an error when ID/Query columns are missing", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile("foo,bar\n1,2", "bad.csv"))

    expect(await screen.findByText(/File must contain ID and Query columns \(/)).toBeInTheDocument()
  })

  it("[tag:eval] surfaces an error for invalid JSON", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile("{not valid json", "broken.json"))

    expect(await screen.findByText(/Could not read this file/)).toBeInTheDocument()
  })

  it("[tag:eval] removes an uploaded file and clears the preview", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile("id,query\n1,Q", "cases.csv"))
    expect(await screen.findByText("Q")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Remove file" }))
    await waitFor(() => expect(screen.queryByText("Q")).not.toBeInTheDocument())
  })

  it("[tag:eval] paginates the preview when there are more than five rows", async () => {
    const user = userEvent.setup()
    setup()

    const rows = ["id,query"]
    for (let i = 1; i <= 7; i += 1) rows.push(`${i},Question ${i}`)
    await user.upload(fileInput(), makeFile(rows.join("\n"), "cases.csv"))

    expect(await screen.findByText("Question 1")).toBeInTheDocument()
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Next page" }))
    expect(await screen.findByText("Question 6")).toBeInTheDocument()
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Previous page" }))
    expect(await screen.findByText("Question 1")).toBeInTheDocument()
  })

  it("[tag:eval] detects JSON content by shape for a single object without a .json extension", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile('{"id":"1","query":"Single object"}', "obj.txt", "application/json"))
    expect(await screen.findByText("Single object")).toBeInTheDocument()
  })

  it("[tag:eval] detects JSON content by shape for an array without a .json extension", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile('[{"id":"1","query":"Shaped array"}]', "arr.txt", "application/json"))
    expect(await screen.findByText("Shaped array")).toBeInTheDocument()
  })

  it("[tag:eval] treats a non-JSON extension lacking JSON shape as CSV", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile("id,query\n9,Plain text csv", "data.txt", "text/csv"))
    expect(await screen.findByText("Plain text csv")).toBeInTheDocument()
  })

  it("[tag:eval] surfaces an error for a JSON array with no usable records", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile("[1, 2, 3]", "nums.json"))
    expect(await screen.findByText(/Could not read this file/)).toBeInTheDocument()
  })

  it("[tag:eval] surfaces an error for JSONL with only invalid lines", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile("not-json\nalso-bad", "bad.jsonl"))
    expect(await screen.findByText(/Could not read this file/)).toBeInTheDocument()
  })

  it("[tag:eval] surfaces an error for a CSV header with no usable columns", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(fileInput(), makeFile(",,\n1,2,3", "weird.csv"))
    expect(await screen.findByText(/Could not read this file/)).toBeInTheDocument()
  })

  it("[tag:eval] renders em-dash placeholders for empty and short CSV rows", async () => {
    const user = userEvent.setup()
    setup()

    // First row is entirely empty; second row has fewer cells than the header.
    await user.upload(fileInput(), makeFile("id,query,expected\n,,\n7", "sparse.csv"))

    // The short row's id renders; missing query/expected fall back to placeholders.
    expect(await screen.findByText("7")).toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:eval] ignores a change event that carries no file", async () => {
    setup()

    fireEvent.change(fileInput(), { target: { files: [] } })
    expect(screen.queryByText(/Could not read this file/)).not.toBeInTheDocument()
  })
})
