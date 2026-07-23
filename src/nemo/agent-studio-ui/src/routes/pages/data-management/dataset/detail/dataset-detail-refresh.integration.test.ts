// Integration test for the dataset-detail "Refresh" button.
//
// `dataset-detail.test.tsx` mocks `@/api/dataset-api.slice` entirely, so it
// only proves `handleRefresh` *calls* `invalidateTags` with the right args —
// it can't prove that doing so actually causes RTK Query to refetch the
// underlying data. This test uses the REAL `apiSlice` / `datasetApi` /
// `dataSourceApi` (only `global.fetch` is stubbed) to prove the full,
// unmocked mechanism: subscribing to each query the detail page depends on,
// then dispatching the exact `invalidateTags` payload `handleRefresh` sends,
// and asserting every one of them issues a brand-new network request.
import { describe, expect, it, afterEach, vi } from "vitest"

import { createMockStore } from "@test/mocks"
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock"
import { apiSlice } from "@/api/api.slice"
import { datasetApi } from "@/api/dataset-api.slice"
import { dataSourceApi } from "@/api/data-source-api.slice"

const PROJECT_ID = "proj-1"
const DSET_ID = "dset-abc"
const DSRC_ID = "ds-1"

const DATASET_RAW = {
  id: DSET_ID,
  name: "My Dataset",
  kind: "unstructured",
  type: "acquired",
  status: "ready",
  originVolume: DSRC_ID,
}

const DATA_SOURCE_RAW = { id: DSRC_ID, name: "Prod Source", type: "volume" }

describe("DatasetDetail refresh button — real RTK Query cache invalidation", () => {
  afterEach(() => {
    restoreAllMocks()
  })

  it("[tag:dataset-detail][tag:refresh][tag:integration] invalidating the exact tag set handleRefresh dispatches triggers a real refetch on every active subscription", async () => {
    const store = createMockStore()

    const mock = mockFetchByUrl([
      { match: `/datasets/${DSET_ID}/knowledge-bases`, data: { dataset_id: DSET_ID, knowledge_bases: [] } },
      { match: `/datasets/${DSET_ID}/snapshots`, data: { snapshots: [] } },
      { match: `/datasets/${DSET_ID}/manifests`, data: [] },
      { match: `/datasources/${DSRC_ID}`, data: DATA_SOURCE_RAW },
      // Keep this last: it's a substring of the manifests/snapshots/KBs URLs'
      // common prefix, so more specific routes above must win first.
      { match: `/datasets/${DSET_ID}`, data: DATASET_RAW },
    ])

    // Subscribe to every query the dataset detail page keeps alive (mirrors
    // the real component tree: getDataset + listDatasetKnowledgeBases are
    // always mounted, listDatasetSnapshots/listDatasetManifests are mounted
    // whenever their tab is visible).
    const subscriptions = [
      store.dispatch(datasetApi.endpoints.getDataset.initiate({ projectId: PROJECT_ID, dsetId: DSET_ID })),
      store.dispatch(datasetApi.endpoints.listDatasetKnowledgeBases.initiate({ projectId: PROJECT_ID, dsetId: DSET_ID })),
      store.dispatch(datasetApi.endpoints.listDatasetSnapshots.initiate({ projectId: PROJECT_ID, dsetId: DSET_ID })),
      store.dispatch(datasetApi.endpoints.listDatasetManifests.initiate({ projectId: PROJECT_ID, dsetId: DSET_ID })),
      store.dispatch(dataSourceApi.endpoints.getDataSource.initiate({ projectId: PROJECT_ID, dsrcId: DSRC_ID })),
    ]
    await Promise.all(subscriptions)

    expect(mock).toHaveBeenCalledTimes(5)

    // The exact payload `handleRefresh` in dataset-detail.tsx dispatches.
    store.dispatch(
      apiSlice.util.invalidateTags([
        { type: "DatasetDetail", id: DSET_ID },
        { type: "DatasetSnapshots", id: DSET_ID },
        { type: "DatasetManifests", id: DSET_ID },
        { type: "DatasetKBs", id: DSET_ID },
        { type: "DataSourceDetail", id: DSRC_ID },
      ]),
    )

    // RTK Query's invalidation-triggered refetches are fired synchronously on
    // dispatch but resolve asynchronously — poll until every refetch settles
    // instead of guessing a fixed number of microtask ticks.
    await vi.waitFor(() => {
      expect(mock).toHaveBeenCalledTimes(10)
    })

    // And confirm each subscribed query's cache entry actually now reflects a
    // *second* fulfilled fetch (not just that fetch() was called again).
    await vi.waitFor(() => {
      const state = store.getState()
      expect(
        datasetApi.endpoints.getDataset.select({ projectId: PROJECT_ID, dsetId: DSET_ID })(state).status,
      ).toBe("fulfilled")
      expect(
        dataSourceApi.endpoints.getDataSource.select({ projectId: PROJECT_ID, dsrcId: DSRC_ID })(state).status,
      ).toBe("fulfilled")
    })

    // Cleanup subscriptions so the store doesn't keep polling after the test.
    subscriptions.forEach((sub) => sub.unsubscribe())
  })
})
