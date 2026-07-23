import { useState, type ReactElement } from "react"

import { Input } from "@/ui-lib/base-components/input/input"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import type { SelectDropdownItemData, SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import { ADD_TOOL_STRINGS } from "../add-tool.consts"
import "./custom-tab-content.scss"

type CustomTabContentProps = {
  name: string
  description: string
  labelItems: SelectDropdownItemData[]
  selectedLabels: string[]
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onLabelChange: (value: SelectDropdownValue) => void
  onAddLabel: (value: string) => void
  isNameDisabled?: boolean
  showValidation?: boolean
}

function CustomTabContent({
  name,
  description,
  labelItems,
  selectedLabels,
  onNameChange,
  onDescriptionChange,
  onLabelChange,
  onAddLabel,
  isNameDisabled = false,
  showValidation = false,
}: CustomTabContentProps): ReactElement {
  const [nameBlurred, setNameBlurred] = useState(false)

  const nameError = !name.trim() ? "Name is required" : undefined
  const showNameError = nameError && (nameBlurred || showValidation)

  return (
    <div className="custom-config__form">
      <div>
        <Input
          label={ADD_TOOL_STRINGS.NAME_LABEL}
          placeholder={ADD_TOOL_STRINGS.NAME_PLACEHOLDER}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onBlur={() => setNameBlurred(true)}
          isDisabled={isNameDisabled}
          isError={!!showNameError}
        />
        {showNameError && <FormFieldErrorBlock message={nameError} />}
      </div>
      <Input
        label={ADD_TOOL_STRINGS.DESCRIPTION_LABEL}
        placeholder={ADD_TOOL_STRINGS.DESCRIPTION_PLACEHOLDER}
        isOptional
        value={description}
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
    </div>
  )
}

export { CustomTabContent }
export type { CustomTabContentProps }
