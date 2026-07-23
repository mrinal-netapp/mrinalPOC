import type { AnyReactFormApi } from "./form.types"

/**
 * TanStack Form's `handleSubmit()` bails out when `canSubmit` is false (e.g. an
 * existing field error from blur, or an async field validator still in flight
 * because the user blurred a field by clicking the submit button) before it
 * runs `validate('submit')` or the form `validators.onSubmit` path. The
 * {@link Form} component's native `onSubmit` works around that; external buttons
 * outside `<form>` (e.g. sticky footers) must use this instead of
 * `form.handleSubmit()` alone.
 *
 * When the first `handleSubmit()` bails, we run submit-cause validation, wait
 * for it to settle, and — if the form is now valid — submit again. Without this
 * second submit the user would have to click the button twice (the first click
 * only validates).
 */
async function runFormHandleSubmit(form: AnyReactFormApi): Promise<void> {
  const couldSubmit = form.state.canSubmit
  await form.handleSubmit()
  if (!couldSubmit && !form.state.isSubmitting) {
    await form.validate("submit")
    if (form.state.canSubmit) {
      await form.handleSubmit()
    }
  }
}

function flattenValidationError(value: unknown): string[] {
  if (value == null) {
    return []
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenValidationError)
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    if (record.fields != null && typeof record.fields === "object") {
      return Object.values(record.fields as Record<string, unknown>).flatMap(flattenValidationError)
    }
    return Object.values(record).flatMap(flattenValidationError)
  }
  return [String(value)]
}

/** Collects unique validation messages after a failed submit (field + form-level). */
function collectFormValidationErrors(form: AnyReactFormApi): string[] {
  const seen = new Set<string>()
  const messages: string[] = []
  const add = (message: string) => {
    if (!message || seen.has(message)) {
      return
    }
    seen.add(message)
    messages.push(message)
  }

  for (const meta of Object.values(form.state.fieldMeta ?? {})) {
    const errors = (meta as { errors?: unknown[] } | undefined)?.errors ?? []
    for (const err of errors) {
      flattenValidationError(err).forEach(add)
    }
  }

  flattenValidationError(form.state.errorMap?.onSubmit).forEach(add)

  return messages
}

function collectFirstFormValidationError(form: AnyReactFormApi): string | undefined {
  return collectFormValidationErrors(form)[0]
}

function scrollToFirstFormError(): void {
  const el = document.querySelector(
    ".form-field__message--error, .dset-form__schema-query-error, .dset-form__message-below",
  )
  el?.scrollIntoView?.({ behavior: "smooth", block: "center" })
}

export {
  runFormHandleSubmit,
  collectFormValidationErrors,
  collectFirstFormValidationError,
  scrollToFirstFormError,
}
