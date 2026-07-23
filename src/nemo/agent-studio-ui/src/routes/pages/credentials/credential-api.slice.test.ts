// inside credentials/credential-api.slice.test.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { Mock } from "vitest"

import { createMockStore } from "@test/mocks"
import { mockFetchSuccess, mockFetchError, restoreAllMocks } from "@test/api-mock"
import { credentialApi } from "./credential-api.slice"
import type { CredentialCreateRequest, CredentialUpdateRequest, CredentialRotateRequest } from "./credential.types"

const PROJECT_ID = "test-project"

type TestStore = ReturnType<typeof createMockStore>

function calledUrl(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0]
  if (typeof arg === "string") return arg
  return arg?.url ?? String(arg)
}

function calledMethod(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0]
  return arg?.method ?? "GET"
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREDENTIAL_A = { id: "cred-a", name: "openai-key", provider: "openai", projectId: "proj-1", createdAt: "", updatedAt: "" }
const CREDENTIAL_B = { id: "cred-b", name: "aws-key",    provider: "aws_bedrock", projectId: "proj-1", createdAt: "", updatedAt: "" }

const CREATE_BODY: CredentialCreateRequest = {
  name: "new-key",
  provider: "openai",
  secretData: { api_key: "sk-abc" },
}

const UPDATE_BODY: CredentialUpdateRequest = {
  name: "renamed-key",
  description: "updated desc",
}

