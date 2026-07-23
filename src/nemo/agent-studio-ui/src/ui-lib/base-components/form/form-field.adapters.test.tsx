import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"

import { renderWithProviders, useTestForm, userEvent } from "@test/render"

import { Form } from "./form"
import { InputField } from "./form-field.input"
import { CheckboxField } from "./form-field.checkbox"
import { ToggleField } from "./form-field.toggle"
import { RadioGroupField } from "./form-field.radio-group"
import { SelectDropdownField } from "./form-field.select-dropdown"
import { SelectorWrapperField } from "./form-field.selector-wrapper"
import { SliderField } from "./form-field.slider"

// =====================================================
// InputField
// =====================================================

describe("InputField", () => {
  // -- 1.1
  it("[tag:form-field][tag:input-field][tag:input][tag:rendering] renders an input element", () => {
    function W(): ReactElement {
      const form = useTestForm({ name: "" })
      return (
        <Form form={form}>
          <InputField form={form} name="name" label="Name" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  // -- 1.2
  it("[tag:form-field][tag:input-field][tag:input][tag:value] shows the form default value", () => {
    function W(): ReactElement {
      const form = useTestForm({ name: "Alice" })
      return (
        <Form form={form}>
          <InputField form={form} name="name" label="Name" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("textbox")).toHaveValue("Alice")
  })

  // -- 1.3
  it("[tag:form-field][tag:input-field][tag:input][tag:change] typing updates the input value", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ name: "" })
      return (
        <Form form={form}>
          <InputField form={form} name="name" label="Name" />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.type(screen.getByRole("textbox"), "hello")
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("hello"))
  })

  // -- 1.4
  it("[tag:form-field][tag:input-field][tag:input][tag:validation] shows error when invalid and touched", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ name: "" })
      return (
        <Form form={form}>
          <InputField
            form={form}
            name="name"
            label="Name"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onBlur: ({ value }: { value: string }) => (!value ? "Name is required" : undefined) } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByRole("textbox"))
    await user.tab()

    await waitFor(() => expect(screen.getByText("Name is required")).toBeInTheDocument())
  })

  // -- 1.5
  it("[tag:form-field][tag:input-field][tag:input][tag:isDisabled] form-level isDisabled disables the input", () => {
    function W(): ReactElement {
      const form = useTestForm({ name: "" })
      return (
        <Form form={form} isDisabled>
          <InputField form={form} name="name" label="Name" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("textbox")).toBeDisabled()
  })

  // -- 1.6
  it("[tag:form-field][tag:input-field][tag:input][tag:isDisabled] field-level isDisabled overrides form-level", () => {
    function W(): ReactElement {
      const form = useTestForm({ name: "" })
      return (
        <Form form={form}>
          <InputField form={form} name="name" label="Name" isDisabled />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("textbox")).toBeDisabled()
  })

  // -- 1.7
  it("[tag:form-field][tag:input-field][tag:input][tag:keyboard] Enter moves focus to the next input", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ first: "", second: "" })
      return (
        <Form form={form}>
          <InputField form={form} name="first" label="First" />
          <InputField form={form} name="second" label="Second" />
        </Form>
      )
    }
    renderWithProviders(<W />)

    const inputs = screen.getAllByRole("textbox")
    await user.click(inputs[0])
    await user.keyboard("{Enter}")

    await waitFor(() => expect(inputs[1]).toHaveFocus())
  })

  // -- 1.8
  it("[tag:form-field][tag:input-field][tag:input][tag:keyboard] Enter calls custom onKeyDown handler", async () => {
    const spy = vi.fn()
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ name: "" })
      return (
        <Form form={form}>
          <InputField form={form} name="name" label="Name" onKeyDown={spy} />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByRole("textbox"))
    await user.keyboard("{Enter}")

    await waitFor(() => expect(spy).toHaveBeenCalledOnce())
  })

  // -- 1.9
  it("[tag:form-field][tag:input-field][tag:input][tag:keyboard] Enter without a parent <form> does not throw", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ name: "" })
      return (
        <InputField form={form} name="name" label="Name" />
      )
    }
    renderWithProviders(<W />)

    const input = screen.getByRole("textbox")
    await user.click(input)
    await user.keyboard("{Enter}")

    expect(input).toBeInTheDocument()
  })
})

// =====================================================
// CheckboxField
// =====================================================

