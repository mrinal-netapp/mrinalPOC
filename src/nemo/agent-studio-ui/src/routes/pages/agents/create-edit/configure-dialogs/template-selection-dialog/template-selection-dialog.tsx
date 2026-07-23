import { useMemo, useState, type MouseEvent, type ReactElement } from "react"
import {
  IconArrowsUpDown,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconChevronsLeft,
  IconChevronsRight,
  IconSearch,
  IconX,
} from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Input } from "@/ui-lib/base-components/input/input"
import { Typography } from "@/ui-lib/base-components/typography/typography"

import type { AgentTemplateDefinition } from "../../form/agent-templates.consts"

import { TEMPLATE_SELECTION_STRINGS } from "./template-selection-dialog.consts"
import {
  filterAndSortTemplates,
  nextTemplateSortState,
  visibleTemplateCatalog,
  type TemplateSortDirection,
  type TemplateSortKey,
} from "./template-selection-dialog.utils"

import "./template-selection-dialog.scss"

type TemplateSelectionDialogProps = {
  open: boolean
  /** Catalog of templates the user picks from. */
  templates: AgentTemplateDefinition[]
  /** Currently chosen template id (draft, before save). `null` means nothing picked. */
  selectedTemplateId: string | null
  onClose: () => void
  onSelectionChange: (id: string) => void
  onOpenDetails: (template: AgentTemplateDefinition, kind: TemplateDetailKind) => void
  onSave: () => void
}

type TemplateDetailKind = "examples" | "instructions"

type TemplateSelectionDialogContentProps = Omit<TemplateSelectionDialogProps, "open">

/**
 * Ephemeral search/sort UI state lives here so it resets when the dialog
 * closes (this subtree unmounts) without a synchronous setState in an effect.
 */
