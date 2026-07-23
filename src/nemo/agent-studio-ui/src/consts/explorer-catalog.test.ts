import { describe, expect, it } from "vitest";

import { EXPLORER_DATA_ACCESS_MODELS, resolveDataAccessModel, resolveEffectiveSelectionMode, METRIC_CATEGORY_LIST_ACTION } from "./explorer-catalog";

describe("resolveDataAccessModel", () => {
  it("returns the known model for a recognised provider (case-insensitive)", () => {
    expect(resolveDataAccessModel("s3")).toBe(EXPLORER_DATA_ACCESS_MODELS.s3);
    expect(resolveDataAccessModel("PostgreSQL")).toBe(EXPLORER_DATA_ACCESS_MODELS.postgresql);
  });

  it("falls back to an account model that lists services", () => {
    const model = resolveDataAccessModel("unknown-provider", "account");
    expect(model.rootAction).toBe("listServices");
    expect(model.selectionMode).toBe("single");
    expect(model.selectableTypes).toEqual(["folder", "file"]);
  });

  it("falls back to a path model for resource/empty scope", () => {
    expect(resolveDataAccessModel("unknown", "resource").rootAction).toBe("listPath");
    expect(resolveDataAccessModel(null).rootAction).toBe("listPath");
    expect(resolveDataAccessModel(undefined).rootAction).toBe("listPath");
  });
});

describe("resolveEffectiveSelectionMode", () => {
  it("uses multi for ONTAP at any level", () => {
    const model = EXPLORER_DATA_ACCESS_MODELS.ontap;
    expect(resolveEffectiveSelectionMode(model, "listServices")).toBe("multi");
    expect(resolveEffectiveSelectionMode(model, METRIC_CATEGORY_LIST_ACTION)).toBe("multi");
  });

  it("uses multi for GCP and Azure only on metric category lists", () => {
    const gcp = EXPLORER_DATA_ACCESS_MODELS.gcp;
    const azure = EXPLORER_DATA_ACCESS_MODELS.azure_cloud;
    expect(resolveEffectiveSelectionMode(gcp, "listServices")).toBe("single");
    expect(resolveEffectiveSelectionMode(gcp, METRIC_CATEGORY_LIST_ACTION)).toBe("multi");
    expect(resolveEffectiveSelectionMode(azure, "listServices")).toBe("single");
    expect(resolveEffectiveSelectionMode(azure, METRIC_CATEGORY_LIST_ACTION)).toBe("multi");
  });
});