const ROTATE_BODY: CredentialRotateRequest = {
  secretData: { api_key: "sk-new" },
  expiresAt: "2027-01-01T00:00:00.000Z",
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("credentialApi", () => {
  let store: TestStore

  beforeEach(() => {
    store = createMockStore()
  })

  afterEach(() => {
    store.dispatch(credentialApi.util.resetApiState())
    restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // listCredentials
  // -------------------------------------------------------------------------

  describe("listCredentials", () => {
    it("[tag:credential-api] should GET /credentials", async () => {
      const mock = mockFetchSuccess([CREDENTIAL_A, CREDENTIAL_B])

      await store.dispatch(credentialApi.endpoints.listCredentials.initiate({ projectId: PROJECT_ID }))

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/credentials")
      expect(calledMethod(mock)).toBe("GET")
    })

    it("[tag:credential-api] should pass provider and labels query params", async () => {
      const mock = mockFetchSuccess([CREDENTIAL_A])

      await store.dispatch(
        credentialApi.endpoints.listCredentials.initiate({ projectId: PROJECT_ID, provider: "openai", labels: "prod" }),
      )

      expect(mock).toHaveBeenCalled()
      const url = calledUrl(mock)
      expect(url).toContain("provider=openai")
      expect(url).toContain("labels=prod")
    })

    it("[tag:credential-api] transformResponse handles a plain array response", async () => {
      mockFetchSuccess([CREDENTIAL_A, CREDENTIAL_B])

      const result = await store.dispatch(
        credentialApi.endpoints.listCredentials.initiate({ projectId: PROJECT_ID }),
      )

      expect(result.data).toHaveLength(2)
      expect(result.data?.[0].id).toBe("cred-a")
    })

    it("[tag:credential-api] transformResponse handles a wrapped { data: [] } response", async () => {
      mockFetchSuccess({ data: [CREDENTIAL_A] })

      const result = await store.dispatch(
        credentialApi.endpoints.listCredentials.initiate({ projectId: PROJECT_ID }, { forceRefetch: true }),
      )

      expect(result.data).toHaveLength(1)
      expect(result.data?.[0].id).toBe("cred-a")
    })

    it("[tag:credential-api] transformResponse returns empty array when wrapped response has no data", async () => {
      mockFetchSuccess({ data: undefined })

      const result = await store.dispatch(
        credentialApi.endpoints.listCredentials.initiate({ projectId: PROJECT_ID }, { forceRefetch: true }),
      )

      expect(result.data).toEqual([])
    })

    it("[tag:credential-api] providesTags includes LIST and per-item Credential tags on success", async () => {
      mockFetchSuccess([CREDENTIAL_A, CREDENTIAL_B])

      await store.dispatch(credentialApi.endpoints.listCredentials.initiate({ projectId: PROJECT_ID }))

      const tags = store.getState().api.provided.tags
      expect(tags.Credential?.LIST).toBeDefined()
      expect(tags.Credential?.["cred-a"]).toBeDefined()
      expect(tags.Credential?.["cred-b"]).toBeDefined()
    })

    it("[tag:credential-api] providesTags includes only LIST tag on error", async () => {
      mockFetchError(500)

      await store.dispatch(credentialApi.endpoints.listCredentials.initiate({ projectId: PROJECT_ID }))

      const tags = store.getState().api.provided.tags
      expect(tags.Credential?.LIST).toBeDefined()
      expect(tags.Credential?.["cred-a"]).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // getCredential
  // -------------------------------------------------------------------------

  describe("getCredential", () => {
    it("[tag:credential-api] should GET /credentials/:id", async () => {
      const mock = mockFetchSuccess(CREDENTIAL_A)

      await store.dispatch(credentialApi.endpoints.getCredential.initiate({ projectId: PROJECT_ID, id: "cred-a" }))

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/credentials/cred-a")
      expect(calledMethod(mock)).toBe("GET")
    })

    it("[tag:credential-api] providesTags includes CredentialDetail tag for the fetched id", async () => {
      mockFetchSuccess(CREDENTIAL_A)

      await store.dispatch(credentialApi.endpoints.getCredential.initiate({ projectId: PROJECT_ID, id: "cred-a" }))

      const tags = store.getState().api.provided.tags
      expect(tags.CredentialDetail?.["cred-a"]).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // createCredential
  // -------------------------------------------------------------------------

  describe("createCredential", () => {
    it("[tag:credential-api] should POST /credentials", async () => {
      const mock = mockFetchSuccess(CREDENTIAL_A)

      await store.dispatch(credentialApi.endpoints.createCredential.initiate({ projectId: PROJECT_ID, body: CREATE_BODY }))

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/credentials")
      expect(calledMethod(mock)).toBe("POST")
    })
  })

  // -------------------------------------------------------------------------
  // updateCredential
  // -------------------------------------------------------------------------

  describe("updateCredential", () => {
    it("[tag:credential-api] should PATCH /credentials/:id", async () => {
      const mock = mockFetchSuccess({ ...CREDENTIAL_A, ...UPDATE_BODY })

      await store.dispatch(
        credentialApi.endpoints.updateCredential.initiate({ projectId: PROJECT_ID, id: "cred-a", body: UPDATE_BODY }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/credentials/cred-a")
      expect(calledMethod(mock)).toBe("PATCH")
    })
  })

  // -------------------------------------------------------------------------
  // deleteCredential
  // -------------------------------------------------------------------------

  describe("deleteCredential", () => {
    it("[tag:credential-api] should DELETE /credentials/:id", async () => {
      const mock = mockFetchSuccess(null)

      await store.dispatch(credentialApi.endpoints.deleteCredential.initiate({ projectId: PROJECT_ID, id: "cred-a" }))

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/credentials/cred-a")
      expect(calledMethod(mock)).toBe("DELETE")
    })
  })

  // -------------------------------------------------------------------------
  // validateCredential
  // -------------------------------------------------------------------------

  describe("validateCredential", () => {
    it("[tag:credential-api] should POST /credentials/:id/validate", async () => {
      const mock = mockFetchSuccess({ valid: true })

      await store.dispatch(credentialApi.endpoints.validateCredential.initiate({ projectId: PROJECT_ID, id: "cred-a" }))

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/credentials/cred-a/validate")
      expect(calledMethod(mock)).toBe("POST")
    })

    it("[tag:credential-api] should POST /credentials/:id/validate and handle invalid result", async () => {
      mockFetchSuccess({ valid: false, error: "Invalid credentials" })

      const result = await store.dispatch(
        credentialApi.endpoints.validateCredential.initiate({ projectId: PROJECT_ID, id: "cred-b" }),
      )

      expect(result.data?.valid).toBe(false)
      expect(result.data?.error).toBe("Invalid credentials")
    })
  })

  // -------------------------------------------------------------------------
  // rotateCredential
  // -------------------------------------------------------------------------

  describe("rotateCredential", () => {
    it("[tag:credential-api] should POST /credentials/:id/rotate", async () => {
      const mock = mockFetchSuccess({ ...CREDENTIAL_A, rotationVersion: 2 })

      await store.dispatch(
        credentialApi.endpoints.rotateCredential.initiate({ projectId: PROJECT_ID, id: "cred-a", body: ROTATE_BODY }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/credentials/cred-a/rotate")
      expect(calledMethod(mock)).toBe("POST")
    })

    it("[tag:credential-api] rotate response contains the updated credential", async () => {
      mockFetchSuccess({ ...CREDENTIAL_A, rotationVersion: 3, lastRotatedAt: "2026-06-08T00:00:00.000Z" })

      const result = await store.dispatch(
        credentialApi.endpoints.rotateCredential.initiate({ projectId: PROJECT_ID, id: "cred-a", body: ROTATE_BODY }),
      )

      expect(result.data?.rotationVersion).toBe(3)
      expect(result.data?.lastRotatedAt).toBe("2026-06-08T00:00:00.000Z")
    })
  })
})
