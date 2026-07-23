import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

/*
 * Node 23+ ships a partial global `localStorage` (gated behind
 * `--localstorage-file`) that shadows jsdom's and lacks `.clear()`. Provide a
 * conformant in-memory shim only when the runtime's `localStorage` is missing
 * methods. This is a no-op on the pinned Node 22 / jsdom (where jsdom's
 * `localStorage.clear` already exists), so CI behaviour is unchanged; it only
 * repairs local runs on newer Node.
 */
if (typeof localStorage === "undefined" || typeof localStorage.clear !== "function") {
  const store = new Map<string, string>()
  const shim: Storage = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
    writable: true,
  })
}

const env = import.meta.env as Record<string, string>

const setDefaultEnv = (name: keyof typeof env, fallback: string) => {
  if (!env[name]?.trim()) {
    env[name] = fallback
  }
}

// Node 24's native fetch (undici) requires absolute URLs in the Request
// constructor. Provide defaults so RTK Query's fetchBaseQuery doesn't
// throw "Invalid URL" when VITE_*_BASE_URL vars are unset (e.g. in CI).
setDefaultEnv('VITE_API_BASE_URL', 'http://localhost:3000/api/v1/config-service')
setDefaultEnv('VITE_UTILITIES_API_BASE_URL', 'http://localhost:3000/api/v1/utilities')
setDefaultEnv('VITE_AGENT_API_BASE_URL', 'http://localhost:3000/api/agent')
setDefaultEnv('VITE_MODEL_SERVICE_BASE_URL', 'http://127.0.0.1:8000')
setDefaultEnv('VITE_AGENT_RUNTIME_API_BASE_URL', 'http://localhost:3000/api/agent')
setDefaultEnv('VITE_KB_RETRIEVAL_API_BASE_URL', 'http://localhost:3000/kb/api/v1')

/** Relative bases are valid in the browser (Vite proxy) but Node fetch requires absolute URLs. */
function ensureAbsoluteBaseUrl(name: keyof typeof env, fallback: string): void {
  setDefaultEnv(name, fallback)
  const value = env[name]?.trim()
  if (value && !value.startsWith('http')) {
    env[name] = `http://localhost:3000${value.startsWith('/') ? value : `/${value}`}`
  }
}

ensureAbsoluteBaseUrl('VITE_API_BASE_URL', 'http://localhost:3000/api/v1/config-service')
ensureAbsoluteBaseUrl('VITE_UTILITIES_API_BASE_URL', 'http://localhost:3000/api/v1/utilities')
ensureAbsoluteBaseUrl('VITE_AGENT_API_BASE_URL', 'http://localhost:3000/api/agent')
ensureAbsoluteBaseUrl('VITE_AGENT_RUNTIME_API_BASE_URL', 'http://localhost:3000/api/agent')
ensureAbsoluteBaseUrl('VITE_KB_RETRIEVAL_API_BASE_URL', 'http://localhost:3000/kb/api/v1')
ensureAbsoluteBaseUrl('VITE_MODEL_SERVICE_BASE_URL', 'http://127.0.0.1:8000')
setDefaultEnv('VITE_PROJECT_ID', 'test-project')
setDefaultEnv('VITE_USER_ID', 'test-user')
setDefaultEnv('VITE_ORG_ID', 'test-org')

afterEach(() => {
  cleanup()
})
