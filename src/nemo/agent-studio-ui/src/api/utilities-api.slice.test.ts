import { describe, expect, it, beforeEach, afterEach } from "vitest"
import type { Mock } from "vitest"

import { createMockStore } from "@test/mocks"
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import { utilitiesApi } from "./utilities-api.slice"
import type { ValidateConnectionRequest } from "./utilities.types"

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

const VALIDATE_RESPONSE = { healthiness_status: "Healthy" as const }

const NFS_BODY: ValidateConnectionRequest = {
  type: "NFS",
  server: "192.168.1.100",
  folderBoundary: ["/"],
}

const SMB_BODY: ValidateConnectionRequest = {
  type: "SMB",
  server: "192.168.1.200",
  folderBoundary: ["/"],
  credentialsRef: "ref-abc",
}

describe("utilitiesApi", () => {
  let store: TestStore

  beforeEach(() => {
    store = createMockStore()
  })

  afterEach(() => {
    store.dispatch(utilitiesApi.util.resetApiState())
    restoreAllMocks()
  })

  describe("browse", () => {
    it("[tag:utilities-api] should GET /browse with datasourceId and path params", async () => {
      const mock = mockFetchSuccess({ path: "/data", items: [], totalItems: 0, limit: 100 })

      await store.dispatch(
        utilitiesApi.endpoints.browse.initiate({ datasourceId: "ds-1", path: "/data" }),
      )

      expect(mock).toHaveBeenCalled()
      const url = calledUrl(mock)
      expect(url).toContain("/browse?")
      expect(url).toContain("datasourceId=ds-1")
      expect(url).toContain("path=%2Fdata")
    })

    it("[tag:utilities-api] should include limit and continuationToken when provided", async () => {
      const mock = mockFetchSuccess({ path: "/", items: [], totalItems: 0, limit: 50 })

      await store.dispatch(
        utilitiesApi.endpoints.browse.initiate({
          datasourceId: "ds-2",
          path: "/",
          limit: 50,
          continuationToken: "abc-token",
        }),
      )

      expect(mock).toHaveBeenCalled()
      const url = calledUrl(mock)
      expect(url).toContain("limit=50")
      expect(url).toContain("continuationToken=abc-token")
    })

    it("[tag:utilities-api] should omit optional params when not provided", async () => {
      const mock = mockFetchSuccess({ path: "/", items: [], totalItems: 0, limit: 100 })

      await store.dispatch(
        utilitiesApi.endpoints.browse.initiate({ datasourceId: "ds-3" }),
      )

      expect(mock).toHaveBeenCalled()
      const url = calledUrl(mock)
      expect(url).toContain("datasourceId=ds-3")
      expect(url).not.toContain("path=")
      expect(url).not.toContain("limit=")
      expect(url).not.toContain("continuationToken=")
    })
  })

  describe("validateConnection", () => {
    it("[tag:utilities-api] should POST /validate-connection with the request body", async () => {
      const mock = mockFetchSuccess(VALIDATE_RESPONSE)

      await store.dispatch(
        utilitiesApi.endpoints.validateConnection.initiate({ body: NFS_BODY }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/validate-connection")
      expect(calledMethod(mock)).toBe("POST")
    })
  })

  describe("validateExistingDatasourceConnection", () => {
    it("[tag:utilities-api] should POST /datasources/:id/validate-connection with the request body", async () => {
      const mock = mockFetchSuccess(VALIDATE_RESPONSE)
      const dsrcId = "550e8400-e29b-41d4-a716-446655440000"

      await store.dispatch(
        utilitiesApi.endpoints.validateExistingDatasourceConnection.initiate({
          dsrcId,
          body: SMB_BODY,
        }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain(`/datasources/${dsrcId}/validate-connection`)
      expect(calledMethod(mock)).toBe("POST")
    })
  })
})