function TemplateSelectionDialogContent({
  templates,
  selectedTemplateId,
  onClose,
  onSelectionChange,
  onOpenDetails,
  onSave,
}: TemplateSelectionDialogContentProps): ReactElement {
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [sortKey, setSortKey] = useState<TemplateSortKey | null>(null)
  const [sortDirection, setSortDirection] = useState<TemplateSortDirection>("asc")

  const visibleTemplates = useMemo(
    () => filterAndSortTemplates(templates, search, sortKey, sortDirection),
    [templates, search, sortKey, sortDirection],
  )

  const total = useMemo(() => visibleTemplateCatalog(templates).length, [templates])
  const visibleTotal = visibleTemplates.length
  const sectionTitle = TEMPLATE_SELECTION_STRINGS.SECTION_TITLE_TEMPLATES.replace(
    "{count}",
    String(total),
  )
  const paginationLabel = TEMPLATE_SELECTION_STRINGS.PAGINATION_RANGE
    .replace("{start}", visibleTotal === 0 ? "0" : "1")
    .replace("{end}", String(visibleTotal))
    .replace("{total}", String(visibleTotal))

  const handleCancel = (): void => onClose()

  const handleSave = (): void => onSave()

  const handleOpenDetails = (
    event: MouseEvent<HTMLButtonElement>,
    template: AgentTemplateDefinition,
    kind: TemplateDetailKind,
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    onOpenDetails(template, kind)
  }

  const handleSort = (key: TemplateSortKey): void => {
    const next = nextTemplateSortState(sortKey, sortDirection, key)
    setSortKey(next.sortKey)
    setSortDirection(next.sortDirection)
  }

  const closeSearch = (): void => {
    setSearch("")
    setIsSearchOpen(false)
  }

  return (
    <Card className="template-selection-dialog">
      <CardHeader title={TEMPLATE_SELECTION_STRINGS.DIALOG_TITLE} hasSeparator />

      <CardContent>
        <div className="template-selection-dialog__content">
          <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
            {TEMPLATE_SELECTION_STRINGS.DIALOG_DESCRIPTION}
          </Typography>

          <div className="template-selection-dialog__toolbar">
            <Typography Component="h3" fontSize="fs14" boldness="semibold">
              {sectionTitle}
            </Typography>
            <div className="template-selection-dialog__toolbar-actions">
              {isSearchOpen ? (
                <div className="template-selection-dialog__search">
                  <Input
                    value={search}
                    placeholder={TEMPLATE_SELECTION_STRINGS.SEARCH_PLACEHOLDER}
                    aria-label={TEMPLATE_SELECTION_STRINGS.SEARCH_ARIA_LABEL}
                    onChange={(event) => setSearch(event.target.value)}
                    autoFocus
                  />
                  <Button
                    type="button"
                    variant="icon"
                    size="small"
                    icon={<IconX size={16} />}
                    aria-label={TEMPLATE_SELECTION_STRINGS.CLOSE_SEARCH_ARIA_LABEL}
                    onClick={closeSearch}
                  />
                </div>
              ) : (
                <Button
                  type="button"
                  variant="icon"
                  icon={<IconSearch size={16} />}
                  aria-label={TEMPLATE_SELECTION_STRINGS.SEARCH_ARIA_LABEL}
                  onClick={() => setIsSearchOpen(true)}
                />
              )}
            </div>
          </div>

          <div className="template-selection-dialog__table-wrapper">
            <table className="template-selection-dialog__table">
              <thead>
                <tr>
                  <th className="template-selection-dialog__th template-selection-dialog__th--radio" aria-hidden />
                  <SortableHeader
                    label={TEMPLATE_SELECTION_STRINGS.COLUMN_NAME}
                    sortKey="name"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label={TEMPLATE_SELECTION_STRINGS.COLUMN_DESCRIPTION}
                    sortKey="description"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label={TEMPLATE_SELECTION_STRINGS.COLUMN_CAPABILITIES}
                    sortKey="capabilities"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label={TEMPLATE_SELECTION_STRINGS.COLUMN_EXAMPLES}
                    sortKey="examples"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label={TEMPLATE_SELECTION_STRINGS.COLUMN_INSTRUCTIONS}
                    sortKey="instructions"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    hasDivider={false}
                  />
                </tr>
              </thead>
              <tbody>
                {visibleTemplates.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="template-selection-dialog__empty-cell">
                      <Typography fontSize="fs14" color="var(--text-secondary)">
                        {search.trim()
                          ? TEMPLATE_SELECTION_STRINGS.NO_MATCH_MESSAGE
                          : TEMPLATE_SELECTION_STRINGS.EMPTY_CATALOG_MESSAGE}
                      </Typography>
                    </td>
                  </tr>
                ) : (
                  visibleTemplates.map((tmpl) => {
                    const isSelected = selectedTemplateId === tmpl.id
                    const radioAriaLabel = TEMPLATE_SELECTION_STRINGS.RADIO_ARIA_LABEL.replace(
                      "{name}",
                      tmpl.name,
                    )
                    return (
                      <tr
                        key={tmpl.id}
                        className={
                          isSelected
                            ? "template-selection-dialog__row template-selection-dialog__row--selected"
                            : "template-selection-dialog__row"
                        }
                        onClick={() => onSelectionChange(tmpl.id)}
                      >
                        <td className="template-selection-dialog__td template-selection-dialog__td--radio">
                          <input
                            type="radio"
                            name="template-selection"
                            value={tmpl.id}
                            checked={isSelected}
                            onChange={() => onSelectionChange(tmpl.id)}
                            aria-label={radioAriaLabel}
                            className="template-selection-dialog__radio"
                          />
                        </td>
                        <td className="template-selection-dialog__td">
                          <Typography fontSize="fs14">{tmpl.name}</Typography>
                        </td>
                        <td className="template-selection-dialog__td">
                          <Typography
                            fontSize="fs14"
                            color="var(--text-secondary)"
                            className="template-selection-dialog__truncate"
                          >
                            {tmpl.description}
                          </Typography>
                        </td>
                        <td className="template-selection-dialog__td">
                          <Typography fontSize="fs14">
                            {tmpl.capabilities.join(", ")}
                          </Typography>
                        </td>
                        <td className="template-selection-dialog__td">
                          <button
                            type="button"
                            className="template-selection-dialog__details-link"
                            onClick={(event) => handleOpenDetails(event, tmpl, "examples")}
                          >
                            {TEMPLATE_SELECTION_STRINGS.EXAMPLES_VIEW_LABEL}
                          </button>
                        </td>
                        <td className="template-selection-dialog__td">
                          <button
                            type="button"
                            className="template-selection-dialog__details-link"
                            onClick={(event) =>
                              handleOpenDetails(event, tmpl, "instructions")
                            }
                          >
                            {TEMPLATE_SELECTION_STRINGS.INSTRUCTIONS_VIEW_LABEL}
                          </button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>

            <div className="template-selection-dialog__pagination">
              <Typography fontSize="fs13" color="var(--text-secondary)">
                {paginationLabel}
              </Typography>
              <div className="template-selection-dialog__pagination-controls">
                <Button
                  type="button"
                  variant="icon"
                  icon={<IconChevronsLeft size={16} />}
                  isDisabled
                  aria-label={TEMPLATE_SELECTION_STRINGS.PAGE_FIRST_ARIA_LABEL}
                />
                <Button
                  type="button"
                  variant="icon"
                  icon={<IconChevronLeft size={16} />}
                  isDisabled
                  aria-label={TEMPLATE_SELECTION_STRINGS.PAGE_PREV_ARIA_LABEL}
                />
                <Typography fontSize="fs13" boldness="semibold">
                  1
                </Typography>
                <Button
                  type="button"
                  variant="icon"
                  icon={<IconChevronRight size={16} />}
                  isDisabled
                  aria-label={TEMPLATE_SELECTION_STRINGS.PAGE_NEXT_ARIA_LABEL}
                />
                <Button
                  type="button"
                  variant="icon"
                  icon={<IconChevronsRight size={16} />}
                  isDisabled
                  aria-label={TEMPLATE_SELECTION_STRINGS.PAGE_LAST_ARIA_LABEL}
                />
              </div>
            </div>
          </div>
        </div>
      </CardContent>

      <CardFooter
        hasSeparator
        alignment="end"
        actions={[
          {
            variant: "solid",
            label: TEMPLATE_SELECTION_STRINGS.SELECT_ACTION_LABEL,
            onClick: handleSave,
            isDisabled: !selectedTemplateId,
          },
          {
            variant: "outline",
            label: TEMPLATE_SELECTION_STRINGS.CLOSE_ACTION_LABEL,
            onClick: handleCancel,
          },
        ]}
      />
    </Card>
  )
}

/**
 * Single-select dialog that lets the user pick one of the available agent
 * creation templates. The dialog is purely presentational over a draft id;
 * persisting the choice into the form happens in `onSave`.
 */
function TemplateSelectionDialog({
  open,
  templates,
  selectedTemplateId,
  onClose,
  onSelectionChange,
  onOpenDetails,
  onSave,
}: TemplateSelectionDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      size="lg"
    >
      {open ? (
        <DialogPopup showCloseButton={false}>
          <TemplateSelectionDialogContent
            templates={templates}
            selectedTemplateId={selectedTemplateId}
            onClose={onClose}
            onSelectionChange={onSelectionChange}
            onOpenDetails={onOpenDetails}
            onSave={onSave}
          />
        </DialogPopup>
      ) : null}
    </Dialog>
  )
}

type SortableHeaderProps = {
  label: string
  sortKey: TemplateSortKey
  activeSortKey: TemplateSortKey | null
  sortDirection: TemplateSortDirection
  onSort: (key: TemplateSortKey) => void
  hasDivider?: boolean
}

function SortableHeader({
  label,
  sortKey,
  activeSortKey,
  sortDirection,
  onSort,
  hasDivider = true,
}: SortableHeaderProps): ReactElement {
  const isSorted = activeSortKey === sortKey
  const icon = !isSorted ? (
    <IconArrowsUpDown size={14} aria-hidden="true" />
  ) : sortDirection === "asc" ? (
    <IconChevronUp size={14} aria-hidden="true" />
  ) : (
    <IconChevronDown size={14} aria-hidden="true" />
  )
  return (
    <th
      scope="col"
      className={
        hasDivider
          ? "template-selection-dialog__th template-selection-dialog__th--with-divider"
          : "template-selection-dialog__th"
      }
      aria-sort={isSorted ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="template-selection-dialog__sort-button"
        onClick={() => onSort(sortKey)}
        aria-label={`${label}, ${TEMPLATE_SELECTION_STRINGS.SORT_ARIA_LABEL}`}
      >
        <span>{label}</span>
        <span className="template-selection-dialog__sort-icon">{icon}</span>
      </button>
    </th>
  )
}

export { TemplateSelectionDialog }
export type { TemplateSelectionDialogProps }
