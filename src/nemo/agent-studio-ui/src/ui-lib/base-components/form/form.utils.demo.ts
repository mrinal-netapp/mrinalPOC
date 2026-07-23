import type { AnyReactFormApi } from "./form.types"

// useForm() returns a 12-param generic not assignable to AnyReactFormApi
// due to method parameter contravariance. Wrapping the useForm *call* would
// erase type inference on options (e.g. onSubmit's `value`), so instead this
// casts the *result* — consumers write `asFormApi(useForm({ ... }))`.
const asFormApi = (form: unknown): AnyReactFormApi => form as AnyReactFormApi

export { asFormApi }
