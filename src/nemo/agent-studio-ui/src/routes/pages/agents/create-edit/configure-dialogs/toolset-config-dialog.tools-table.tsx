import { useMemo, useState, type ReactElement } from "react"
import {
  IconArrowsUpDown,
  IconChevronDown,
  IconChevronUp,
  IconSearch,
  IconX,
} from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { Checkbox } from "@/ui-lib/base-components/checkbox/checkbox"
import { Input } from "@/ui-lib/base-components/input/input"
import { Typography } from "@/ui-lib/base-components/typography/typography"

import { TOOLSET_CONFIG_STRINGS } from "./configure-dialogs.consts"
import type { ToolsetTool } from "./configure-dialogs.types"

type SortDirection = "asc" | "desc"
type SortKey = "name" | "description"

type ToolsSelectionTableProps = {
  tools: ToolsetTool[]
  selectedToolIds: string[]
  onSelectionChange: (next: string[]) => void
  emptyMessage?: string
}

/**
 * Controlled multi-select table used inside ToolsetConfigDialog.
 *
 * Lives as a sibling (rather than inline) because it owns its own UI state
 * for sort + search and would clutter the dialog file — same pattern as
 * `catalog-mcp-config-card.tsx` next to `catalog-mcp-config-dialog.tsx`.
 *
 * Not extracted further: this is a dialog implementation detail and is
 * intentionally not exported from any barrel.
 */
