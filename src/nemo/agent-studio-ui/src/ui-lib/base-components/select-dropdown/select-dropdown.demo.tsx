import * as React from "react"
import {
  SelectDropdownRoot,
  SelectDropdown,
  SelectDropdownCollection,
  SelectDropdownContent,
  SelectDropdownEmpty,
  SelectDropdownGroup,
  SelectDropdownItem,
  SelectDropdownItemCell,
  SelectDropdownLabel,
  SelectDropdownList,
  SelectDropdownSeparator,
  SelectDropdownTrigger,
} from "./select-dropdown"
import "./select-dropdown.demo.scss"

// ---- Data ----------------------------------------------------------------

const frameworks = [
  { key: "nextjs", value: "nextjs", label: "Next.js" },
  { key: "sveltekit", value: "sveltekit", label: "SvelteKit" },
  { key: "nuxtjs", value: "nuxtjs", label: "Nuxt.js" },
  { key: "remix", value: "remix", label: "Remix" },
  { key: "astro", value: "astro", label: "Astro" },
]

const statuses = [
  { key: "active", value: "active", label: "Active", sublabel: "Visible to all users" },
  { key: "inactive", value: "inactive", label: "Inactive", sublabel: "Hidden from public view" },
  { key: "pending", value: "pending", label: "Pending", sublabel: "Awaiting review" },
  { key: "archived", value: "archived", label: "Archived", sublabel: "Moved to long-term storage" },
  { key: "draft", value: "draft", label: "Draft", sublabel: "Work in progress" },
  { key: "review", value: "review", label: "In Review", sublabel: "Under evaluation" },
  { key: "approved", value: "approved", label: "Approved", sublabel: "Ready to publish" },
  { key: "rejected", value: "rejected", label: "Rejected", sublabel: "Requires changes" },
  { key: "cancelled", value: "cancelled", label: "Cancelled", sublabel: "No longer applicable", isDisabled: true },
]

const timezones = [
  {
    region: "Americas",
    items: ["(GMT-5) New York", "(GMT-8) Los Angeles", "(GMT-6) Chicago"],
  },
  {
    region: "Europe",
    items: ["(GMT+0) London", "(GMT+1) Paris", "(GMT+1) Berlin"],
  },
  {
    region: "Asia/Pacific",
    items: ["(GMT+9) Tokyo", "(GMT+8) Shanghai", "(GMT+8) Singapore"],
  },
] as const

// ---- Item cell demo data -------------------------------------------------

const LONG_LABEL = "Option text this is a long string lorem ipsum dolor sit"
const LONG_SUBLABEL = "Subtitle this is a long string lorem ipsum dolor ist amet"

interface CellRowConfig {
  label: string
  sublabel?: string
  state?: "hover" | "selected" | "disabled"
  hasCheckbox?: boolean
  hasSeparatorBefore?: boolean
}

const CELL_ROWS: CellRowConfig[] = [
  { label: "Option text" },
  { label: "Option text", state: "hover" },
  { label: "Option text", state: "disabled" },
  { label: "Option text", state: "selected" },
  { label: LONG_LABEL, sublabel: LONG_SUBLABEL, hasSeparatorBefore: true },
  { label: "Option text", hasCheckbox: true, hasSeparatorBefore: true },
  { label: "Option text", hasCheckbox: true, state: "hover" },
  { label: "Option text", hasCheckbox: true, state: "selected" },
  { label: "Option text", hasCheckbox: true, state: "disabled" },
]

