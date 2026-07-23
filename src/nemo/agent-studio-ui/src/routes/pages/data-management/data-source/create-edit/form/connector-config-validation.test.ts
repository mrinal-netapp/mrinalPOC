import { describe, it, expect } from "vitest";

import {
  areCatalogRequiredFieldsFilled,
  compactConfig,
  getRequiredFieldSet,
  getRequiredFields,
  getSchemaForProvider,
  isCatalogLoaded,
  isConnectorCategoryReady,
  resolveObjectStoreCatalogProvider,
  S3_COMPATIBLE_CATALOG_PROVIDER,
  withClearedConnectorConfigFields,
} from "./connector-config-validation";
import { MOCK_PROVIDER_CATALOG } from "./connector-config-validation.fixture";

describe("connector-config-validation", () => {
  it("compactConfig drops empty strings and NaN numbers", () => {
    expect(compactConfig({ bucket: "b", region: "", port: Number.NaN })).toEqual({ bucket: "b" });
  });

  it("withClearedConnectorConfigFields nulls optional fields dropped from the patch", () => {
    expect(
      withClearedConnectorConfigFields(
        {
          scope: "resource",
          provider: "postgresql",
          connector_type: "database",
          host: "postgres.example.com",
          port: 5432,
        },
        {
          scope: "resource",
          provider: "postgresql",
          connector_type: "database",
          host: "postgres.example.com",
          port: 5432,
          database: "appdb",
        },
      ),
    ).toEqual({
      scope: "resource",
      provider: "postgresql",
      connector_type: "database",
      host: "postgres.example.com",
      port: 5432,
      database: null,
    });
  });

  it("withClearedConnectorConfigFields returns next unchanged when previous is missing", () => {
    const next = {
      scope: "resource" as const,
      provider: "postgresql",
      connector_type: "database" as const,
      host: "h",
    };
    expect(withClearedConnectorConfigFields(next, undefined)).toBe(next);
  });

  it("getSchemaForProvider returns scope schema", () => {
    const schema = getSchemaForProvider(MOCK_PROVIDER_CATALOG, "s3", "resource");
    expect(schema?.required).toEqual(["bucket"]);
  });

  it("getRequiredFields returns catalog required list", () => {
    expect(getRequiredFields(MOCK_PROVIDER_CATALOG, "postgresql", "resource")).toEqual(["host", "port"]);
  });

  it("getRequiredFieldSet builds a Set", () => {
    expect(getRequiredFieldSet(MOCK_PROVIDER_CATALOG, "s3", "resource")).toEqual(new Set(["bucket"]));
    expect(getRequiredFieldSet(MOCK_PROVIDER_CATALOG, "s3_compatible", "resource")).toEqual(
      new Set(["endpoint", "bucket"]),
    );
  });

  it("resolveObjectStoreCatalogProvider maps S3-compatible subtypes to s3_compatible", () => {
    expect(resolveObjectStoreCatalogProvider("S3Compatible", "S3", "s3")).toBe(S3_COMPATIBLE_CATALOG_PROVIDER);
    expect(resolveObjectStoreCatalogProvider("CustomObjectStore", "S3", "s3")).toBe(S3_COMPATIBLE_CATALOG_PROVIDER);
    expect(resolveObjectStoreCatalogProvider("CustomObjectStore", "GCS", "gcs")).toBe("gcs");
    expect(resolveObjectStoreCatalogProvider("AmazonS3", "S3", "s3")).toBe("s3");
  });

  it("isConnectorCategoryReady requires endpoint for s3_compatible", () => {
    expect(
      isConnectorCategoryReady(
        MOCK_PROVIDER_CATALOG,
        "s3_compatible",
        "resource",
        { bucket: "my-bucket", endpoint: "https://minio.local" },
        true,
      ),
    ).toBe(true);
    expect(
      isConnectorCategoryReady(
        MOCK_PROVIDER_CATALOG,
        "s3_compatible",
        "resource",
        { bucket: "my-bucket" },
        true,
      ),
    ).toBe(false);
  });

  it("areCatalogRequiredFieldsFilled accepts non-empty strings and numbers", () => {
    expect(areCatalogRequiredFieldsFilled(["host", "port"], { host: "db.local", port: 5432 })).toBe(true);
    expect(areCatalogRequiredFieldsFilled(["host", "port"], { host: "db.local" })).toBe(false);
    expect(areCatalogRequiredFieldsFilled(["host"], { host: "  " })).toBe(false);
  });

  it("isConnectorCategoryReady requires creds and catalog required fields", () => {
    expect(
      isConnectorCategoryReady(
        MOCK_PROVIDER_CATALOG,
        "s3",
        "resource",
        { bucket: "my-bucket" },
        true,
      ),
    ).toBe(true);
    expect(
      isConnectorCategoryReady(
        MOCK_PROVIDER_CATALOG,
        "s3",
        "resource",
        {},
        true,
      ),
    ).toBe(false);
    expect(
      isConnectorCategoryReady(
        MOCK_PROVIDER_CATALOG,
        "gcs",
        "resource",
        {},
        true,
      ),
    ).toBe(true);
  });

  it("isCatalogLoaded is false while loading or errored", () => {
    expect(isCatalogLoaded(undefined, true, false)).toBe(false);
    expect(isCatalogLoaded(MOCK_PROVIDER_CATALOG, false, true)).toBe(false);
    expect(isCatalogLoaded(MOCK_PROVIDER_CATALOG, false, false)).toBe(true);
  });
});
