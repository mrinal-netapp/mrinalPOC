import { useEffect, useState } from "react"
import type { ReactElement } from "react"
import { useForm } from "@tanstack/react-form"

import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Form } from "./form"
import { InputField } from "./form-field.input"
import { SelectDropdownField } from "./form-field.select-dropdown"
import { SliderField } from "./form-field.slider"
import "./form.init.demo.scss"

// -- Data

const FRAMEWORK_ITEMS = [
  { key: "react", value: "react", label: "React" },
  { key: "vue", value: "vue", label: "Vue" },
  { key: "svelte", value: "svelte", label: "Svelte" },
  { key: "angular", value: "angular", label: "Angular" },
  { key: "solid", value: "solid", label: "SolidJS" },
]

// -- Types & simulated data sources

type InitValues = { name: string; email: string; framework: string; volume: number }

const HARDCODED_DEFAULTS: InitValues = {
  name: "hardcoded-user",
  email: "hardcoded@acme.io",
  framework: "angular",
  volume: 42,
}

const STORE_DATA: InitValues = {
  name: "from-redux-store",
  email: "store@acme.io",
  framework: "vue",
  volume: 60,
}

function simulateApiFetch(): Promise<InitValues> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        name: "fetched-from-api",
        email: "api-response@acme.io",
        framework: "svelte",
        volume: 85,
      })
    }, 1500)
  })
}

// -- Shared field set used by every init card

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function InitFormFields({ form }: { form: any }): ReactElement {
  return (
    <>
      <InputField form={form} name="name" label="Name" />
      <InputField form={form} name="email" label="Email" />
      <SelectDropdownField form={form} name="framework" label="Framework" items={FRAMEWORK_ITEMS} placeholder="Select" size="fill" />
      <SliderField form={form} name="volume" label="Volume" min={0} max={100} step={5} />
    </>
  )
}

// -- Inner component: mounts only once API data arrives

function ApiInitForm({ data }: { data: InitValues }): ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiForm: any = useForm({ defaultValues: data })

  return (
    <Form form={apiForm} isReadOnly className="init-demo__form">
      <InitFormFields form={apiForm} />
    </Form>
  )
}

// -- Page component

export default function FormInitDemo(): ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defaultsForm: any = useForm({ defaultValues: HARDCODED_DEFAULTS })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storeForm: any = useForm({ defaultValues: STORE_DATA })

  const [apiData, setApiData] = useState<InitValues | null>(null)

  useEffect(() => {
    let cancelled = false
    simulateApiFetch().then((data) => {
      if (!cancelled) setApiData(data)
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="init-demo">
      <Typography Component="h1" fontSize="fs20" boldness="semibold" className="init-demo__title">
        Form Initialization Sources
      </Typography>
      <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="init-demo__subtitle">
        POC showing three ways to populate a form: hardcoded defaults, data from a Redux store, and data fetched from an API.
      </Typography>

      <div className="init-demo__grid">
        {/* ── 1. Hardcoded defaults ── */}
        <div className="init-demo__card">
          <Typography Component="h3" fontSize="fs14" boldness="semibold">
            1. Hardcoded defaults
          </Typography>
          <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
            Values defined inline in the component and passed as <code>defaultValues</code>.
          </Typography>

          <Form form={defaultsForm} isReadOnly className="init-demo__form">
            <InitFormFields form={defaultsForm} />
          </Form>

          <pre className="init-demo__pre">{JSON.stringify(HARDCODED_DEFAULTS, null, 2)}</pre>
        </div>

        {/* ── 2. Store data ── */}
        <div className="init-demo__card">
          <Typography Component="h3" fontSize="fs14" boldness="semibold">
            2. Data from store
          </Typography>
          <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
            Simulates a Redux selector providing initial values to <code>useForm</code>.
          </Typography>

          <Form form={storeForm} isReadOnly className="init-demo__form">
            <InitFormFields form={storeForm} />
          </Form>

          <pre className="init-demo__pre">{JSON.stringify(STORE_DATA, null, 2)}</pre>
        </div>

        {/* ── 3. API fetch ── */}
        <div className="init-demo__card">
          <Typography Component="h3" fontSize="fs14" boldness="semibold">
            3. Data from API
          </Typography>
          <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
            Simulates an async fetch (1.5 s delay). State starts <code>null</code>; the form mounts once data arrives so <code>defaultValues</code> are the API response.
          </Typography>

          {apiData === null ? (
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="init-demo__loading">
              Loading from API...
            </Typography>
          ) : (
            <ApiInitForm data={apiData} />
          )}

          <pre className="init-demo__pre">
            {apiData === null ? '"Loading..."' : JSON.stringify(apiData, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  )
}