function CellRow({ row, isMultiline }: { row: CellRowConfig; isMultiline: boolean }): React.ReactElement {
  const dataAttrs: Record<string, string> = {}
  if (row.state === "hover") dataAttrs["data-highlighted"] = ""
  if (row.state === "selected") dataAttrs["data-selected"] = ""
  if (row.state === "disabled") dataAttrs["data-disabled"] = ""

  return (
    <div
      className={[
        "select-dropdown-item",
        row.hasCheckbox ? "select-dropdown-item--checkbox" : "",
        isMultiline ? "select-dropdown-item--multiline" : "",
      ].filter(Boolean).join(" ")}
      {...dataAttrs}
    >
      <SelectDropdownItemCell
        label={row.label}
        sublabel={isMultiline ? (row.sublabel ?? "Subtitle") : undefined}
        cellHasCheckbox={row.hasCheckbox ?? false}
        isCellMultiline={isMultiline}
        isDisabled={row.state === "disabled"}
      />
    </div>
  )
}

function ItemCellPanel({ title, isMultiline }: { title: string; isMultiline: boolean }): React.ReactElement {
  return (
    <div className="item-cell-demo__panel">
      <span className="item-cell-demo__panel-title">{title}</span>
      <div className="select-dropdown-content item-cell-demo__panel-content">
        {CELL_ROWS.map((row, i) => (
          <React.Fragment key={i}>
            {row.hasSeparatorBefore && <div className="select-dropdown-separator" />}
            <CellRow row={row} isMultiline={isMultiline} />
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

function ItemCellDemo(): React.ReactElement {
  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Item Cell</h2>
      <p className="select-dropdown-demo-description">
        All states — normal, hover, disabled, selected — single line (left) and multiline (right).
        Checkbox rows are separated below the divider.
      </p>
      <div className="item-cell-demo">
        <ItemCellPanel title="Single line" isMultiline={false} />
        <ItemCellPanel title="Multiline" isMultiline={true} />
      </div>
    </section>
  )
}

// ---- Demo sections -------------------------------------------------------

function BasicDemo(): React.ReactElement {
  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Basic</h2>
      <p className="select-dropdown-demo-description">
        Simple list. Right column shows a pre-selected value via <code>defaultValue</code>.
      </p>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <label>Uncontrolled</label>
          <SelectDropdown
            items={frameworks}
            placeholder="Select a framework…"
          />
        </div>
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <label>With default value</label>
          <SelectDropdown
            items={frameworks}
            defaultValue={frameworks[0].value}
            placeholder="Select a framework…"
          />
        </div>
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <label>With label + optional</label>
          <SelectDropdown
            items={frameworks}
            label="Framework"
            placeholder="Select a framework…"
            options={{ isOptional: true }}
          />
        </div>
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <label>Clearable</label>
          <SelectDropdown
            items={frameworks}
            defaultValue={frameworks[0].value}
            placeholder="Select a framework…"
            options={{ isClearable: true }}
          />
        </div>
      </div>
    </section>
  )
}

function SizesDemo(): React.ReactElement {
  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Sizes</h2>
      <p className="select-dropdown-demo-description">
        Three sizes — <code>small</code>, <code>medium</code> (default), and <code>large</code>.
      </p>
      <div className="select-dropdown-demo-row">
        {(["small", "medium", "large"] as const).map((size) => (
          <div key={size} className="select-dropdown-demo-field" style={{ width: "auto" }}>
            <label>{size}</label>
            <SelectDropdown
              size={size}
              placeholder={`${size}…`}
              items={statuses}
            />
          </div>
        ))}
      </div>
    </section>
  )
}

function GroupedDemo(): React.ReactElement {
  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Grouped with Separator</h2>
      <p className="select-dropdown-demo-description">
        Use <code>SelectDropdownGroup</code>, <code>SelectDropdownLabel</code>, and{" "}
        <code>SelectDropdownSeparator</code> for organised lists.
      </p>
      {/* Uses the primitive Root directly (not the wrapped SelectDropdown) because items here are grouped {region, items[]}[] — not SelectDropdownItemData[] */}
      <div className="select-dropdown-demo-wide">
        <SelectDropdownRoot items={timezones}>
          <SelectDropdownTrigger placeholder="Select a timezone…" />
          <SelectDropdownContent>
            <SelectDropdownEmpty>No timezones found.</SelectDropdownEmpty>
            <SelectDropdownList>
              {(group, index) => (
                <SelectDropdownGroup key={group.region} items={group.items}>
                  <SelectDropdownLabel>{group.region}</SelectDropdownLabel>
                  <SelectDropdownCollection>
                    {(item) => (
                      <SelectDropdownItem key={item} value={item}>
                        {item}
                      </SelectDropdownItem>
                    )}
                  </SelectDropdownCollection>
                  {index < timezones.length - 1 && <SelectDropdownSeparator />}
                </SelectDropdownGroup>
              )}
            </SelectDropdownList>
          </SelectDropdownContent>
        </SelectDropdownRoot>
      </div>
    </section>
  )
}

function ObjectItemsDemo(): React.ReactElement {
  const [value, setValue] = React.useState<string | null>(null)

  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Object Items</h2>
      <p className="select-dropdown-demo-description">
        Items are objects — the selected <code>value</code> field is tracked as controlled state.
      </p>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <SelectDropdown
            items={statuses}
            value={value}
            onValueChange={(v) => setValue(v as string | null)}
            placeholder="Select status…"
            options={{ isReadOnly: false }}
          />
        </div>
        {value && (
          <div className="select-dropdown-demo-field">
            <label>Selected value</label>
            <code style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
              {JSON.stringify(value)}
            </code>
          </div>
        )}
      </div>
    </section>
  )
}

