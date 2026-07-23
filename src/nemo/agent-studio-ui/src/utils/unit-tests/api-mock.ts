import { vi, type Mock } from "vitest"

/**
 * Mocks global.fetch to return a successful JSON response.
 * Returns the spy so callers can assert on call args.
 */
export function mockFetchSuccess(data: unknown): Mock {
  const mock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
      headers: new Headers({ "content-type": "application/json" }),
      clone: function () { return this },
    }),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

/**
 * Mocks global.fetch to return an error response.
 * RTK Query's fetchBaseQuery reads the JSON body on errors too.
 */
export function mockFetchError(status: number, body: unknown = { error: "mock error" }): Mock {
  const mock = vi.fn(() =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: new Headers({ "content-type": "application/json" }),
      clone: function () { return this },
    }),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

/**
 * Routes fetch responses based on URL substring matches. Useful when a
 * single endpoint internally fans out into multiple requests (e.g. an
 * RTK Query `queryFn` that does compose-style fetches).
 *
 * The first matching pattern wins. If no pattern matches, the mock
 * resolves to a 404 with a descriptive body so tests fail loudly
 * instead of hanging or silently returning the wrong shape.
 */
export function mockFetchByUrl(
  routes: Array<{ match: string | RegExp; data: unknown; status?: number }>,
): Mock {
  const mock = vi.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input)
    const route = routes.find(r =>
      typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url),
    )
    if (!route) {
      const body = { error: `no mockFetchByUrl route matched: ${url}` }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        headers: new Headers({ "content-type": "application/json" }),
        clone: function () { return this },
      })
    }
    return Promise.resolve({
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: () => Promise.resolve(route.data),
      text: () => Promise.resolve(JSON.stringify(route.data)),
      headers: new Headers({ "content-type": "application/json" }),
      clone: function () { return this },
    })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Restores all mocks (including fetch) to their original state. Call in afterEach. */
export function restoreAllMocks(): void {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
}
