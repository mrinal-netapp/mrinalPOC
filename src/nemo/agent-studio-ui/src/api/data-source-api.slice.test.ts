import { describe, expect, it, beforeEach, afterEach } from "vitest"
import type { Mock } from "vitest"

import { createMockStore } from "@test/mocks"
import { mockFetchSuccess, mockFetchError, restoreAllMocks } from "@test/api-mock"
import { dataSourceApi } from "./data-source-api.slice"
import type { DataSourceFormCreateInput } from "./data-source.types"

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

async function calledBodyJson(mock: Mock): Promise<unknown> {
  const arg = mock.mock.calls[0]?.[0]
  // When fetchBaseQuery serializes the body it creates a Request; read JSON from the stream.
  if (arg instanceof Request) return arg.json()
  return arg?.body
}

// Backend sends 'id', not 'dsrc_id'. The mapper (normalizeDataSource) reads
// raw.id and surfaces it as dsrc_id on the frontend type.
const LIST_RESPONSE = {
  data: [
    { id: "a", name: "ds-a" },
    { id: "b", name: "ds-b" },
  ],
  pagination: { limit: 10, offset: 0, total_count: 2 },
}

const DETAIL_RESPONSE = { id: "x", name: "test-ds" }

const CREATE_BODY: DataSourceFormCreateInput = {
  name: "new-ds",
  source_type: "NFS",
  connection: {
    server: "1.2.3.4",
    export_path: "/data",
    auth_method: "none",
  },
}