function StatesDemo(): React.ReactElement {
  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">States</h2>
      <p className="select-dropdown-demo-description">
        Disabled, read-only, and error states for the Field variant.
      </p>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field">
          <label>Disabled</label>
          <SelectDropdown
            items={statuses}
            placeholder="Select status…"
            disabled
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Read-only</label>
          <SelectDropdown
            items={statuses}
            placeholder="Select status…"
            value={statuses[0].value}
            options={{ isReadOnly: true }}
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Error</label>
          <SelectDropdown
            items={statuses}
            placeholder="Select status…"
            error="This field is required."
          />
        </div>
      </div>
    </section>
  )
}

function FieldVariantDemo(): React.ReactElement {
  const [controlled, setControlled] = React.useState<string | null>(statuses[0].value)

  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Field — all states</h2>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field">
          <SelectDropdown
            items={statuses}
            tooltip="Tooltip text for this field"
            placeholder="Select status…"
            options={{ isClearable: true, isOptional: true, cellHasCheckbox: false, isCellMultiline: false }}
            value={controlled}
            onValueChange={(v) => setControlled(v as string | null)}
          />
        </div>
      </div>
    </section>
  )
}

function UnderlineVariantDemo(): React.ReactElement {
  const [value, setValue] = React.useState<string | null>(null)

  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Underline — all states</h2>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field">
          <label>Default</label>
          <SelectDropdown
            variant="underline"
            items={statuses}
            tooltip="Helpful info"
            placeholder="Select status…"
            value={value}
            onValueChange={(v) => setValue(v as string | null)}
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Error</label>
          <SelectDropdown
            variant="underline"
            items={statuses}
            placeholder="Select status…"
            error="Error message here."
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Disabled</label>
          <SelectDropdown
            variant="underline"
            items={statuses}
            placeholder="Select status…"
            disabled
          />
        </div>
      </div>
    </section>
  )
}

// ---- Searchable demo -------------------------------------------------------

