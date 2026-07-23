import { describe, it, expect } from "vitest"
import type { DataSourceDetail } from "@/api/data-source.types"
import { buildDefaultValues } from "./data-source-form.consts"

// ---------------------------------------------------------------------------
// Section 2 — buildDefaultValues in data-source-form.consts.ts
// ---------------------------------------------------------------------------

const BASE_DETAIL: DataSourceDetail = {
  dsrc_id: "ds-1",
  name: "my-source",
  source_type: "NFS",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: ["prod", "nfs"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  description: "A test source",
  connection: {
    server: "nfs.host",
    export_path: "/data",
    folder_boundary: "/mnt",
    auth_method: "none",
    username: "user1",
  },
  modified_by: "alice",
  scan: {
    status: "Completed",
    scan_depth: "top_2_levels",
    custom_depth: null,
    total_files: 100,
    total_folders: 10,
    total_size_bytes: 1024,
    last_completed_at: "2024-06-01T00:00:00Z",
    status_message: null,
    file_type_stats: null,
  },
  scanned_data_count: 100,
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
}

describe("buildDefaultValues", () => {
  // 2.16
  it("[tag:ds-form-consts] no initialData returns default empty form values", () => {
    const values = buildDefaultValues()

    expect(values.source_type).toBe("")
    expect(values.name).toBe("")
    expect(values.description).toBe("")
    expect(values.labels).toEqual([])
    expect(values.scan_enabled).toBe(false)
    expect(values.scan_config.scan_depth).toBe("none")
    expect(values.scan_config.custom_depth).toBe(1)
    expect(values.connection.server).toBe("")
    expect(values.connection.auth_method).toBe("none")
    expect(values.connection.username).toBe("")
    expect(values.connection.password).toBe("")
  })

  // 2.17
  it("[tag:ds-form-consts] initialData maps name, source_type, and connection fields", () => {
    const values = buildDefaultValues(BASE_DETAIL)

    expect(values.name).toBe("my-source")
    expect(values.source_type).toBe("NFS")
    expect(values.connection.server).toBe("nfs.host")
    expect(values.connection.export_path).toBe("/data")
    expect(values.connection.folder_boundary).toBe("/mnt")
    expect(values.connection.auth_method).toBe("none")
    expect(values.connection.username).toBe("user1")
    // password is never filled from API
    expect(values.connection.password).toBe("")
  })

  it("[tag:ds-form-consts] null description coalesces to empty string", () => {
    const values = buildDefaultValues({ ...BASE_DETAIL, description: null })
    expect(values.description).toBe("")
  })

  it("[tag:ds-form-consts] volume connection fields hydrate for edit prepopulation", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      connection: {
        ...BASE_DETAIL.connection,
        region: "us-west-2",
        provisioning_mode: "dynamic",
        volume_type: "NFS",
        mount_options: ["vers=4.1"],
        storage_class_name: "ontap-nas",
        storage_size: "50Gi",
      },
    })

    expect(values.connection.region).toBe("us-west-2")
    expect(values.connection.provisioning_mode).toBe("dynamic")
    expect(values.connection.volume_type).toBe("NFS")
    expect(values.connection.mount_options).toEqual(["vers=4.1"])
    expect(values.connection.storage_class_name).toBe("ontap-nas")
    expect(values.connection.storage_size).toBe("50Gi")
  })

  it("[tag:ds-form-consts] labels coalesce from initialData", () => {
    const values = buildDefaultValues(BASE_DETAIL)
    expect(values.labels).toEqual(["prod", "nfs"])
  })

  // 2.18
  it("[tag:ds-form-consts] initialData.scan null yields scan_enabled false and depth 'none'", () => {
    const values = buildDefaultValues({ ...BASE_DETAIL, scan: null })

    expect(values.scan_enabled).toBe(false)
    expect(values.scan_config.scan_depth).toBe("none")
    expect(values.scan_config.custom_depth).toBe(1)
  })

  // 2.19
  it("[tag:ds-form-consts] scan_depth 'none' yields scan_enabled false", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      scan: { ...BASE_DETAIL.scan!, scan_depth: "none" },
    })

    expect(values.scan_enabled).toBe(false)
  })

  // 2.20
  it("[tag:ds-form-consts] non-'none' scan_depth yields scan_enabled true", () => {
    const values = buildDefaultValues(BASE_DETAIL)

    expect(values.scan_enabled).toBe(true)
    expect(values.scan_config.scan_depth).toBe("top_2_levels")
  })

  it("[tag:ds-form-consts] scan.custom_depth null falls back to 1 in scan_config", () => {
    const values = buildDefaultValues(BASE_DETAIL)
    // BASE_DETAIL has custom_depth: null — should default to 1
    expect(values.scan_config.custom_depth).toBe(1)
  })

  // Gap 7: covers the `?? ""` fallback on line 60 when export_path is null
  it("[tag:ds-form-consts] null export_path falls back to empty string", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      connection: { ...BASE_DETAIL.connection, export_path: null },
    })
    expect(values.connection.export_path).toBe("")
  })

  // Gap 7b: covers the `?? ""` fallback for folder_boundary when it is null
  it("[tag:ds-form-consts] null folder_boundary falls back to empty string", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      connection: { ...BASE_DETAIL.connection, folder_boundary: null },
    })
    expect(values.connection.folder_boundary).toBe("")
  })

  // buildConnectorFromInitial: connector_config present, top-level taxonomy
  // fields set → connector is rebuilt and catalog fields split into `config`.
  it("[tag:ds-form-consts] rebuilds connector from connector_config using top-level taxonomy fields", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      provider: "postgresql",
      connector_scope: "resource",
      connector_type: "database",
      credential_id: "cred-1",
      connector_config: {
        scope: "resource",
        provider: "postgresql",
        connector_type: "database",
        host: "db.host",
        port: 5432,
      },
    })

    expect(values.connector).not.toBeNull()
    expect(values.connector?.provider).toBe("postgresql")
    expect(values.connector?.scope).toBe("resource")
    expect(values.connector?.connector_type).toBe("database")
    expect(values.connector?.credential_id).toBe("cred-1")
    expect(values.connector?.config).toEqual({ host: "db.host", port: 5432 })
  })

  // buildConnectorFromInitial: top-level taxonomy fields absent → fall back to
  // the values nested inside connector_config, and credential_id coalesces to "".
  it("[tag:ds-form-consts] falls back to connector_config taxonomy when top-level fields are null", () => {
    const values = buildDefaultValues({
      ...BASE_DETAIL,
      provider: null,
      connector_scope: null,
      connector_type: null,
      credential_id: null,
      connector_config: {
        scope: "account",
        provider: "redash",
        connector_type: "api",
        base_url: "https://redash.example.com",
      },
    })

    expect(values.connector?.provider).toBe("redash")
    expect(values.connector?.scope).toBe("account")
    expect(values.connector?.connector_type).toBe("api")
    expect(values.connector?.credential_id).toBe("")
    expect(values.connector?.config).toEqual({ base_url: "https://redash.example.com" })
  })
})