describe("CheckboxField", () => {
  // -- 2.1
  it("[tag:form-field][tag:checkbox-field][tag:checkbox][tag:selectorWrapper][tag:rendering] renders a checkbox", () => {
    function W(): ReactElement {
      const form = useTestForm({ agree: false })
      return (
        <Form form={form}>
          <CheckboxField form={form} name="agree" label="I agree" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("checkbox")).toBeInTheDocument()
  })

  // -- 2.2
  it("[tag:form-field][tag:checkbox-field][tag:checkbox][tag:selectorWrapper][tag:value] reflects checked state from form defaults", () => {
    function W(): ReactElement {
      const form = useTestForm({ agree: true })
      return (
        <Form form={form}>
          <CheckboxField form={form} name="agree" label="I agree" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("checkbox")).toHaveAttribute("data-checked", "")
  })

  // -- 2.3
  it("[tag:form-field][tag:checkbox-field][tag:checkbox][tag:selectorWrapper][tag:change] clicking toggles the checkbox", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ agree: false })
      return (
        <Form form={form}>
          <CheckboxField form={form} name="agree" label="I agree" />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveAttribute("data-checked", ""))
  })

  // -- 2.4
  it("[tag:form-field][tag:checkbox-field][tag:checkbox][tag:selectorWrapper][tag:onCheckedChange] fires callback on toggle", async () => {
    const spy = vi.fn()
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ agree: false })
      return (
        <Form form={form}>
          <CheckboxField form={form} name="agree" label="I agree" onCheckedChange={spy} />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(spy).toHaveBeenCalledOnce())
  })

  // -- 2.5
  it("[tag:form-field][tag:checkbox-field][tag:checkbox][tag:selectorWrapper][tag:isDisabled] form-level isDisabled disables the checkbox", () => {
    function W(): ReactElement {
      const form = useTestForm({ agree: false })
      return (
        <Form form={form} isDisabled>
          <CheckboxField form={form} name="agree" label="I agree" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("checkbox")).toHaveAttribute("data-disabled", "")
  })

  // -- 2.6
  it("[tag:form-field][tag:checkbox-field][tag:checkbox][tag:selectorWrapper][tag:isDisabled] field-level isDisabled overrides form-level", () => {
    function W(): ReactElement {
      const form = useTestForm({ agree: false })
      return (
        <Form form={form}>
          <CheckboxField form={form} name="agree" label="I agree" isDisabled />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("checkbox")).toHaveAttribute("data-disabled", "")
  })
})

// =====================================================
// ToggleField
// =====================================================

describe("ToggleField", () => {
  // -- 3.1
  it("[tag:form-field][tag:toggle-field][tag:toggle][tag:selectorWrapper][tag:rendering] renders a switch element", () => {
    function W(): ReactElement {
      const form = useTestForm({ on: false })
      return (
        <Form form={form}>
          <ToggleField form={form} name="on" label="Enable" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("switch")).toBeInTheDocument()
  })

  // -- 3.2
  it("[tag:form-field][tag:toggle-field][tag:toggle][tag:selectorWrapper][tag:change] clicking toggles the switch", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ on: false })
      return (
        <Form form={form}>
          <ToggleField form={form} name="on" label="Enable" />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByRole("switch"))
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("data-checked", ""))
  })

  // -- 3.3
  it("[tag:form-field][tag:toggle-field][tag:toggle][tag:selectorWrapper][tag:onCheckedChange] fires callback on toggle", async () => {
    const spy = vi.fn()
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ on: false })
      return (
        <Form form={form}>
          <ToggleField form={form} name="on" label="Enable" onCheckedChange={spy} />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByRole("switch"))
    await waitFor(() => expect(spy).toHaveBeenCalledOnce())
  })

  // -- 3.4
  it("[tag:form-field][tag:toggle-field][tag:toggle][tag:selectorWrapper][tag:isDisabled] form-level isDisabled disables the switch", () => {
    function W(): ReactElement {
      const form = useTestForm({ on: false })
      return (
        <Form form={form} isDisabled>
          <ToggleField form={form} name="on" label="Enable" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("switch")).toHaveAttribute("data-disabled", "")
  })
})

// =====================================================
// RadioGroupField
// =====================================================

