import { type ReactElement, type ReactNode } from "react"
import { render, type RenderOptions, type RenderResult } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useForm } from "@tanstack/react-form"
import { Provider } from "react-redux"
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router"
import { ProjectContext } from "@/contexts/project/model/context"
import type { ProjectContextValue } from "@/contexts/project/model/project.types"
import { createMockStore } from "./mocks"
import { buildTestProjectContextValue } from "./project-context"

export { userEvent }

// useForm() returns a 12-param generic not assignable to AnyReactFormApi
// due to method parameter contravariance. This wrapper centralizes the
// `any` cast so individual test files don't need eslint-disable comments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useTestForm(defaultValues: any, onSubmit: () => void = () => { }): any {
  return useForm({ defaultValues, onSubmit: async () => { onSubmit() } })
}

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  initialEntries?: string[]
  preloadedState?: Partial<import("@/store/store.types").RootState>
  /** Override the test ProjectContext value (defaults derived from preloadedState.projectContext.activeProject). */
  projectContext?: Partial<ProjectContextValue>
}

type ComponentTestOptions = RenderWithProvidersOptions & { routeConfig?: never }
type RoutingTestOptions = RenderWithProvidersOptions & {
  routeConfig: Parameters<typeof createMemoryRouter>[0]
}

/*
 * Component tests: pass `ui` and omit `routeConfig` — MemoryRouter wraps the component.
 * Routing/integration tests: pass `undefined` and provide `routeConfig` — the full router tree is mounted.
 */
export function renderWithProviders(ui: ReactElement, options?: ComponentTestOptions): RenderResult
export function renderWithProviders(ui: undefined, options: RoutingTestOptions): RenderResult
export function renderWithProviders(
  ui: ReactElement | undefined,
  { initialEntries = ["/"], routeConfig, preloadedState, projectContext, ...renderOptions }: ComponentTestOptions | RoutingTestOptions = {},
): RenderResult {
  const store = createMockStore(preloadedState)
  const router = routeConfig ? createMemoryRouter(routeConfig, { initialEntries }) : null

  // A bare ProjectContext.Provider stubs the value without needing AuthProvider /
  // RTK Query wiring that the real ProjectProvider requires. Tests that care can
  // override individual fields via `projectContext`.
  const projectValue = buildTestProjectContextValue(preloadedState?.projectContext?.activeProject, projectContext)

  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    if (router) {
      return (
        <Provider store={store}>
          <ProjectContext.Provider value={projectValue}>
            <RouterProvider router={router} />
          </ProjectContext.Provider>
        </Provider>
      )
    }

    return (
      <Provider store={store}>
        <ProjectContext.Provider value={projectValue}>
          <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
        </ProjectContext.Provider>
      </Provider>
    )
  }

  return render(router ? <></> : ui!, { wrapper: Wrapper, ...renderOptions })
}
