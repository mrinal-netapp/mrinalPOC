# `components/common` — Shared "Add X" template

Building blocks for any "Add Tool / Add Model / Add Agent / Add Knowledge Base"
dialog. **This folder is the public surface; everything in here is meant to be
imported and composed by feature-level modals.**

> **File ownership.** Feature-level modals (e.g. `modals/add-tool/`,
> `routes/.../add-tool-page.tsx`) own their feature-specific cards and
> orchestration. They must **not** edit anything under `components/common/`.
> If you need a change to a shared piece, open a PR that touches
> `components/common/` only.

## Public API

```ts
import { AddEntityForm }
  from "@/components/common/add-entity-form/add-entity-form"
import { TabDetailCard }
  from "@/components/common/tab-detail-card/tab-detail-card"
```

### `AddEntityForm`

Outer dialog shell + form layout. Renders a fixed top header (title + close X),
an optional entity heading block, an ordered list of consumer-supplied section
nodes inside a `<Card>`, and a fixed footer (Add / Cancel). The component is
the public surface for every "Add X" page in this product — there is no
higher-level wrapper.

```ts
type AddEntityFormProps = {
  open: boolean
  title: string                 // top-bar title, e.g. "Add model"
  entityName?: string           // optional inline heading above the card
  entityDescription?: string    // rendered only when entityName is provided
  addLabel?: string             // default: "Add"
  cancelLabel?: string          // default: "Cancel"
  closeAriaLabel?: string       // default: "Close dialog"
  onAdd: () => void
  onCancel: () => void
  sections?: ReactNode[]        // null / undefined entries are dropped
}
```

Layout & spacing the template handles for free (no consumer CSS required):
- Outer `<Card>` wraps every section.
- Each section becomes a `<CardBlock>`, with a 1px inset separator drawn
  between consecutive sections.
- Section content is constrained to the design-system 616px field column
  (matches the dataset/KB form spec). Inputs, info rows, and section text
  share a consistent right edge.
- Footer renders `Add` first, then `Cancel`, centered (design-system spec
  for entity-creation flows).

Accessibility (A11Y-004):
- Focus trap inside the panel while open.
- Focus restores to the trigger element on close.
- **Escape** dismisses the dialog (delegates to `onCancel`).
- The panel covers the full `app-main-content` area; users dismiss via the
  close X, Cancel, or Escape.

### `TabDetailCard`

Card with a tab strip and an ordered list of panels keyed by `tabId`. Use for
"Details" cards that group fields into tabs.

```ts
type TabDetailCardProps = {
  title: string
  subtitle?: string                                // optional — matches CardHeaderProps.subtitle
  tabs: TabItem[]                                  // from ui-lib/tab/tab
  activeTabId?: string                             // controlled mode
  onTabChange?: (tabId: string) => void
  variant?: VariantProps<typeof tabVariants>["variant"]
  ariaLabel: string
  cardClassName?: string
  panels: Array<{
    tabId: string
    content: ReactNode
    panelClassName?: string
  }>
}
```

## How to build an "Add X" modal

1. Create the feature folder for your modal (e.g. `modals/add-<x>/add-<x>-modal.tsx`).
2. Define feature-specific section components (e.g. `details-section.tsx`,
   `<provider>-config-section.tsx`) inside the feature folder's `components/`.
   Each section renders its *content* (heading + fields), **not** a `<Card>`.
3. Render `<AddEntityForm>` and pass your section components via `sections={...}`.
   `AddEntityForm` wraps each entry in a `<CardBlock>` inside an outer `<Card>`,
   so passing a `<Card>` (or anything that renders its own `<Card>`, e.g.
   `<TabDetailCard>`) directly as a section produces nested cards with stacked
   padding and double borders — avoid that composition.
4. **Do not edit `components/common/`.** Open a PR against this folder if you
   need a new prop, status, or layout option.

See `add-entity-form/add-entity-form.example.tsx` for end-to-end compositions
(`BasicAddEntity`, `AddToolMultiSection`, `ClosedAddEntity`).

## Cursor rules

This folder targets the React UI Standards at the repo root, **excluding the
`I18-*` rules** until the i18n bundle is wired up. Default user-visible
strings are marked with `// TODO(i18n)` for later translation.

## Test coverage

Coverage threshold for this folder is **100%**. Run:

```bash
npx vitest run --coverage src/components/common
```