describe("RadioGroupField", () => {
  const options = [
    { value: "a", label: "Option A" },
    { value: "b", label: "Option B" },
    { value: "c", label: "Option C" },
  ]

  // -- 4.1
  it("[tag:form-field][tag:radio-group-field][tag:radioButton][tag:selectorWrapper][tag:rendering] renders radio buttons for each option", () => {
    function W(): ReactElement {
      const form = useTestForm({ choice: "" })
      return (
        <Form form={form}>
          <RadioGroupField form={form} name="choice" label="Choose" options={options} />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getAllByRole("radio")).toHaveLength(3)
  })

  // -- 4.2
  it("[tag:form-field][tag:radio-group-field][tag:radioButton][tag:selectorWrapper][tag:value] reflects the default selected value", () => {
    function W(): ReactElement {
      const form = useTestForm({ choice: "b" })
      return (
        <Form form={form}>
          <RadioGroupField form={form} name="choice" label="Choose" options={options} />
        </Form>
      )
    }
    renderWithProviders(<W />)
    const radios = screen.getAllByRole("radio")
    expect(radios[1]).toHaveAttribute("data-checked", "")
  })

  // -- 4.3
  it("[tag:form-field][tag:radio-group-field][tag:radioButton][tag:selectorWrapper][tag:change] clicking an option selects it", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ choice: "" })
      return (
        <Form form={form}>
          <RadioGroupField form={form} name="choice" label="Choose" options={options} />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByText("Option A"))
    await waitFor(() => expect(screen.getAllByRole("radio")[0]).toHaveAttribute("data-checked", ""))
  })

  // -- 4.4
  it("[tag:form-field][tag:radio-group-field][tag:radioButton][tag:selectorWrapper][tag:multi-select] multi-select mode when max > 1", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ choices: [] as string[] })
      return (
        <Form form={form}>
          <RadioGroupField form={form} name="choices" label="Choose" options={options} max={3} />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByText("Option A"))
    await user.click(screen.getByText("Option B"))

    await waitFor(() => {
      const radios = screen.getAllByRole("radio")
      expect(radios[0]).toHaveAttribute("data-checked", "")
      expect(radios[1]).toHaveAttribute("data-checked", "")
    })
  })

  // -- 4.5
  it("[tag:form-field][tag:radio-group-field][tag:radioButton][tag:selectorWrapper][tag:isReadOnly] isReadOnly prevents value changes on click", () => {
    function W(): ReactElement {
      const form = useTestForm({ choice: "a" })
      return (
        <Form form={form} isReadOnly>
          <RadioGroupField form={form} name="choice" label="Choose" options={options} />
        </Form>
      )
    }
    renderWithProviders(<W />)

    // CSS pointer-events:none blocks userEvent; use fireEvent to test JS handler
    fireEvent.click(screen.getAllByRole("radio")[1])

    const radios = screen.getAllByRole("radio")
    expect(radios[0]).toHaveAttribute("data-checked", "")
    expect(radios[1]).not.toHaveAttribute("data-checked")
  })

  // -- 4.6a
  it("[tag:form-field][tag:radio-group-field][tag:radioButton][tag:a11y] radiogroup is labelled by the FormField label via aria-labelledby", () => {
    function W(): ReactElement {
      const form = useTestForm({ choice: "" })
      return (
        <Form form={form}>
          <RadioGroupField form={form} name="choice" label="Choose" options={options} />
        </Form>
      )
    }
    renderWithProviders(<W />)

    const label = screen.getByText("Choose").closest("label")
    const labelId = label?.getAttribute("id")
    expect(labelId).toBeTruthy()

    const group = screen.getByRole("radiogroup")
    expect(group).toHaveAttribute("aria-labelledby", labelId)
  })

  // -- 4.6
  it("[tag:form-field][tag:radio-group-field][tag:radioButton][tag:selectorWrapper][tag:isDisabled] form-level isDisabled disables radio buttons", () => {
    function W(): ReactElement {
      const form = useTestForm({ choice: "" })
      return (
        <Form form={form} isDisabled>
          <RadioGroupField form={form} name="choice" label="Choose" options={options} />
        </Form>
      )
    }
    renderWithProviders(<W />)
    const radios = screen.getAllByRole("radio")
    radios.forEach((radio) => expect(radio).toHaveAttribute("data-disabled", ""))
  })
})

// =====================================================
// SelectorWrapperField
// =====================================================