function ToolsSelectionTable({
  tools,
  selectedToolIds,
  onSelectionChange,
  emptyMessage,
}: ToolsSelectionTableProps): ReactElement {
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc")

  const visibleTools = useMemo(() => {
    const trimmed = search.trim().toLowerCase()
    const filtered = trimmed
      ? tools.filter(
        (t) =>
          t.name.toLowerCase().includes(trimmed) ||
          t.description.toLowerCase().includes(trimmed),
      )
      : tools

    if (sortKey === null) return filtered
    const sign = sortDirection === "asc" ? 1 : -1
    return [...filtered].sort((a, b) => sign * a[sortKey].localeCompare(b[sortKey]))
  }, [tools, search, sortKey, sortDirection])

  const selectedSet = useMemo(() => new Set(selectedToolIds), [selectedToolIds])

  // Header checkbox: 'all' when every VISIBLE row is selected, 'none' when
  // none, 'some' when partial — operates on the filtered set so bulk-select
  // honors the active search.
  const visibleIds = visibleTools.map((t) => t.id)
  const visibleSelectedCount = visibleIds.filter((id) => selectedSet.has(id)).length
  const allVisibleSelected =
    visibleIds.length > 0 && visibleSelectedCount === visibleIds.length
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected

  const handleHeaderToggle = (next: boolean): void => {
    if (next) {
      // Add visible rows to existing selection, preserving any off-screen
      // (filtered-out) selections so search doesn't drop them.
      const merged = new Set(selectedToolIds)
      visibleIds.forEach((id) => merged.add(id))
      onSelectionChange(Array.from(merged))
    } else {
      const visibleSetIds = new Set(visibleIds)
      onSelectionChange(selectedToolIds.filter((id) => !visibleSetIds.has(id)))
    }
  }

  const handleRowToggle = (toolId: string, next: boolean): void => {
    if (next) {
      if (selectedSet.has(toolId)) return
      onSelectionChange([...selectedToolIds, toolId])
    } else {
      onSelectionChange(selectedToolIds.filter((id) => id !== toolId))
    }
  }

  const handleSort = (key: SortKey): void => {
    if (sortKey !== key) {
      setSortKey(key)
      setSortDirection("asc")
      return
    }
    if (sortDirection === "asc") {
      setSortDirection("desc")
    } else {
      setSortKey(null)
      setSortDirection("asc")
    }
  }

  const closeSearch = (): void => {
    setSearch("")
    setIsSearchOpen(false)
  }

  const tableTitle = TOOLSET_CONFIG_STRINGS.TOOLS_TABLE_TITLE_TEMPLATE.replace(
    "{count}",
    String(tools.length),
  )

  return (
    <div className="toolset-config-dialog__tools-table">
      <div className="toolset-config-dialog__tools-toolbar">
        <Typography Component="span" fontSize="fs14" boldness="semibold">
          {tableTitle}
        </Typography>

        <div className="toolset-config-dialog__tools-toolbar-actions">
          {isSearchOpen ? (
            <div className="toolset-config-dialog__tools-search">
              <Input
                value={search}
                placeholder={TOOLSET_CONFIG_STRINGS.TOOLS_SEARCH_PLACEHOLDER}
                aria-label={TOOLSET_CONFIG_STRINGS.TOOLS_SEARCH_ARIA_LABEL}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
              <Button
                variant="icon"
                size="small"
                icon={<IconX size={16} />}
                aria-label="Close search"
                onClick={closeSearch}
              />
            </div>
          ) : (
            <Button
              variant="icon"
              size="small"
              icon={<IconSearch size={18} />}
              aria-label={TOOLSET_CONFIG_STRINGS.TOOLS_SEARCH_ARIA_LABEL}
              onClick={() => setIsSearchOpen(true)}
            />
          )}
        </div>
      </div>

      <table className="toolset-config-dialog__table" role="grid">
        <thead>
          <tr>
            <th scope="col" className="toolset-config-dialog__th toolset-config-dialog__th--checkbox">
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected}
                onCheckedChange={(next) => handleHeaderToggle(next)}
                ariaLabel={TOOLSET_CONFIG_STRINGS.TOOLS_SELECT_ALL_ARIA_LABEL}
                isDisabled={visibleIds.length === 0}
              />
            </th>
            <SortableHeader
              label={TOOLSET_CONFIG_STRINGS.TOOLS_COLUMN_NAME}
              isSorted={sortKey === "name"}
              direction={sortKey === "name" ? sortDirection : "asc"}
              onSort={() => handleSort("name")}
            />
            <SortableHeader
              label={TOOLSET_CONFIG_STRINGS.TOOLS_COLUMN_DESCRIPTION}
              isSorted={sortKey === "description"}
              direction={sortKey === "description" ? sortDirection : "asc"}
              onSort={() => handleSort("description")}
            />
          </tr>
        </thead>
        <tbody>
          {visibleTools.length === 0 ? (
            <tr>
              <td colSpan={3} className="toolset-config-dialog__empty-cell">
                <Typography fontSize="fs14" color="var(--text-secondary)">
                  {emptyMessage ??
                    (search.trim()
                      ? TOOLSET_CONFIG_STRINGS.NO_TOOLS_MATCH_SEARCH_MESSAGE
                      : TOOLSET_CONFIG_STRINGS.NO_TOOLS_AVAILABLE_MESSAGE)}
                </Typography>
              </td>
            </tr>
          ) : (
            visibleTools.map((tool) => {
              const isSelected = selectedSet.has(tool.id)
              return (
                <tr key={tool.id} className="toolset-config-dialog__tr" data-selected={isSelected || undefined}>
                  <td className="toolset-config-dialog__td toolset-config-dialog__td--checkbox">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(next) => handleRowToggle(tool.id, next)}
                      ariaLabel={TOOLSET_CONFIG_STRINGS.TOOLS_SELECT_ROW_ARIA_LABEL_TEMPLATE.replace(
                        "{name}",
                        tool.name,
                      )}
                    />
                  </td>
                  <td className="toolset-config-dialog__td">
                    <Typography fontSize="fs14">{tool.name}</Typography>
                  </td>
                  <td className="toolset-config-dialog__td">
                    <Typography fontSize="fs14" color="var(--text-secondary)">
                      {tool.description}
                    </Typography>
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

type SortableHeaderProps = {
  label: string
  isSorted: boolean
  direction: SortDirection
  onSort: () => void
}

function SortableHeader({
  label,
  isSorted,
  direction,
  onSort,
}: SortableHeaderProps): ReactElement {
  const icon = !isSorted ? (
    <IconArrowsUpDown size={14} aria-hidden="true" />
  ) : direction === "asc" ? (
    <IconChevronUp size={14} aria-hidden="true" />
  ) : (
    <IconChevronDown size={14} aria-hidden="true" />
  )

  return (
    <th
      scope="col"
      className="toolset-config-dialog__th"
      aria-sort={isSorted ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="toolset-config-dialog__sort-button"
        onClick={onSort}
      >
        <span>{label}</span>
        {icon}
      </button>
    </th>
  )
}

export { ToolsSelectionTable }