function SearchableDemo(): React.ReactElement {
  const [items, setItems] = React.useState([
    { key: "apple", value: "apple", label: "Apple" },
    { key: "banana", value: "banana", label: "Banana" },
    { key: "cherry", value: "cherry", label: "Cherry" },
    { key: "mango", value: "mango", label: "Mango" },
    { key: "peach", value: "peach", label: "Peach" },
  ])

  function handleAddNew(value: string): void {
    const key = value.toLowerCase().replace(/\s+/g, "-")
    setItems((prev) => [...prev, { key, value: key, label: value }])
  }

  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Searchable</h2>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field">
          <label>Search only</label>
          <SelectDropdown
            items={items}
            placeholder="Pick a fruit…"
            options={{ isSearchable: true, isClearable: true, isMultiSelect: true, cellHasCheckbox: true }}
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Search + add new</label>
          <SelectDropdown
            items={items}
            placeholder="Pick or add a fruit…"
            options={{ isSearchable: true, isClearable: true, canAddNew: true }}
            onAddNew={handleAddNew}
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Searchbar disabled</label>
          <SelectDropdown
            items={items}
            placeholder="Pick or add a fruit…"
            options={{ isSearchable: true, isSearchbarDisabled: true, isClearable: true, canAddNew: true }}
            onAddNew={handleAddNew}
          />
        </div>
      </div>
    </section>
  )
}

// ---- Searchbar with Loading demo -------------------------------------------------------

function SearchbarWithLoadingDemo(): React.ReactElement {
  const [items] = React.useState([
    { key: "apple", value: "apple", label: "Apple" },
    { key: "banana", value: "banana", label: "Banana" },
    { key: "cherry", value: "cherry", label: "Cherry" },
  ])

  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Searchbar Loading</h2>
      <p className="select-dropdown-demo-description">
        Searchbar with <code>isSearchbarLoading: true</code> — shows a flashing dots loader instead of
        the add button.
      </p>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field">
          <label>Field variant</label>
          <SelectDropdown
            items={items}
            placeholder="Pick or add a fruit…"
            options={{ isSearchable: true, canAddNew: true, isSearchbarLoading: true }}
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Underline variant</label>
          <SelectDropdown
            variant="underline"
            items={items}
            placeholder="Pick or add a fruit…"
            options={{ isSearchable: true, canAddNew: true, isSearchbarLoading: true }}
          />
        </div>
      </div>

      <h2 className="select-dropdown-demo-title" style={{ marginTop: 24 }}>Dropdown Loading</h2>
      <p className="select-dropdown-demo-description">
        <code>isLoading: true</code> — disables opening and replaces the chevron with a flashing dots loader.
      </p>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field">
          <label>Field variant</label>
          <SelectDropdown
            items={items}
            placeholder="Pick a fruit…"
            isLoading={true}
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Underline variant</label>
          <SelectDropdown
            variant="underline"
            items={items}
            placeholder="Pick a fruit…"
            isLoading={true}
          />
        </div>
      </div>
    </section>
  )
}

// ---- Select All demo -------------------------------------------------------

interface SelectAllDemoItem {
  key: string
  value: string
  label: string
  sublabel?: string
  isDisabled?: boolean
}

function SelectAllDemo(): React.ReactElement {
  const [items, setItems] = React.useState<SelectAllDemoItem[]>([...statuses])
  const [withSelectAll, setWithSelectAll] = React.useState<string[]>([])
  const [withoutSelectAll, setWithoutSelectAll] = React.useState<string[]>([statuses[0].value])

  function handleAddNew(label: string): void {
    const key = label.toLowerCase().replace(/\s+/g, "-")
    setItems((prev) => [...prev, { key, value: key, label }])
  }

  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Select All</h2>
      <p className="select-dropdown-demo-description">
        Set <code>isMultiSelect: true</code> and <code>isSelectAllEnabled: true</code> to show a
        "Select All" row pinned above the list. Clicking it selects all non-disabled items; clicking
        again deselects all. Combined with <code>canAddNew: true</code> to add new items on the fly.
      </p>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <label>With Select All + Add</label>
          <SelectDropdown
            items={items}
            label="Statuses"
            value={withSelectAll}
            onValueChange={(v) => setWithSelectAll(v as string[])}
            onAddNew={handleAddNew}
            placeholder="Select statuses…"
            options={{
              isMultiSelect: true,
              isSelectAllEnabled: true,
              isSearchable: true,
              cellHasCheckbox: true,
              isClearable: true,
              canAddNew: true,
            }}
          />
          {withSelectAll.length > 0 && (
            <code style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
              {JSON.stringify(withSelectAll)}
            </code>
          )}
        </div>
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <label>Without Select All</label>
          <SelectDropdown
            items={items}
            label="Statuses"
            value={withoutSelectAll}
            onValueChange={(v) => setWithoutSelectAll(v as string[])}
            placeholder="Select statuses…"
            options={{
              isMultiSelect: true,
              isSearchable: true,
              cellHasCheckbox: true,
              isClearable: true,
            }}
          />
          {withoutSelectAll.length > 0 && (
            <code style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
              {JSON.stringify(withoutSelectAll)}
            </code>
          )}
        </div>
      </div>
    </section>
  )
}