describe("SelectorWrapperField", () => {
  // -- 5.1
  it("[tag:form-field][tag:selector-wrapper-field][tag:selectorWrapper][tag:rendering] renders based on selectorType", () => {
    function W(): ReactElement {
      const form = useTestForm({ check: false })
      return (
        <Form form={form}>
          <SelectorWrapperField form={form} name="check" selectorType="checkbox" label="Check" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("checkbox")).toBeInTheDocument()
  })

  // -- 5.2
  it("[tag:form-field][tag:selector-wrapper-field][tag:selectorWrapper][tag:value] clicking updates form state", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ check: false })
      return (
        <Form form={form}>
          <SelectorWrapperField form={form} name="check" selectorType="checkbox" label="Check" />
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveAttribute("data-checked", ""))
  })

  // -- 5.3
  it("[tag:form-field][tag:selector-wrapper-field][tag:selectorWrapper][tag:a11y] has aria-describedby when a message is rendered", () => {
    function W(): ReactElement {
      const form = useTestForm({ check: false })
      return (
        <Form form={form}>
          <SelectorWrapperField form={form} name="check" selectorType="checkbox" label="Check" warning="Heads up" />
        </Form>
      )
    }
    const { container } = renderWithProviders(<W />)
    const wrapper = container.querySelector(".selector-wrapper")
    expect(wrapper).toHaveAttribute("aria-describedby")
  })

  // -- 5.3b
  it("[tag:form-field][tag:selector-wrapper-field][tag:selectorWrapper][tag:a11y] omits aria-describedby when no message is rendered", () => {
    function W(): ReactElement {
      const form = useTestForm({ check: false })
      return (
        <Form form={form}>
          <SelectorWrapperField form={form} name="check" selectorType="checkbox" label="Check" />
        </Form>
      )
    }
    const { container } = renderWithProviders(<W />)
    const wrapper = container.querySelector(".selector-wrapper")
    expect(wrapper).not.toHaveAttribute("aria-describedby")
  })

  // -- 5.4
  it("[tag:form-field][tag:selector-wrapper-field][tag:selectorWrapper][tag:isReadOnly] isReadOnly prevents checked changes", () => {
    function W(): ReactElement {
      const form = useTestForm({ check: false })
      return (
        <Form form={form} isReadOnly>
          <SelectorWrapperField form={form} name="check" selectorType="checkbox" label="Check" />
        </Form>
      )
    }
    const { container } = renderWithProviders(<W />)

    // CSS pointer-events:none blocks userEvent; use fireEvent to test JS handler
    fireEvent.click(screen.getByRole("checkbox"))
    expect(screen.getByRole("checkbox")).not.toHaveAttribute("data-checked")
    expect(container.querySelector(".selector-wrapper")).toHaveClass("selector-wrapper--read-only")
  })

  // -- 5.5
  it("[tag:form-field][tag:selector-wrapper-field][tag:selectorWrapper][tag:isDisabled] form-level isDisabled disables the selector", () => {
    function W(): ReactElement {
      const form = useTestForm({ check: false })
      return (
        <Form form={form} isDisabled>
          <SelectorWrapperField form={form} name="check" selectorType="checkbox" label="Check" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("checkbox")).toHaveAttribute("data-disabled", "")
  })
})

// =====================================================
// SelectDropdownField
// =====================================================

