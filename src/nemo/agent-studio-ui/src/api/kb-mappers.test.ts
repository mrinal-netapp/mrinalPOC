import { describe, expect, it } from "vitest"

import {
  mapKBStatus,
  toBackendCreateBody,
  toBackendUpdateBody,
  toKBAssignedDatasetResponse,
  toKBDetail,
  toKBListItem,
  toKBMutationResult,
  type BackendKB,
} from "./kb-mappers"

function makeBackendKB(overrides: Partial<BackendKB> = {}): BackendKB {
  return {
    id: "kb-1",
    name: "KB One",
    projectId: "proj-1",
    sourceDataset: "dset-1",
    embeddingModel: "text-embedding-3-small",
    chunkSize: 512,
    vectorSize: 1536,
    status: "ready",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("kb-mappers", () => {
  describe("mapKBStatus", () => {
    it("[tag:kb-mappers] maps each known status", () => {
      expect(mapKBStatus("in_progress")).toBe("in_progress")
      expect(mapKBStatus("ready")).toBe("ready")
      expect(mapKBStatus("errored")).toBe("errored")
      expect(mapKBStatus("deprecated")).toBe("deprecated")
    })

    it("[tag:kb-mappers] falls back to in_progress for unknown/undefined", () => {
      expect(mapKBStatus(undefined)).toBe("in_progress")
      expect(mapKBStatus("something-else")).toBe("in_progress")
    })
  })

  describe("toKBListItem", () => {
    it("[tag:kb-mappers] maps core fields with stats and assigned dataset", () => {
      const item = toKBListItem(
        makeBackendKB({
          status: "deprecated",
          labels: ["prod", "staging"],
          stats: { documentCount: 10, vectorCount: 99, lastProcessedAt: "2024-02-02" },
        }),
      )

      expect(item.kb_id).toBe("kb-1")
      expect(item.status).toBe("deprecated")
      expect(item.deprecated).toBe(true)
      expect(item.labels).toEqual(["prod", "staging"])
      expect(item.assigned_dataset).toEqual({ dset_id: "dset-1" })
      expect(item.snapshot).toEqual({
        files_indexed: 10,
        vectors: 99,
        last_sync: "2024-02-02",
      })
    })

    it("[tag:kb-mappers] omits assigned dataset and snapshot when missing", () => {
      const item = toKBListItem(makeBackendKB({ sourceDataset: "", stats: undefined }))

      expect(item.assigned_dataset).toBeUndefined()
      expect(item.snapshot).toBeNull()
    })

    it("[tag:kb-mappers] defaults last_sync to null when not processed", () => {
      const item = toKBListItem(makeBackendKB({ stats: { documentCount: 1 } }))
      expect(item.snapshot?.last_sync).toBeNull()
    })
  })

  describe("toKBDetail", () => {
    it("[tag:kb-mappers] builds embedding/chunking/indexing config and sync status", () => {
      const detail = toKBDetail(
        makeBackendKB({
          description: "desc",
          status: "in_progress",
          chunkOverlap: 50,
          chunkStrategy: "markdown",
          indexingMode: "hybrid",
          quantizationType: "scalar",
          stats: { fileCount: 3, storageMB: 1, documentCount: 4, lastProcessedAt: "2024-03-03" },
        }),
      )

      expect(detail.description).toBe("desc")
      expect(detail.synchronization_status).toBe("Synchronizing")
      expect(detail.last_synchronized_at).toBe("2024-03-03")
      expect(detail.embedding_config).toEqual({ model: "text-embedding-3-small", dimensions: 1536 })
      expect(detail.chunking_config).toMatchObject({ strategy: "hierarchical", chunk_size: 512, overlap: 50 })
      expect(detail.indexing_config).toEqual({ index_type: "hybrid_search", vector_quantization: "scalar" })
    })

    it("[tag:kb-mappers] maps backend chunkOptions into chunking_config.options", () => {
      const detail = toKBDetail(
        makeBackendKB({
          chunkStrategy: "sentence",
          chunkSize: 512,
          chunkOverlap: 0,
          chunkOptions: { maxSentences: 8, overlapSentences: 2 },
        }),
      )

      expect(detail.chunking_config).toEqual({
        strategy: "sentence",
        chunk_size: 512,
        overlap: 0,
        options: { maxSentences: 8, overlapSentences: 2 },
      })
    })

    it("[tag:kb-mappers] leaves chunking_config.options undefined when chunkOptions is absent", () => {
      const detail = toKBDetail(makeBackendKB({ chunkStrategy: "chunk_by_character" }))

      expect(detail.chunking_config?.options).toBeUndefined()
    })

    it("[tag:kb-mappers] returns undefined configs when source fields are absent", () => {
      const detail = toKBDetail(
        makeBackendKB({
          embeddingModel: "",
          chunkSize: null as unknown as number,
          chunkOverlap: undefined,
          chunkStrategy: undefined,
          indexingMode: undefined,
          quantizationType: undefined,
          description: undefined,
          stats: undefined,
        }),
      )

      expect(detail.embedding_config).toBeUndefined()
      expect(detail.chunking_config).toBeUndefined()
      expect(detail.indexing_config).toBeUndefined()
      expect(detail.description).toBeNull()
      expect(detail.stats).toBeUndefined()
      expect(detail.last_synchronized_at).toBeNull()
    })

    it("[tag:kb-mappers] leaves sync status undefined for deprecated/unknown statuses", () => {
      expect(toKBDetail(makeBackendKB({ status: "deprecated" })).synchronization_status).toBeUndefined()
    })

    it("[tag:kb-mappers] surfaces textColumns as text_columns for structured-dataset KBs", () => {
      const detail = toKBDetail(makeBackendKB({ textColumns: "title, content" }))
      expect(detail.text_columns).toBe("title, content")
    })

    it("[tag:kb-mappers] leaves text_columns undefined when absent", () => {
      const detail = toKBDetail(makeBackendKB())
      expect(detail.text_columns).toBeUndefined()
    })
  })

  describe("toKBMutationResult", () => {
    it("[tag:kb-mappers] preserves workflow outcome fields alongside KB detail", () => {
      const result = toKBMutationResult({
        ...makeBackendKB({ description: "updated desc" }),
        workflowId: "wf-abc",
        workflowStatus: "running",
        warning: "partial success",
        workflowError: "engine timeout",
        workflowSkippedReason: "dataset_not_ready",
      })

      expect(result.kb_id).toBe("kb-1")
      expect(result.description).toBe("updated desc")
      expect(result.workflowId).toBe("wf-abc")
      expect(result.workflowStatus).toBe("running")
      expect(result.warning).toBe("partial success")
      expect(result.workflowError).toBe("engine timeout")
      expect(result.workflowSkippedReason).toBe("dataset_not_ready")
    })

    it("[tag:kb-mappers] omits workflow fields when backend does not send them", () => {
      const result = toKBMutationResult(makeBackendKB())

      expect(result.workflowId).toBeUndefined()
      expect(result.warning).toBeUndefined()
      expect(result.workflowError).toBeUndefined()
      expect(result.workflowSkippedReason).toBeUndefined()
    })
  })

  describe("toKBAssignedDatasetResponse", () => {
    it("[tag:kb-mappers] returns an empty dataset when none is provided", () => {
      const res = toKBAssignedDatasetResponse("kb-1", undefined)
      expect(res).toEqual({ kb_id: "kb-1", dataset: {} })
    })

    it("[tag:kb-mappers] maps each dataset status to its display + sync status", () => {
      const ready = toKBAssignedDatasetResponse("kb-1", {
        id: "d", projectId: "p", name: "D", status: "ready",
      })
      expect(ready.dataset.status).toBe("Healthy")
      expect(ready.dataset.synchronization_status).toBe("Completed")

      const inProgress = toKBAssignedDatasetResponse("kb-1", {
        id: "d", projectId: "p", name: "D", status: "in_progress",
      })
      expect(inProgress.dataset.status).toBe("Synchronizing")
      expect(inProgress.dataset.synchronization_status).toBe("Synchronizing")

      const errored = toKBAssignedDatasetResponse("kb-1", {
        id: "d", projectId: "p", name: "D", status: "errored",
      })
      expect(errored.dataset.status).toBe("Failed")
      expect(errored.dataset.synchronization_status).toBe("Failed")

      const deprecated = toKBAssignedDatasetResponse("kb-1", {
        id: "d", projectId: "p", name: "D", status: "deprecated",
      })
      expect(deprecated.dataset.status).toBe("Deprecated")
      expect(deprecated.dataset.synchronization_status).toBeUndefined()

      const none = toKBAssignedDatasetResponse("kb-1", { id: "d", projectId: "p", name: "D" })
      expect(none.dataset.status).toBeUndefined()
      expect(none.dataset.synchronization_status).toBeUndefined()
    })

    it("[tag:kb-mappers] surfaces the dataset kind so the KB form can require text columns", () => {
      const structured = toKBAssignedDatasetResponse("kb-1", {
        id: "d", projectId: "p", name: "D", kind: "structured",
      })
      expect(structured.dataset.kind).toBe("structured")

      const unstructured = toKBAssignedDatasetResponse("kb-1", {
        id: "d", projectId: "p", name: "D", kind: "unstructured",
      })
      expect(unstructured.dataset.kind).toBe("unstructured")
    })
  })

  describe("toBackendCreateBody / toBackendUpdateBody", () => {
    it("[tag:kb-mappers] flattens and maps every config field to the backend shape", () => {
      const body = toBackendCreateBody({
        name: "New KB",
        description: "d",
        dataset_id: "dset-9",
        embedding_config: { model: "m", dimensions: 768 },
        chunking_config: {
          strategy: "chunk_by_token",
          chunk_size: 256,
          overlap: 16,
          options: { maxTokens: 256, tokenOverlap: 16 },
        },
        indexing_config: {
          index_type: "keyword_only",
          vector_quantization: "ivf_pq",
          quantization_options: { numPartitions: 8 },
        },
      } as never)

      expect(body).toMatchObject({
        name: "New KB",
        sourceDataset: "dset-9",
        embeddingModel: "m",
        vectorSize: 768,
        chunkSize: 256,
        chunkOverlap: 16,
        chunkStrategy: "token",
        chunkOptions: { maxTokens: 256, tokenOverlap: 16 },
        indexingMode: "fts",
        quantizationType: "ivf_pq",
        quantizationOptions: { numPartitions: 8 },
      })
    })

    it("[tag:kb-mappers] forwards labels and empty labels array on update", () => {
      const withLabels = toBackendUpdateBody({ labels: ["prod", "qa"] } as never)
      expect(withLabels).toEqual({ labels: ["prod", "qa"] })

      const cleared = toBackendUpdateBody({ labels: [] } as never)
      expect(cleared).toEqual({ labels: [] })
    })

    it("[tag:kb-mappers] omits chunkOptions when chunking_config.options is absent", () => {
      const body = toBackendCreateBody({
        name: "New KB",
        chunking_config: { strategy: "recursive", chunk_size: 1000, overlap: 50 },
      } as never)

      expect("chunkOptions" in body).toBe(false)
    })

    it("[tag:kb-mappers] drops undefined fields and empty quantization options", () => {
      const body = toBackendUpdateBody({
        name: "Only name",
        indexing_config: { quantization_options: { numPartitions: null } },
      } as never)

      expect(body).toEqual({ name: "Only name" })
      expect("quantizationOptions" in body).toBe(false)
      expect("description" in body).toBe(false)
    })

    it("[tag:kb-mappers] maps the remaining chunking/index/quant enum values", () => {
      const body = toBackendCreateBody({
        name: "n",
        chunking_config: { strategy: "hierarchical" },
        indexing_config: { index_type: "vector_only", vector_quantization: "ivf_rq" },
      } as never)

      expect(body).toMatchObject({
        chunkStrategy: "markdown",
        indexingMode: "semantic",
        quantizationType: "ivf_rq",
      })
    })

    it("[tag:kb-mappers] forwards text_columns as textColumns for structured datasets", () => {
      const body = toBackendCreateBody({
        name: "n",
        dataset_id: "dset-9",
        text_columns: "title, content",
      } as never)

      expect(body).toMatchObject({ textColumns: "title, content" })
    })

    it("[tag:kb-mappers] drops textColumns when text_columns is absent", () => {
      const body = toBackendCreateBody({ name: "n" } as never)
      expect("textColumns" in body).toBe(false)
    })
  })
})
