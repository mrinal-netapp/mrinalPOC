import { useCallback, useMemo, useState, type ReactElement } from "react"

import BaseTable from "@/ui-lib/base-components/baseTableMcpBxp/baseTable"
import { Input } from "@/ui-lib/base-components/input/input"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import type { SelectDropdownItemData, SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import type { CatalogFormState, CatalogTemplateId, CatalogTemplateRow } from "./catalog.types"
import { ADD_TOOL_STRINGS } from "../add-tool.consts"
import { CATALOG_TEMPLATES } from "./catalog.consts"
import { createCatalogTemplateColumns, getRadioSelectColumn } from "./catalog-template-table.columns"

import "./catalog.scss"

type CatalogTabContentProps = {
  formState: CatalogFormState
  labelItems: SelectDropdownItemData[]
  selectedLabels: string[]
  onSelectTemplate: (templateId: CatalogTemplateId) => void
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onLabelChange: (value: SelectDropdownValue) => void
  onAddLabel: (value: string) => void
  showValidation?: boolean
}

const catalogTableRows: CatalogTemplateRow[] = CATALOG_TEMPLATES.map((t) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  locationType: t.locationType,
  tools: t.tools,
}))

const catalogTableOptions = {
  enableColumnSorting: true,
  enablePagination: true,
  enableStickyHeaders: true,
  enableTableTopBar: true,
  topBarOptions: {
    rowCountLabel: "Tools",
    showSearch: true,
  },
} as const

function CatalogTabContent({
  formState,
  labelItems,
  selectedLabels,
  onSelectTemplate,
  onNameChange,
  onDescriptionChange,
  onLabelChange,
  onAddLabel,
  showValidation = false,
}: CatalogTabContentProps): ReactElement {
  const [nameBlurred, setNameBlurred] = useState(false)

  const columns = useMemo(
    () => [getRadioSelectColumn(), ...createCatalogTemplateColumns()],
    [],
  )

  const handleRadioChange = useCallback(
    (value: string | string[]): void => {
      const templateId = (Array.isArray(value) ? value[0] : value) as CatalogTemplateId
      if (templateId) onSelectTemplate(templateId)
    },
    [onSelectTemplate],
  )

  const nameError = formState.selectedTemplateId && !formState.catalogName.trim() ? "Name is required" : undefined
  const showNameError = nameError && (nameBlurred || showValidation)

  return (
    <div className="catalog-config__form">
      <RadioGroup
        value={formState.selectedTemplateId ?? ""}
        onValueChange={handleRadioChange}
        ariaLabel="Template selection"
      >
        <BaseTable<CatalogTemplateRow>
          data={catalogTableRows}
          columns={columns}
          isLoading={false}
          isError={false}
          options={catalogTableOptions}
        />
      </RadioGroup>

      {formState.selectedTemplateId && (
        <>
          <div>
            <Input
              label={ADD_TOOL_STRINGS.NAME_LABEL}
              value={formState.catalogName}
              onChange={(e) => onNameChange(e.target.value)}
              onBlur={() => setNameBlurred(true)}
              isError={!!showNameError}
            />
            {showNameError && <FormFieldErrorBlock message={nameError} />}
          </div>
          <Input
            label={ADD_TOOL_STRINGS.DESCRIPTION_LABEL}
            isOptional
            value={formState.catalogDescription}
            onChange={(e) => onDescriptionChange(e.target.value)}
          />
          <SelectDropdown
            label={ADD_TOOL_STRINGS.LABELS_LABEL}
            tooltip={ADD_TOOL_STRINGS.LABELS_TOOLTIP}
            placeholder={ADD_TOOL_STRINGS.LABELS_PLACEHOLDER}
            items={labelItems}
            value={selectedLabels}
            onValueChange={onLabelChange}
            onAddNew={onAddLabel}
            options={{ isMultiSelect: true, isChipDisplay: true, isSearchable: true, canAddNew: true, isClearable: true, isOptional: true }}
          />
        </>
      )}
    </div>
  )
}

export { CatalogTabContent }
export type { CatalogTabContentProps }
