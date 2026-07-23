/**
 * Drag ghost element manager to prevent memory leaks.
 * Manages a single ghost element for drag operations.
 */

let currentGhost: HTMLElement | null = null

const GHOST_POSITION_STYLES: Partial<CSSStyleDeclaration> = {
    position: "fixed",
    top: "-1000px",
    left: "-1000px",
    pointerEvents: "none",
    zIndex: "99999",
}

/**
 * Create a drag ghost by cloning a live DOM element (e.g. a `<tr>` or `<th>`).
 * Table elements are wrapped in a minimal `<table>` structure inside a
 * `.dt-table` container so page-scoped table styles apply to the clone.
 * The wrapper is positioned off-screen and used as the drag image.
 */
export function createElementGhost(source: HTMLElement): HTMLElement {
    clearDragGhost()

    const rect = source.getBoundingClientRect()
    const clone = source.cloneNode(true) as HTMLElement
    const tag = source.tagName.toLowerCase()

    let ghost: HTMLElement

    if (tag === "tr" || tag === "th" || tag === "td") {
        const table = document.createElement("table")
        Object.assign(table.style, {
            borderCollapse: "collapse",
            tableLayout: "fixed",
            width: `${rect.width}px`,
        })

        if (tag === "tr") {
            const tbody = document.createElement("tbody")
            tbody.appendChild(clone)
            table.appendChild(tbody)
        } else {
            const tr = document.createElement("tr")
            clone.style.width = `${rect.width}px`
            tr.appendChild(clone)
            table.appendChild(tr)
        }

        // Wrap in .dt-table so scoped table styles apply to the clone
        const wrapper = document.createElement("div")
        wrapper.className = "dt-table"
        wrapper.appendChild(table)
        ghost = wrapper
    } else {
        clone.style.width = `${rect.width}px`
        ghost = clone
    }

    Object.assign(ghost.style, {
        ...GHOST_POSITION_STYLES,
        opacity: "0.85",
        boxShadow: "2px 4px 12px rgba(0, 0, 0, 0.18)",
        borderRadius: "4px",
        overflow: "hidden",
    } satisfies Partial<CSSStyleDeclaration>)

    ghost.setAttribute("aria-hidden", "true")
    ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"))

    document.body.appendChild(ghost)
    currentGhost = ghost
    return ghost
}

/**
 * Create a simple text-label ghost (useful outside of table contexts).
 * Positioned off-screen; caller should pass the return value to setDragImage.
 */
export function createDragGhost(label: string, className = "dt-drag-ghost"): HTMLElement {
    clearDragGhost()

    const ghost = document.createElement("div")
    ghost.className = className
    ghost.textContent = label

    Object.assign(ghost.style, {
        ...GHOST_POSITION_STYLES,
        padding: "6px 16px",
        borderRadius: "4px",
        background: "var(--background-content, #fff)",
        border: "1px solid var(--border-main, #e0e0e0)",
        boxShadow: "2px 2px 8px rgba(0, 0, 0, 0.15)",
        fontFamily: "var(--font-family, sans-serif)",
        fontSize: "13px",
        fontWeight: "500",
        lineHeight: "20px",
        color: "var(--text-primary, #1c1c1c)",
        whiteSpace: "nowrap",
        opacity: "0.92",
    } satisfies Partial<CSSStyleDeclaration>)

    ghost.setAttribute("aria-hidden", "true")

    document.body.appendChild(ghost)
    currentGhost = ghost
    return ghost
}

/**
 * Remove the current drag ghost element from the DOM.
 * Safe to call multiple times.
 */
export function clearDragGhost(): void {
    if (currentGhost && currentGhost.parentNode) {
        currentGhost.parentNode.removeChild(currentGhost)
    }
    currentGhost = null
}