describe("SelectDropdownField", () => {
  const items = [
    { key: "1", value: "apple", label: "Apple" },
    { key: "2", value: "banana", label: "Banana" },
  ]

  // -- 6.1
  it("[tag:form-field][tag:select-dropdown-field][tag:select-dropdown][tag:rendering] renders a combobox", () => {
    function W(): ReactElement {
      const form = useTestForm({ fruit: "" })
      return (
        <Form form={form}>
          <SelectDropdownField form={form} name="fruit" label="Fruit" items={items} placeholder="Pick" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })

  // -- 6.2
  it("[tag:form-field][tag:select-dropdown-field][tag:select-dropdown][tag:value] renders label via FormField", () => {
    function W(): ReactElement {
      const form = useTestForm({ fruit: "" })
      return (
        <Form form={form}>
          <SelectDropdownField form={form} name="fruit" label="Fruit" items={items} />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByText("Fruit")).toBeInTheDocument()
  })

  // -- 6.3
  it("[tag:form-field][tag:select-dropdown-field][tag:select-dropdown][tag:change] selecting an option updates the form value", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ fruit: "" })
      return (
        <Form form={form}>
          <SelectDropdownField form={form} name="fruit" label="Fruit" items={items} placeholder="Pick" />
        </Form>
      )
    }
    const { container } = renderWithProviders(<W />)

    const trigger = container.querySelector<HTMLElement>('[data-slot="select-dropdown-trigger"]')!
    await user.click(trigger)
    await user.click(await screen.findByRole("option", { name: "Apple" }))

    await waitFor(() => {
      expect(within(container).getByText("Apple")).toBeInTheDocument()
    })
  })

  // -- 6.4
  it("[tag:form-field][tag:select-dropdown-field][tag:select-dropdown][tag:isDisabled] form-level isDisabled disables the select", () => {
    function W(): ReactElement {
      const form = useTestForm({ fruit: "" })
      return (
        <Form form={form} isDisabled>
          <SelectDropdownField form={form} name="fruit" label="Fruit" items={items} placeholder="Pick" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("combobox")).toHaveAttribute("data-disabled", "")
  })

  // -- 6.5
  it("[tag:form-field][tag:select-dropdown-field][tag:select-dropdown][tag:a11y] exercises aria-describedby path when a message is rendered", () => {
    function W(): ReactElement {
      const form = useTestForm({ fruit: "" })
      return (
        <Form form={form}>
          <SelectDropdownField form={form} name="fruit" label="Fruit" items={items} warning="Careful" />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByText("Careful")).toBeInTheDocument()
  })
})

// =====================================================
// SliderField
// =====================================================

describe("SliderField", () => {
  // -- 7.1
  it("[tag:form-field][tag:slider-field][tag:slider][tag:rendering] renders a slider", () => {
    function W(): ReactElement {
      const form = useTestForm({ volume: 50 })
      return (
        <Form form={form}>
          <SliderField form={form} name="volume" label="Volume" min={0} max={100} />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByRole("slider")).toBeInTheDocument()
  })

  // -- 7.2
  it("[tag:form-field][tag:slider-field][tag:slider][tag:value] shows label via FormField", () => {
    function W(): ReactElement {
      const form = useTestForm({ volume: 50 })
      return (
        <Form form={form}>
          <SliderField form={form} name="volume" label="Volume" min={0} max={100} />
        </Form>
      )
    }
    renderWithProviders(<W />)
    expect(screen.getByText("Volume")).toBeInTheDocument()
  })

  // -- 7.3
  it("[tag:form-field][tag:slider-field][tag:slider][tag:change] arrow key updates the slider value", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ volume: 50 })
      return (
        <Form form={form}>
          <SliderField form={form} name="volume" label="Volume" min={0} max={100} />
        </Form>
      )
    }
    renderWithProviders(<W />)

    const thumb = screen.getByRole("slider")
    await act(async () => {
      thumb.focus()
      await user.keyboard("{ArrowRight}")
    })

    await waitFor(() => {
      expect(thumb).not.toHaveAttribute("aria-valuenow", "50")
    })
  })

  // -- 7.4a
  it("[tag:form-field][tag:slider-field][tag:slider][tag:a11y] slider root is labelled by the FormField label via aria-labelledby", () => {
    function W(): ReactElement {
      const form = useTestForm({ volume: 50 })
      return (
        <Form form={form}>
          <SliderField form={form} name="volume" label="Volume" min={0} max={100} />
        </Form>
      )
    }
    const { container } = renderWithProviders(<W />)

    const label = screen.getByText("Volume").closest("label")
    const labelId = label?.getAttribute("id")
    expect(labelId).toBeTruthy()

    const sliderRoot = container.querySelector("[data-slot='slider']")
    expect(sliderRoot).toHaveAttribute("aria-labelledby", labelId)
  })

  // -- 7.4
  it("[tag:form-field][tag:slider-field][tag:slider][tag:isDisabled] form-level isDisabled disables the slider", () => {
    function W(): ReactElement {
      const form = useTestForm({ volume: 50 })
      return (
        <Form form={form} isDisabled>
          <SliderField form={form} name="volume" label="Volume" min={0} max={100} />
        </Form>
      )
    }
    const { container } = renderWithProviders(<W />)
    const sliderRoot = container.querySelector("[data-slot='slider']")
    expect(sliderRoot).toHaveAttribute("data-disabled", "")
  })
})
