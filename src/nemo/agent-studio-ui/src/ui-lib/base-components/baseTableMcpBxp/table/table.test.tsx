import { render, screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "./table"

describe("Table primitives", () => {
  it("renders Table with data-slot and className", () => {
    const { container } = render(
      <Table className="extra">
        <TableBody>
          <TableRow>
            <TableCell>cell</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )
    const tableEl = container.querySelector('[data-slot="table"]')
    expect(tableEl).toBeInTheDocument()
    expect(container.querySelector('[data-slot="table-container"]')).toHaveClass("extra")
  })

  it("renders TableHeader with data-slot", () => {
    const { container } = render(
      <table>
        <TableHeader>
          <TableRow>
            <TableHead>H</TableHead>
          </TableRow>
        </TableHeader>
      </table>,
    )
    expect(container.querySelector('[data-slot="table-header"]')).toBeInTheDocument()
  })

  it("renders TableBody with data-slot", () => {
    const { container } = render(
      <table>
        <TableBody>
          <TableRow>
            <TableCell>B</TableCell>
          </TableRow>
        </TableBody>
      </table>,
    )
    expect(container.querySelector('[data-slot="table-body"]')).toBeInTheDocument()
  })

  it("renders TableFooter with data-slot", () => {
    const { container } = render(
      <table>
        <TableFooter>
          <TableRow>
            <TableCell>F</TableCell>
          </TableRow>
        </TableFooter>
      </table>,
    )
    expect(container.querySelector('[data-slot="table-footer"]')).toBeInTheDocument()
  })

  it("renders TableRow with data-slot", () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow>
            <TableCell>R</TableCell>
          </TableRow>
        </tbody>
      </table>,
    )
    expect(container.querySelector('[data-slot="table-row"]')).toBeInTheDocument()
  })

  it("renders TableHead with data-slot", () => {
    const { container } = render(
      <table>
        <thead>
          <tr>
            <TableHead>TH</TableHead>
          </tr>
        </thead>
      </table>,
    )
    expect(container.querySelector('[data-slot="table-head"]')).toBeInTheDocument()
  })

  it("renders TableCell with data-slot", () => {
    render(
      <table>
        <tbody>
          <tr>
            <TableCell>TD</TableCell>
          </tr>
        </tbody>
      </table>,
    )
    expect(screen.getByText("TD")).toHaveAttribute("data-slot", "table-cell")
  })

  it("renders TableCaption with data-slot", () => {
    render(
      <table>
        <TableCaption>My Caption</TableCaption>
      </table>,
    )
    expect(screen.getByText("My Caption")).toHaveAttribute("data-slot", "table-caption")
  })

  it("forwards custom className to each primitive", () => {
    const { container } = render(
      <Table className="t-extra">
        <TableHeader className="th-extra">
          <TableRow className="tr-extra">
            <TableHead className="thd-extra">H</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tb-extra">
          <TableRow>
            <TableCell className="td-extra">C</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter className="tf-extra">
          <TableRow>
            <TableCell>F</TableCell>
          </TableRow>
        </TableFooter>
      </Table>,
    )
    expect(container.querySelector('[data-slot="table-container"]')).toHaveClass("t-extra")
    expect(container.querySelector('[data-slot="table-header"]')).toHaveClass("th-extra")
    expect(container.querySelector('[data-slot="table-body"]')).toHaveClass("tb-extra")
    expect(container.querySelector('[data-slot="table-footer"]')).toHaveClass("tf-extra")
    expect(container.querySelector(".thd-extra")).toBeInTheDocument()
    expect(container.querySelector(".td-extra")).toBeInTheDocument()
    expect(container.querySelector(".tr-extra")).toBeInTheDocument()
  })
})
