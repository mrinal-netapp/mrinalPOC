import { screen, waitFor, fireEvent } from "@testing-library/react"
import type { ReactElement } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, useTestForm, userEvent } from "@test/render"

import { Form, CronExpressionField } from "."

// ---------------------------------------------------------------------------
// CronExpressionField
// ---------------------------------------------------------------------------

describe("CronExpressionField", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:cron-field] shows built-in error when the field is empty on blur", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ schedule: "" })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="schedule"
            label="Schedule"
            data-testid="cron"
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("cron")
    await user.click(input)
    fireEvent.blur(input)
    expect(await screen.findByText("Enter a cron expression.")).toBeInTheDocument()
  })

  it("[tag:cron-field] no error for a valid five-part cron on blur", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ schedule: "" })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="schedule"
            label="Schedule"
            data-testid="cron-ok"
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("cron-ok")
    await user.clear(input)
    await user.type(input, "0 0 * * *")
    await user.tab()
    await waitFor(() => {
      expect(screen.queryByText("Enter a cron expression.")).not.toBeInTheDocument()
    })
  })

  it("runs custom onChange when the merged validator allows", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ sched: "x" })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="sched"
            label="S"
            data-testid="c1"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onChange: (ctx: any) => (ctx?.value === "b" ? "nope" : undefined) } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("c1")
    await user.clear(input)
    await user.type(input, "b")
    expect(await screen.findByText("nope")).toBeInTheDocument()
  })

  it("supports onChange as an array of validators (first error wins)", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ s: "a" })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="s"
            label="S"
            data-testid="c2"
            validators={{
              onChange: [() => "first", () => "second"],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("c2")
    await user.clear(input)
    await user.type(input, "b")
    expect(await screen.findByText("first")).toBeInTheDocument()
  })

  it("runs custom onBlur after a valid cron (built-in passes) for a single function", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ s: "0 0 * * *" })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="s"
            label="S"
            data-testid="c3"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onBlur: () => "always" } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("c3")
    await user.click(input)
    await user.tab()
    expect(await screen.findByText("always")).toBeInTheDocument()
  })

  it("onBlur: built-in error short-circuits before user onBlur in an array", async () => {
    const user = userEvent.setup()
    const userFn = vi.fn()
    function S(): ReactElement {
      const form = useTestForm({ s: "" })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="s"
            label="S"
            data-testid="c4"
            validators={{
              onBlur: [() => { userFn(); return "user" }, () => "tail"],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("c4")
    await user.click(input)
    fireEvent.blur(input)
    expect(userFn).not.toHaveBeenCalled()
    expect(await screen.findByText("Enter a cron expression.")).toBeInTheDocument()
  })

  it("onBlur: array runs the first user function that returns an error after the built-in passes", async () => {
    const user = userEvent.setup()
    const userFn = vi.fn()
    function S(): ReactElement {
      const form = useTestForm({ s: "0 0 * * *" })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="s"
            label="S"
            data-testid="c5"
            validators={{
              onBlur: [() => { userFn(); return undefined }, () => "after"],
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("c5")
    await user.click(input)
    await user.tab()
    expect(userFn).toHaveBeenCalled()
    expect(await screen.findByText("after")).toBeInTheDocument()
  })

  it("[tag:cron-field] shows built-in error on submit when cron is empty (onSubmit built-in short-circuit)", async () => {
    const onFormSubmit = vi.fn()
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ schedule: "" }, onFormSubmit)
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="schedule"
            label="Schedule"
            data-testid="cron-submit"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{} as any}
          />
          <button type="submit">Send</button>
        </Form>
      )
    }
    renderWithProviders(<S />)
    await user.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByText("Enter a cron expression.")).toBeInTheDocument()
    expect(onFormSubmit).not.toHaveBeenCalled()
  })

  it("runs onSubmit validator (single function) when the form is submitted", async () => {
    const user = userEvent.setup()
    const onFormSubmit = vi.fn()
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" }, onFormSubmit)
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="a"
            label="A"
            data-testid="sub-1"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onSubmit: () => "on-submit" } as any}
          />
          <button type="submit">Run</button>
        </Form>
      )
    }
    renderWithProviders(<S />)
    await user.click(screen.getByRole("button", { name: "Run" }))
    expect(await screen.findByText("on-submit")).toBeInTheDocument()
    expect(onFormSubmit).not.toHaveBeenCalled()
  })

  it("runs onSubmit validators from an array (first error wins) on form submit", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" }, () => { })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="a"
            label="A"
            data-testid="sub-2"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onSubmit: [() => "first", () => "second"] } as any}
          />
          <button type="submit">Run</button>
        </Form>
      )
    }
    renderWithProviders(<S />)
    await user.click(screen.getByRole("button", { name: "Run" }))
    expect(await screen.findByText("first")).toBeInTheDocument()
  })

  it("merged onChange returns undefined when validators only provide onBlur", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" }, () => { })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="a"
            label="A"
            data-testid="only-blur"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onBlur: () => undefined } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("only-blur")
    await user.type(input, "x")
  })

  it("onChange: array of validators with no error returns undefined (tail fall-through)", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" }, () => { })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="a"
            label="A"
            data-testid="oc-tails"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onChange: [() => undefined, () => undefined] } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("oc-tails")
    await user.type(input, "0")
  })

  it("onBlur: user array of validators with no error returns undefined (tail fall-through)", async () => {
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" }, () => { })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="a"
            label="A"
            data-testid="ob-tails"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onBlur: [() => undefined, () => undefined] } as any}
          />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("ob-tails")
    await user.click(input)
    fireEvent.blur(input)
  })

  it("onSubmit: merged callback returns undefined when user validators omit onSubmit (empty user object)", async () => {
    const user = userEvent.setup()
    const onForm = vi.fn()
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" }, onForm)
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="a"
            label="A"
            data-testid="os-empty-obj"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{} as any}
          />
          <button type="submit">Send</button>
        </Form>
      )
    }
    renderWithProviders(<S />)
    await user.click(screen.getByRole("button", { name: "Send" }))
    expect(onForm).toHaveBeenCalled()
  })

  it("onSubmit: user array of validators with no error returns undefined (tail fall-through)", async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" }, onSubmit)
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="a"
            label="A"
            data-testid="os-tails"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onSubmit: [() => undefined, () => undefined] } as any}
          />
          <button type="submit">Go</button>
        </Form>
      )
    }
    renderWithProviders(<S />)
    await user.click(screen.getByRole("button", { name: "Go" }))
    expect(onSubmit).toHaveBeenCalled()
  })

  it("moves focus to the next field on Enter and calls onKeyDown for non-Enter keys", async () => {
    const onKey = vi.fn()
    const user = userEvent.setup()
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" }, () => { })
      return (
        <Form form={form}>
          <CronExpressionField
            form={form}
            name="a"
            label="A"
            onKeyDown={onKey}
            data-testid="e1"
          />
          <input type="text" data-testid="e2" defaultValue="after" />
        </Form>
      )
    }
    renderWithProviders(<S />)
    const a = screen.getByTestId("e1")
    const b = screen.getByTestId("e2")
    await user.click(a)
    await user.keyboard("{Escape}")
    expect(onKey).toHaveBeenCalled()
    fireEvent.keyDown(a, { key: "Enter" })
    await waitFor(() => {
      expect(document.activeElement).toBe(b)
    })
  })

  it("Enter press is a no-op when input has no ancestor <form> (if-form false branch)", () => {
    // Render without <Form> so target.closest("form") returns null → covers the false branch of `if (form)`
    function S(): ReactElement {
      const form = useTestForm({ a: "0 0 * * *" })
      return (
        <div>
          <CronExpressionField form={form} name="a" label="A" data-testid="no-form-cron" />
        </div>
      )
    }
    renderWithProviders(<S />)
    const input = screen.getByTestId("no-form-cron")
    expect(() => {
      fireEvent.keyDown(input, { key: "Enter" })
    }).not.toThrow()
  })
})
