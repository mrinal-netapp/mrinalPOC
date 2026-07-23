import { describe, it, expect, afterEach } from "vitest"
import { createElementGhost, createDragGhost, clearDragGhost } from "./drag-ghost"

afterEach(() => {
  clearDragGhost()
})

describe("createDragGhost", () => {
  it("creates a div with the given label and appends it to the body", () => {
    const ghost = createDragGhost("Dragging item")
    expect(ghost.textContent).toBe("Dragging item")
    expect(ghost.parentNode).toBe(document.body)
  })

  it("uses the default className when none is provided", () => {
    const ghost = createDragGhost("Label")
    expect(ghost.className).toBe("dt-drag-ghost")
  })

  it("uses a custom className when provided", () => {
    const ghost = createDragGhost("Label", "my-ghost")
    expect(ghost.className).toBe("my-ghost")
  })

  it("positions the ghost off-screen", () => {
    const ghost = createDragGhost("Label")
    expect(ghost.style.position).toBe("fixed")
    expect(ghost.style.top).toBe("-1000px")
    expect(ghost.style.left).toBe("-1000px")
  })

  it("sets aria-hidden on the ghost", () => {
    const ghost = createDragGhost("Label")
    expect(ghost.getAttribute("aria-hidden")).toBe("true")
  })

  it("removes a previous ghost when creating a new one", () => {
    const first = createDragGhost("First")
    expect(first.parentNode).toBe(document.body)

    const second = createDragGhost("Second")
    expect(first.parentNode).toBeNull()
    expect(second.parentNode).toBe(document.body)
  })
})

describe("createElementGhost", () => {
  it("wraps a <tr> clone in table > tbody structure inside .dt-table wrapper", () => {
    const tr = document.createElement("tr")
    const td = document.createElement("td")
    td.textContent = "Cell"
    tr.appendChild(td)
    document.body.appendChild(tr)

    const ghost = createElementGhost(tr)

    expect(ghost.className).toContain("dt-table")
    expect(ghost.querySelector("table")).not.toBeNull()
    expect(ghost.querySelector("tbody")).not.toBeNull()
    expect(ghost.querySelector("td")?.textContent).toBe("Cell")
    expect(ghost.parentNode).toBe(document.body)

    document.body.removeChild(tr)
  })

  it("wraps a <th> clone in table > tr structure inside .dt-table wrapper", () => {
    const th = document.createElement("th")
    th.textContent = "Header"
    document.body.appendChild(th)

    const ghost = createElementGhost(th)

    expect(ghost.className).toContain("dt-table")
    const table = ghost.querySelector("table")!
    expect(table.querySelector("tr")).not.toBeNull()
    expect(table.querySelector("th")?.textContent).toBe("Header")

    document.body.removeChild(th)
  })

  it("wraps a <td> clone in table > tr structure inside .dt-table wrapper", () => {
    const td = document.createElement("td")
    td.textContent = "Data"
    document.body.appendChild(td)

    const ghost = createElementGhost(td)

    expect(ghost.className).toContain("dt-table")
    expect(ghost.querySelector("tr")).not.toBeNull()
    expect(ghost.querySelector("td")?.textContent).toBe("Data")

    document.body.removeChild(td)
  })

  it("clones a non-table element directly without wrapping", () => {
    const div = document.createElement("div")
    div.textContent = "Content"
    document.body.appendChild(div)

    const ghost = createElementGhost(div)

    expect(ghost.tagName.toLowerCase()).toBe("div")
    expect(ghost.textContent).toBe("Content")
    expect(ghost.querySelector("table")).toBeNull()

    document.body.removeChild(div)
  })

  it("sets aria-hidden on the ghost", () => {
    const div = document.createElement("div")
    document.body.appendChild(div)

    const ghost = createElementGhost(div)
    expect(ghost.getAttribute("aria-hidden")).toBe("true")

    document.body.removeChild(div)
  })

  it("strips id attributes from cloned descendants", () => {
    const div = document.createElement("div")
    div.id = "parent-id"
    const child = document.createElement("span")
    child.id = "child-id"
    div.appendChild(child)
    document.body.appendChild(div)

    const ghost = createElementGhost(div)
    expect(ghost.querySelectorAll("[id]").length).toBe(0)

    document.body.removeChild(div)
  })

  it("removes a previous ghost when creating a new one", () => {
    const div1 = document.createElement("div")
    document.body.appendChild(div1)
    const first = createElementGhost(div1)

    const div2 = document.createElement("div")
    document.body.appendChild(div2)
    createElementGhost(div2)

    expect(first.parentNode).toBeNull()

    document.body.removeChild(div1)
    document.body.removeChild(div2)
  })

  it("applies visual styles to the ghost", () => {
    const div = document.createElement("div")
    document.body.appendChild(div)

    const ghost = createElementGhost(div)
    expect(ghost.style.opacity).toBe("0.85")
    expect(ghost.style.pointerEvents).toBe("none")

    document.body.removeChild(div)
  })
})

describe("clearDragGhost", () => {
  it("removes the current ghost from the DOM", () => {
    const ghost = createDragGhost("Ghost")
    expect(ghost.parentNode).toBe(document.body)

    clearDragGhost()
    expect(ghost.parentNode).toBeNull()
  })

  it("is safe to call multiple times", () => {
    createDragGhost("Ghost")
    clearDragGhost()
    clearDragGhost()
  })

  it("is safe to call when no ghost exists", () => {
    clearDragGhost()
  })
})