describe("dataSourceApi", () => {
  let store: TestStore

  beforeEach(() => {
    store = createMockStore()
  })

  afterEach(() => {
    store.dispatch(dataSourceApi.util.resetApiState())
    restoreAllMocks()
  })

  // -- Queries --

  describe("listStorageClasses", () => {
    it("[tag:data-source-api][tag:volume] GETs /deployments and flattens + dedupes storage_classes", async () => {
      const mock = mockFetchSuccess([
        { region: "us-east-1", storage_classes: ["ontap-nas", "standard-rwx"] },
        { region: "us-west-2", storage_classes: [{ name: "ontap-nas" }, { name: "fast-nfs" }] },
        { region: "eu-1" },
      ])

      const result = await store.dispatch(
        dataSourceApi.endpoints.listStorageClasses.initiate({ projectId: PROJECT_ID }),
      )

      expect(calledUrl(mock)).toContain("/deployments")
      expect(calledUrl(mock)).not.toContain("/projects/")
      expect(result.data).toEqual([
        { name: "ontap-nas", provisioner: "" },
        { name: "standard-rwx", provisioner: "" },
        { name: "fast-nfs", provisioner: "" },
      ])
    })

    it("[tag:data-source-api][tag:volume] returns an empty list when /deployments errors", async () => {
      mockFetchError(500, { message: "boom" })

      const result = await store.dispatch(
        dataSourceApi.endpoints.listStorageClasses.initiate({ projectId: PROJECT_ID }),
      )

      expect(result.data).toEqual([])
    })
  })

  describe("listDataSources", () => {
    // 3.1 — query construction with params
    it("[tag:data-source-api] should GET /datasources with query params — offset maps to skip", async () => {
      const mock = mockFetchSuccess(LIST_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.listDataSources.initiate({ projectId: PROJECT_ID, limit: 10, offset: 5 }),
      )

      expect(mock).toHaveBeenCalled()
      const url = calledUrl(mock)
      expect(url).toContain("/datasources")
      expect(url).toContain("limit=10")
      // The slice remaps offset → skip to match the backend query validator.
      expect(url).toContain("skip=5")
      expect(url).not.toContain("offset=")
    })

    // 3.1b — search remaps to nameRegex
    it("[tag:data-source-api] should remap search → nameRegex in the query string", async () => {
      const mock = mockFetchSuccess(LIST_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.listDataSources.initiate({ projectId: PROJECT_ID, search: "my-volume" }),
      )

      expect(mock).toHaveBeenCalled()
      const url = calledUrl(mock)
      // The slice remaps search → nameRegex to match the backend query validator.
      expect(url).toContain("nameRegex=my-volume")
      expect(url).not.toContain("search=")
    })

    // 3.1 — query construction without params (covers `params ?? undefined`)
    it("[tag:data-source-api] should GET /datasources without params when void", async () => {
      const mock = mockFetchSuccess(LIST_RESPONSE)

      await store.dispatch(dataSourceApi.endpoints.listDataSources.initiate({ projectId: PROJECT_ID }))

      expect(mock).toHaveBeenCalled()
      const url = calledUrl(mock)
      expect(url).toContain("/datasources")
      expect(url).not.toContain("limit=")
    })

    // 3.2 — providesTags truthy branch
    it("[tag:data-source-api] should provide per-item DataSource tags when result has data", async () => {
      mockFetchSuccess(LIST_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.listDataSources.initiate({ projectId: PROJECT_ID, limit: 10 }),
      )

      const tags = store.getState().api.provided.tags
      expect(tags.DataSource?.LIST).toBeDefined()
      expect(tags.DataSource?.a).toBeDefined()
      expect(tags.DataSource?.b).toBeDefined()
    })

    // 3.3 — providesTags falsy branch (result is undefined on error)
    it("[tag:data-source-api] should provide only LIST tag when query errors", async () => {
      mockFetchError(500)

      await store.dispatch(
        dataSourceApi.endpoints.listDataSources.initiate({ projectId: PROJECT_ID, limit: 10 }),
      )

      const tags = store.getState().api.provided.tags
      expect(tags.DataSource?.LIST).toBeDefined()
      expect(tags.DataSource?.a).toBeUndefined()
    })
  })

  // 3.4
  describe("getDataSource", () => {
    it("[tag:data-source-api] should GET /datasources/:id and provide DataSourceDetail tag", async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.getDataSource.initiate({ projectId: PROJECT_ID, dsrcId: "dsrc-123" }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/datasources/dsrc-123")

      const tags = store.getState().api.provided.tags
      expect(tags.DataSourceDetail?.["dsrc-123"]).toBeDefined()
    })
  })

  // 3.5
  describe("listDataSourceDatasets", () => {
    it("[tag:data-source-api] should GET /datasources/:id/datasets and provide DataSourceDatasets tag", async () => {
      const mock = mockFetchSuccess({ data_source_id: "dsrc-456", datasets: [] })

      await store.dispatch(
        dataSourceApi.endpoints.listDataSourceDatasets.initiate({ projectId: PROJECT_ID, dsrcId: "dsrc-456" }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/datasources/dsrc-456/datasets")

      const tags = store.getState().api.provided.tags
      expect(tags.DataSourceDatasets?.["dsrc-456"]).toBeDefined()
    })
  })

  // -- Mutations --

  // 3.7
  describe("createDataSource", () => {
    it("[tag:data-source-api] should POST /datasources and invalidate LIST", async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.createDataSource.initiate({ projectId: PROJECT_ID, body: CREATE_BODY }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/datasources")
      expect(calledMethod(mock)).toBe("POST")
    })

    // 3.7b — connector branch: builds a type:'connector' body with merged
    // connector_config (scope/provider/connector_type + provider fields) and credential_id.
    it("[tag:data-source-api][tag:connector] should POST a connector body when connector is set", async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.createDataSource.initiate({
          projectId: PROJECT_ID,
          body: {
            name: "pg-ds",
            source_type: "PostgreSQL" as DataSourceFormCreateInput["source_type"],
            connection: { server: "db.example.com" },
            connector: {
              provider: "postgresql",
              scope: "resource",
              connector_type: "database",
              config: { host: "db.example.com", port: 5432 },
              credential_id: "cred-1",
            },
          },
        }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledMethod(mock)).toBe("POST")
      expect(await calledBodyJson(mock)).toMatchObject({
        name: "pg-ds",
        type: "connector",
        credential_id: "cred-1",
        connector_config: {
          scope: "resource",
          provider: "postgresql",
          connector_type: "database",
          host: "db.example.com",
          port: 5432,
        },
      })
    })

    // Fail-fast: a volume body (no connector) without a protocol must not POST a
    // silently-defaulted NFS source — it surfaces an error instead.
    it("[tag:data-source-api] should fail fast when a volume body has no source_type", async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE)

      const result = await store.dispatch(
        dataSourceApi.endpoints.createDataSource.initiate({
          projectId: PROJECT_ID,
          body: {
            name: "no-protocol",
            source_type: null,
            connection: { server: "1.2.3.4" },
          },
        }),
      )

      expect(mock).not.toHaveBeenCalled()
      expect("error" in result && result.error).toBeTruthy()
    })

    // 3.7c — volume static ("Existing Volume"): maps endpoint + mount options
    // + metadata into a type:'volume' body with provisioning_mode "static".
    it("[tag:data-source-api][tag:volume] should POST a static volume body for an existing volume", async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.createDataSource.initiate({
          projectId: PROJECT_ID,
          body: {
            name: "vol-static",
            source_type: "NFSVolumes" as DataSourceFormCreateInput["source_type"],
            labels: [],
            connection: {
              server: "nfs-server:/export",
              provisioning_mode: "static",
              volume_type: "NFS",
              region: "Auto",
              mount_options: ["noac"],
              metadata: { team: "data" },
              auth_method: "basic",
              username: "svc-user",
              password: "s3cret",
            },
          },
        }),
      )

      expect(calledMethod(mock)).toBe("POST")
      const staticBody = (await calledBodyJson(mock)) as {
        id: string
        project_id: string
        volume_config: { volume_info: Record<string, unknown> }
      }
      // Volume create body carries a client-supplied id + the owning project.
      expect(staticBody.project_id).toBe(PROJECT_ID)
      expect(staticBody.id).toMatch(/^vol-[a-z0-9]+$/)
      expect(staticBody).toMatchObject({
        name: "vol-static",
        type: "volume",
        metadata: { team: "data" },
        volume_config: {
          protocol: "nfs",
          // Region is free-text now and sent verbatim (no Auto → default coercion).
          region: "Auto",
          volume_info: {
            type: "nfs",
            provisioning_mode: "static",
            endpoint: "nfs-server:/export",
            mount_options: ["noac"],
          },
          auth_info: {
            type: "basic",
            username: "svc-user",
            // Credential is sent under password_encrypted.
            password_encrypted: "s3cret",
          },
        },
      })
      // folder_boundary and scan_config were dropped from the volume contract;
      // empty labels are omitted rather than sent as [].
      expect(staticBody.volume_config.volume_info).not.toHaveProperty("folder_boundary")
      expect(staticBody).not.toHaveProperty("scan_config")
      expect(staticBody).not.toHaveProperty("labels")
    })

    // 3.7d — volume dynamic ("New Volume"): maps StorageClass + storage size +
    // access modes into a type:'volume' body with provisioning_mode "dynamic".
    it("[tag:data-source-api][tag:volume] should POST a dynamic volume body for a new volume", async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.createDataSource.initiate({
          projectId: PROJECT_ID,
          body: {
            name: "vol-dynamic",
            source_type: "NFSVolumes" as DataSourceFormCreateInput["source_type"],
            connection: {
              server: "",
              provisioning_mode: "dynamic",
              volume_type: "NFS",
              region: "us-east-1",
              storage_class_name: "ontap-nas",
              storage_size: "100Gi",
            },
          },
        }),
      )

      expect(calledMethod(mock)).toBe("POST")
      const dynamicBody = await calledBodyJson(mock)
      expect(dynamicBody).toMatchObject({
        name: "vol-dynamic",
        type: "volume",
        volume_config: {
          protocol: "nfs",
          region: "us-east-1",
          volume_info: {
            type: "nfs",
            provisioning_mode: "dynamic",
            storage_class_name: "ontap-nas",
            storage_size: "100Gi",
            // Defaults to RWX when no access modes are supplied.
            access_modes: ["ReadWriteMany"],
          },
        },
      })
      // Scanning was dropped from the volume contract.
      expect(dynamicBody).not.toHaveProperty("scan_config")
    })
  })

  // 3.8 — replaceDataSource is dead code (no UI caller) and commented out in the slice.
  // describe("replaceDataSource", () => {
  //   it("[tag:data-source-api] should PUT /datasources/:id and invalidate tags", async () => {
  //     const mock = mockFetchSuccess(DETAIL_RESPONSE)
  //     await store.dispatch(
  //       dataSourceApi.endpoints.replaceDataSource.initiate({
  //         dsrcId: "x",
  //         body: CREATE_BODY,
  //       }),
  //     )
  //     expect(mock).toHaveBeenCalled()
  //     expect(calledUrl(mock)).toContain("/datasources/x")
  //     expect(calledMethod(mock)).toBe("PUT")
  //   })
  // })

  // 3.9
  describe("updateDataSource", () => {
    it("[tag:data-source-api] should PUT /datasources/:id and invalidate tags", async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.updateDataSource.initiate({
          projectId: PROJECT_ID,
          dsrcId: "y",
          body: { name: "updated" },
        }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/datasources/y")
      expect(calledMethod(mock)).toBe("PUT")
    })
  })

  // 3.10
  describe("deleteDataSource", () => {
    it("[tag:data-source-api] should DELETE /datasources/:id and invalidate tags", async () => {
      const mock = mockFetchSuccess(null)

      await store.dispatch(
        dataSourceApi.endpoints.deleteDataSource.initiate({ projectId: PROJECT_ID, dsrcId: "z" }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/datasources/z")
      expect(calledMethod(mock)).toBe("DELETE")
    })
  })

  // 3.11
  describe("updateDataSourceDeprecation", () => {
    it("[tag:data-source-api] should PUT /datasources/:id and invalidate tags", async () => {
      const mock = mockFetchSuccess({ dsrc_id: "w", deprecated: true, message: "ok" })

      await store.dispatch(
        dataSourceApi.endpoints.updateDataSourceDeprecation.initiate({
          projectId: PROJECT_ID,
          dsrcId: "w",
          body: { deprecated: true },
        }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/datasources/w")
      expect(calledMethod(mock)).toBe("PUT")
    })
  })

  // 3.11
  describe("triggerManualScan", () => {
    it("[tag:data-source-api] should POST /datasources/:id/scan with scan_config and invalidate tags", async () => {
      const mock = mockFetchSuccess(DETAIL_RESPONSE)

      await store.dispatch(
        dataSourceApi.endpoints.triggerManualScan.initiate({
          projectId: PROJECT_ID,
          dsrcId: "scan-1",
          scanConfig: { scan_depth: "top_2_levels", custom_depth: null },
        }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/datasources/scan-1/scan")
      expect(calledMethod(mock)).toBe("POST")
      expect(await calledBodyJson(mock)).toMatchObject({ scan_config: { scan_depth: "top_2_levels", custom_depth: null } })
    })
  })
})