function MultiSelectDemo(): React.ReactElement {
  const initialChipValues = [statuses[0].value, statuses[1].value, statuses[2].value]
  const [chipSelected, setChipSelected] = React.useState<string[]>(initialChipValues)
  const [textSelected, setTextSelected] = React.useState<string[]>([statuses[0].value])

  return (
    <section className="select-dropdown-demo-section">
      <h2 className="select-dropdown-demo-title">Multi Select — chip display</h2>
      <p className="select-dropdown-demo-description">
        Set <code>isChipDisplay: true</code> (requires <code>isMultiSelect: true</code> and the Field
        variant) to render selected items as removable chips. The chip list automatically collapses
        into a <code>+N</code> overflow badge when the trigger is too narrow to show all chips.
      </p>

      <p className="select-dropdown-demo-description" style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: 4 }}>
        <code>isChipDisplay: true</code>
      </p>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <label>Clearable</label>
          <SelectDropdown
            items={statuses}
            options={{ isMultiSelect: true, isChipDisplay: true, isClearable: true }}
            value={chipSelected}
            onValueChange={(v) => setChipSelected(v as string[])}
            placeholder="Select statuses…"
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Disabled</label>
          <SelectDropdown
            items={statuses}
            options={{ isMultiSelect: true, isChipDisplay: true }}
            value={chipSelected}
            onValueChange={(v) => setChipSelected(v as string[])}
            placeholder="Select statuses…"
            disabled
          />
        </div>
        <div className="select-dropdown-demo-field">
          <label>Read-only</label>
          <SelectDropdown
            items={statuses}
            options={{ isMultiSelect: true, isChipDisplay: true, isReadOnly: true }}
            value={chipSelected}
            onValueChange={(v) => setChipSelected(v as string[])}
            placeholder="Select statuses…"
          />
        </div>
      </div>

      <p className="select-dropdown-demo-description" style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: 16, marginBottom: 4 }}>
        <code>isChipDisplay: false</code> — count label fallback
      </p>
      <div className="select-dropdown-demo-row">
        <div className="select-dropdown-demo-field" style={{ width: "auto" }}>
          <SelectDropdown
            items={statuses}
            options={{ isMultiSelect: true, isChipDisplay: false }}
            value={textSelected}
            onValueChange={(v) => setTextSelected(v as string[])}
            placeholder="Select statuses…"
          />
        </div>
        {textSelected.length > 0 && (
          <div className="select-dropdown-demo-field">
            <label>Selected values</label>
            <code style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
              {JSON.stringify(textSelected)}
            </code>
          </div>
        )}
      </div>
    </section>
  )
}

// ---- Root export ---------------------------------------------------------

export default function SelectDropdownDemo(): React.ReactElement {
  return (
    <div className="select-dropdown-demo">
      <ItemCellDemo />
      <BasicDemo />
      <SizesDemo />
      <GroupedDemo />
      <ObjectItemsDemo />
      <StatesDemo />
      <FieldVariantDemo />
      <UnderlineVariantDemo />
      <SearchableDemo />
      <SearchbarWithLoadingDemo />
      <SelectAllDemo />
      <MultiSelectDemo />
    </div>
  )
}
