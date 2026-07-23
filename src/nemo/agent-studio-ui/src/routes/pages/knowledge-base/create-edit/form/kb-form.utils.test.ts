import { describe, it, expect } from "vitest";

import type { KBDetail } from "@/api/kb.types";
import type { KBFormValues } from "./kb-form.consts";
import {
  buildKBDefaultValues,
  buildKBSynchronizationConfigPayload,
  buildKBCreatePayload,
  buildKBEditDelta,
  KB_HOURLY_MIN_MINUTES,
} from "./kb-form.utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaults(overrides: Partial<KBFormValues> = {}): KBFormValues {
  return { ...buildKBDefaultValues(), ...overrides };
}

function makeKBDetail(overrides: Partial<KBDetail> = {}): KBDetail {
  return {
    kb_id: "kb-1",
    name: "Test KB",
    status: "ready",
    deprecated: false,
    labels: ["production"],
    created_at: "2024-01-01T00:00:00Z",
    synchronization_config: {
      sync_mode: "scheduled",
      schedule_type: "daily",
      time_of_day: "08:30",
      interval_minutes: null,
      day_of_week: null,
      day_of_month: null,
      timezone: "UTC",
      cron_expression: null,
      data_change_threshold_enabled: true,
      data_change_threshold_value: 5,
    },
    embedding_config: {
      model: "sentence-transformers/all-MiniLM-L6-v2",
      dimensions: 384,
    },
    chunking_config: {
      strategy: "sentence",
      chunk_size: 300,
      overlap: 30,
    },
    indexing_config: {
      index_type: "hybrid_search",
      vector_quantization: "none",
      vector_index_configuration: "hnsw",
    },
    assigned_dataset: {
      dset_id: "ds-42",
      name: "My Dataset",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// KB_HOURLY_MIN_MINUTES
// ---------------------------------------------------------------------------

describe("KB_HOURLY_MIN_MINUTES", () => {
  it("[tag:kb][tag:form-utils] equals 120", () => {
    expect(KB_HOURLY_MIN_MINUTES).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// buildKBDefaultValues
// ---------------------------------------------------------------------------

describe("buildKBDefaultValues", () => {
  it("[tag:kb][tag:form-utils] returns blank defaults when no initialData", () => {
    const vals = buildKBDefaultValues();

    expect(vals.name).toBe("");
    expect(vals.description).toBe("");
    expect(vals.labels).toEqual([]);
    expect(vals.dataset_id).toBe("");
    expect(vals.text_columns).toBe("");
    expect(vals.sync_mode).toBe("manual");
    expect(vals.embedding_model).toBe("sentence-transformers/all-MiniLM-L6-v2");
    expect(vals.chunking_strategy).toBe("chunk_by_character");
    expect(vals.data_change_threshold_enabled).toBe(false);
    expect(vals.data_change_threshold_value).toBe("");
  });

  it("[tag:kb][tag:form-utils] populates values from full initialData", () => {
    const detail = makeKBDetail();
    const vals = buildKBDefaultValues(detail);

    expect(vals.name).toBe("Test KB");
    expect(vals.labels).toEqual(["production"]);
    expect(vals.dataset_id).toBe("ds-42");
    expect(vals.sync_mode).toBe("scheduled");
    expect(vals.data_change_threshold_enabled).toBe(true);
    expect(vals.data_change_threshold_value).toBe("5");
  });

  it("[tag:kb][tag:form-utils] populates text_columns from a structured KB's initialData", () => {
    const detail = makeKBDetail({ text_columns: "title, content" });
    const vals = buildKBDefaultValues(detail);

    expect(vals.text_columns).toBe("title, content");
  });

  it("[tag:kb][tag:form-utils] text_columns defaults to empty string when absent from initialData", () => {
    const vals = buildKBDefaultValues(makeKBDetail());
    expect(vals.text_columns).toBe("");
  });

  it("[tag:kb][tag:form-utils] handles partial initialData gracefully", () => {
    const detail = makeKBDetail({
      description: null,
      synchronization_config: undefined,
      embedding_config: undefined,
      chunking_config: undefined,
      indexing_config: undefined,
      assigned_dataset: undefined,
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.description).toBe("");
    expect(vals.dataset_id).toBe("");
    expect(vals.sync_mode).toBe("manual");
  });

  it("[tag:kb][tag:form-utils] maps cron schedule from API to cron mode", () => {
    const detail = makeKBDetail({
      synchronization_config: {
        sync_mode: "scheduled",
        schedule_type: "cron",
        cron_expression: "0 3 * * *",
      },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.kb_schedule.sync_schedule_mode).toBe("cron");
    expect(vals.kb_schedule.refresh_config.cron_expression).toBe("0 3 * * *");
  });

  it("[tag:kb][tag:form-utils] maps daily schedule from API to builder mode", () => {
    const detail = makeKBDetail({
      synchronization_config: {
        sync_mode: "scheduled",
        schedule_type: "daily",
        time_of_day: "14:30",
      },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.kb_schedule.sync_schedule_mode).toBe("builder");
    expect(vals.kb_schedule.refresh_config.schedule_type).toBe("daily");
    expect(vals.kb_schedule.refresh_config.time_of_day_hour).toBe(14);
    expect(vals.kb_schedule.refresh_config.time_of_day_minute).toBe(30);
  });

  it("[tag:kb][tag:form-utils] threshold_value is empty when 0 or null", () => {
    const detail = makeKBDetail({
      synchronization_config: {
        sync_mode: "manual",
        data_change_threshold_enabled: false,
        data_change_threshold_value: 0,
      },
    });
    const vals = buildKBDefaultValues(detail);
    expect(vals.data_change_threshold_value).toBe("");
  });

  it("[tag:kb][tag:form-utils] maps sentence strategy fields from backend chunking config", () => {
    const detail = makeKBDetail({
      chunking_config: { strategy: "sentence", chunk_size: 12, overlap: 2 },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.chunking_strategy).toBe("sentence");
    expect(vals.max_sentences).toBe(12);
    expect(vals.overlap_sentences).toBe(2);
  });

  it("[tag:kb][tag:form-utils] normalizes legacy chunk_size/overlap to strategy defaults for sentence strategy (options absent)", () => {
    // Pre-fix KBs persisted the misrouted max-sentences values (e.g. 12/2) into
    // chunk_size/overlap. Since the UI has no chunk_size/overlap sliders for the
    // sentence strategy, these must be normalized back to the real defaults rather
    // than round-tripped as an invalid character-based chunk_size.
    const detail = makeKBDetail({
      chunking_config: { strategy: "sentence", chunk_size: 12, overlap: 2 },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.chunk_size).toBe(512);
    expect(vals.chunk_overlap).toBe(50);
  });

  it("[tag:kb][tag:form-utils] maps token strategy fields from backend chunking config", () => {
    const detail = makeKBDetail({
      chunking_config: { strategy: "chunk_by_token", chunk_size: 512, overlap: 64 },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.chunking_strategy).toBe("chunk_by_token");
    expect(vals.max_tokens).toBe(512);
    expect(vals.token_overlap).toBe(64);
  });

  it("[tag:kb][tag:form-utils] normalizes legacy chunk_size/overlap to strategy defaults for token strategy (options absent)", () => {
    const detail = makeKBDetail({
      chunking_config: { strategy: "chunk_by_token", chunk_size: 8, overlap: 1 },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.chunk_size).toBe(512);
    expect(vals.chunk_overlap).toBe(50);
  });

  it("[tag:kb][tag:form-utils] prefers options over legacy chunk_size/overlap for sentence strategy", () => {
    const detail = makeKBDetail({
      chunking_config: {
        strategy: "sentence",
        chunk_size: 600,
        overlap: 55,
        options: { maxSentences: 9, overlapSentences: 3 },
      },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.max_sentences).toBe(9);
    expect(vals.overlap_sentences).toBe(3);
    // Once `options` is present, chunk_size/overlap hold the real character
    // values (not the legacy misrouted ones), so they should be read as-is.
    expect(vals.chunk_size).toBe(600);
    expect(vals.chunk_overlap).toBe(55);
  });

  it("[tag:kb][tag:form-utils] prefers options over legacy chunk_size/overlap for token strategy", () => {
    const detail = makeKBDetail({
      chunking_config: {
        strategy: "chunk_by_token",
        chunk_size: 600,
        overlap: 55,
        options: { maxTokens: 128, tokenOverlap: 16 },
      },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.max_tokens).toBe(128);
    expect(vals.token_overlap).toBe(16);
    expect(vals.chunk_size).toBe(600);
    expect(vals.chunk_overlap).toBe(55);
  });

  it("[tag:kb][tag:form-utils] maps quantization tuning fields from indexing config", () => {
    const detail = makeKBDetail({
      indexing_config: {
        index_type: "hybrid_search",
        vector_quantization: "ivf_pq",
        vector_index_configuration: "hnsw",
        quantization_options: {
          numPartitions: 128,
          numSubVectors: 48,
        },
      },
    });
    const vals = buildKBDefaultValues(detail);

    expect(vals.vector_quantization).toBe("ivf_pq");
    expect(vals.quant_num_partitions).toBe("128");
    expect(vals.quant_num_sub_vectors).toBe("48");
  });
});

// ---------------------------------------------------------------------------
// buildKBSynchronizationConfigPayload
// ---------------------------------------------------------------------------

describe("buildKBSynchronizationConfigPayload", () => {
  it("[tag:kb][tag:form-utils] manual mode nulls out schedule fields", () => {
    const payload = buildKBSynchronizationConfigPayload(makeDefaults({ sync_mode: "manual" }));

    expect(payload.sync_mode).toBe("manual");
    expect(payload.schedule_type).toBeNull();
    expect(payload.interval_minutes).toBeNull();
    expect(payload.time_of_day).toBeNull();
    expect(payload.cron_expression).toBeNull();
  });

  it("[tag:kb][tag:form-utils] after_dataset_updates mode nulls out schedule fields", () => {
    const payload = buildKBSynchronizationConfigPayload(makeDefaults({ sync_mode: "after_dataset_updates" }));

    expect(payload.sync_mode).toBe("after_dataset_updates");
    expect(payload.schedule_type).toBeNull();
  });

  it("[tag:kb][tag:form-utils] scheduled + builder + hourly produces hourly payload", () => {
    const vals = makeDefaults({
      sync_mode: "scheduled",
      kb_schedule: {
        sync_schedule_mode: "builder",
        refresh_config: {
          schedule_type: "hourly",
          interval_minutes: 180,
          time_of_day_hour: 0,
          time_of_day_minute: 0,
          day_of_week: [],
          day_of_month: 1,
          cron_expression: "",
        },
      },
    });
    const payload = buildKBSynchronizationConfigPayload(vals);

    expect(payload.schedule_type).toBe("hourly");
    expect(payload.interval_minutes).toBe(180);
    expect(payload.time_of_day).toBeNull();
    expect(payload.day_of_week).toBeNull();
    expect(payload.timezone).toBe("UTC");
    expect(payload.cron_expression).toBeNull();
  });

  it("[tag:kb][tag:form-utils] scheduled + builder + daily produces daily payload", () => {
    const vals = makeDefaults({
      sync_mode: "scheduled",
      kb_schedule: {
        sync_schedule_mode: "builder",
        refresh_config: {
          schedule_type: "daily",
          interval_minutes: 120,
          time_of_day_hour: 8,
          time_of_day_minute: 30,
          day_of_week: [],
          day_of_month: 1,
          cron_expression: "",
        },
      },
    });
    const payload = buildKBSynchronizationConfigPayload(vals);

    expect(payload.schedule_type).toBe("daily");
    expect(payload.time_of_day).toBe("08:30");
    expect(payload.interval_minutes).toBeNull();
    expect(payload.day_of_week).toBeNull();
  });

  it("[tag:kb][tag:form-utils] scheduled + builder + weekly includes day_of_week", () => {
    const vals = makeDefaults({
      sync_mode: "scheduled",
      kb_schedule: {
        sync_schedule_mode: "builder",
        refresh_config: {
          schedule_type: "weekly",
          interval_minutes: 120,
          time_of_day_hour: 9,
          time_of_day_minute: 0,
          day_of_week: [1, 3, 5],
          day_of_month: 1,
          cron_expression: "",
        },
      },
    });
    const payload = buildKBSynchronizationConfigPayload(vals);

    expect(payload.schedule_type).toBe("weekly");
    expect(payload.day_of_week).toEqual([1, 3, 5]);
    expect(payload.day_of_month).toBeNull();
  });

  it("[tag:kb][tag:form-utils] scheduled + builder + monthly includes day_of_month", () => {
    const vals = makeDefaults({
      sync_mode: "scheduled",
      kb_schedule: {
        sync_schedule_mode: "builder",
        refresh_config: {
          schedule_type: "monthly",
          interval_minutes: 120,
          time_of_day_hour: 0,
          time_of_day_minute: 0,
          day_of_week: [],
          day_of_month: 15,
          cron_expression: "",
        },
      },
    });
    const payload = buildKBSynchronizationConfigPayload(vals);

    expect(payload.schedule_type).toBe("monthly");
    expect(payload.day_of_month).toBe(15);
    expect(payload.day_of_week).toBeNull();
  });

  it("[tag:kb][tag:form-utils] scheduled + cron produces cron payload", () => {
    const vals = makeDefaults({
      sync_mode: "scheduled",
      kb_schedule: {
        sync_schedule_mode: "cron",
        refresh_config: {
          schedule_type: "daily",
          interval_minutes: 120,
          time_of_day_hour: 0,
          time_of_day_minute: 0,
          day_of_week: [],
          day_of_month: 1,
          cron_expression: "0 3 * * *",
        },
      },
    });
    const payload = buildKBSynchronizationConfigPayload(vals);

    expect(payload.schedule_type).toBe("cron");
    expect(payload.cron_expression).toBe("0 3 * * *");
    expect(payload.interval_minutes).toBeNull();
    expect(payload.time_of_day).toBeNull();
    expect(payload.timezone).toBe("UTC");
  });

  it("[tag:kb][tag:form-utils] cron with empty expression produces null", () => {
    const vals = makeDefaults({
      sync_mode: "scheduled",
      kb_schedule: {
        sync_schedule_mode: "cron",
        refresh_config: {
          schedule_type: "daily",
          interval_minutes: 120,
          time_of_day_hour: 0,
          time_of_day_minute: 0,
          day_of_week: [],
          day_of_month: 1,
          cron_expression: "  ",
        },
      },
    });
    const payload = buildKBSynchronizationConfigPayload(vals);
    expect(payload.cron_expression).toBeNull();
  });

  it("[tag:kb][tag:form-utils] threshold enabled with valid value includes it", () => {
    const vals = makeDefaults({
      data_change_threshold_enabled: true,
      data_change_threshold_value: "10",
    });
    const payload = buildKBSynchronizationConfigPayload(vals);

    expect(payload.data_change_threshold_enabled).toBe(true);
    expect(payload.data_change_threshold_value).toBe(10);
  });

  it("[tag:kb][tag:form-utils] threshold disabled nulls out value", () => {
    const vals = makeDefaults({
      data_change_threshold_enabled: false,
      data_change_threshold_value: "10",
    });
    const payload = buildKBSynchronizationConfigPayload(vals);

    expect(payload.data_change_threshold_enabled).toBe(false);
    expect(payload.data_change_threshold_value).toBeNull();
  });

  it("[tag:kb][tag:form-utils] threshold enabled with empty value gives null", () => {
    const vals = makeDefaults({
      data_change_threshold_enabled: true,
      data_change_threshold_value: "",
    });
    const payload = buildKBSynchronizationConfigPayload(vals);
    expect(payload.data_change_threshold_value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildKBCreatePayload
// ---------------------------------------------------------------------------

describe("buildKBCreatePayload", () => {
  it("[tag:kb][tag:form-utils] builds a full create payload", () => {
    const vals = makeDefaults({
      name: "  My New KB  ",
      description: "  A description  ",
      dataset_id: " ds-1 ",
      labels: ["staging"],
    });
    const payload = buildKBCreatePayload(vals);

    expect(payload.name).toBe("My New KB");
    expect(payload.dataset_id).toBe("ds-1");
    expect(payload.description).toBe("A description");
    expect(payload.labels).toEqual(["staging"]);
    expect(payload.embedding_config.model).toBe("sentence-transformers/all-MiniLM-L6-v2");
    expect(payload.chunking_config).toBeDefined();
    expect(payload.indexing_config).toBeDefined();
    expect(payload.synchronization_config).toBeDefined();
  });

  it("[tag:kb][tag:form-utils] empty description becomes undefined", () => {
    const payload = buildKBCreatePayload(makeDefaults({ description: "  " }));
    expect(payload.description).toBeUndefined();
  });

  it("[tag:kb][tag:form-utils] empty labels becomes undefined", () => {
    const payload = buildKBCreatePayload(makeDefaults({ labels: [] }));
    expect(payload.labels).toBeUndefined();
  });

  it("[tag:kb][tag:form-utils] maps recursive chunking strategy to payload", () => {
    const payload = buildKBCreatePayload(makeDefaults({
      chunking_strategy: "recursive",
      chunk_size: 800,
      chunk_overlap: 80,
    }));

    expect(payload.chunking_config).toEqual({
      strategy: "recursive",
      chunk_size: 800,
      overlap: 80,
    });
  });

  it("[tag:kb][tag:form-utils] maps sentence chunking strategy to payload with chunkOptions", () => {
    const payload = buildKBCreatePayload(makeDefaults({
      chunking_strategy: "sentence",
      max_sentences: 8,
      overlap_sentences: 2,
    }));

    expect(payload.chunking_config).toEqual({
      strategy: "sentence",
      chunk_size: 512,
      overlap: 50,
      options: { maxSentences: 8, overlapSentences: 2 },
    });
  });

  it("[tag:kb][tag:form-utils] maps token chunking strategy to payload with chunkOptions", () => {
    const payload = buildKBCreatePayload(makeDefaults({
      chunking_strategy: "chunk_by_token",
      max_tokens: 256,
      token_overlap: 32,
    }));

    expect(payload.chunking_config).toEqual({
      strategy: "chunk_by_token",
      chunk_size: 512,
      overlap: 50,
      options: { maxTokens: 256, tokenOverlap: 32 },
    });
  });

  it("[tag:kb][tag:form-utils] maps hierarchical chunking strategy to payload with splitOnHeaders", () => {
    const payload = buildKBCreatePayload(makeDefaults({
      chunking_strategy: "hierarchical",
      chunk_size: 1200,
      chunk_overlap: 0,
    }));

    expect(payload.chunking_config).toEqual({
      strategy: "hierarchical",
      chunk_size: 1200,
      overlap: 0,
      options: { splitOnHeaders: true },
    });
  });

  it("[tag:kb][tag:form-utils] includes ivf_pq quantization options in indexing payload", () => {
    const payload = buildKBCreatePayload(makeDefaults({
      vector_quantization: "ivf_pq",
      quant_num_partitions: "256",
      quant_num_sub_vectors: "96",
    }));

    expect(payload.indexing_config?.quantization_options).toEqual({
      numPartitions: 256,
      numSubVectors: 96,
    });
  });

  it("[tag:kb][tag:form-utils] includes scalar quantization options in indexing payload", () => {
    const payload = buildKBCreatePayload(makeDefaults({
      vector_quantization: "scalar",
      quant_ef_construction: "150",
      quant_m: "16",
      quant_num_partitions: "32",
    }));

    expect(payload.indexing_config?.quantization_options).toEqual({
      efConstruction: 150,
      m: 16,
      numPartitions: 32,
    });
  });

  it("[tag:kb][tag:form-utils] includes ivf_rq quantization options in indexing payload", () => {
    const payload = buildKBCreatePayload(makeDefaults({
      vector_quantization: "ivf_rq",
      quant_num_bits: "4",
      quant_num_partitions: "64",
    }));

    expect(payload.indexing_config?.quantization_options).toEqual({
      numBits: 4,
      numPartitions: 64,
    });
  });

  it("[tag:kb][tag:form-utils] omits quantization options for auto and none strategies", () => {
    expect(buildKBCreatePayload(makeDefaults({ vector_quantization: "auto" })).indexing_config?.quantization_options)
      .toBeUndefined();
    expect(buildKBCreatePayload(makeDefaults({ vector_quantization: "none" })).indexing_config?.quantization_options)
      .toBeUndefined();
  });

  it("[tag:kb][tag:form-utils] includes trimmed text_columns for structured datasets", () => {
    const payload = buildKBCreatePayload(makeDefaults({ text_columns: "  title, content ,description  " }));
    expect(payload.text_columns).toBe("title, content ,description");
  });

  it("[tag:kb][tag:form-utils] omits text_columns when blank (unstructured datasets)", () => {
    const payload = buildKBCreatePayload(makeDefaults({ text_columns: "   " }));
    expect(payload.text_columns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildKBEditDelta
// ---------------------------------------------------------------------------

describe("buildKBEditDelta", () => {
  it("[tag:kb][tag:form-utils] returns empty object when nothing changed", () => {
    const detail = makeKBDetail();
    const vals = buildKBDefaultValues(detail);
    const delta = buildKBEditDelta(vals, detail);

    expect(delta).toEqual({});
  });

  it("[tag:kb][tag:form-utils] detects description change", () => {
    const detail = makeKBDetail({ description: "old" });
    const vals = buildKBDefaultValues(detail);
    vals.description = "new description";
    const delta = buildKBEditDelta(vals, detail);

    expect(delta.description).toBe("new description");
  });

  it("[tag:kb][tag:form-utils] detects labels change", () => {
    const detail = makeKBDetail({ labels: ["a"] });
    const vals = buildKBDefaultValues(detail);
    vals.labels = ["a", "b"];
    const delta = buildKBEditDelta(vals, detail);

    expect(delta.labels).toEqual(["a", "b"]);
  });

  it("[tag:kb][tag:form-utils] detects text_columns change", () => {
    const detail = makeKBDetail({ text_columns: "title" });
    const vals = buildKBDefaultValues(detail);
    vals.text_columns = "title, content";
    const delta = buildKBEditDelta(vals, detail);

    expect(delta.text_columns).toBe("title, content");
  });

  it("[tag:kb][tag:form-utils] omits text_columns from delta when unchanged", () => {
    const detail = makeKBDetail({ text_columns: "title" });
    const vals = buildKBDefaultValues(detail);
    const delta = buildKBEditDelta(vals, detail);

    expect(delta.text_columns).toBeUndefined();
  });

  it("[tag:kb][tag:form-utils] detects sync config change", () => {
    const detail = makeKBDetail();
    const vals = buildKBDefaultValues(detail);
    vals.sync_mode = "manual";
    const delta = buildKBEditDelta(vals, detail);

    expect(delta.synchronization_config).toBeDefined();
    expect(delta.synchronization_config!.sync_mode).toBe("manual");
  });

  it("[tag:kb][tag:form-utils] detects embedding config change", () => {
    const detail = makeKBDetail();
    const vals = buildKBDefaultValues(detail);
    vals.embedding_dimensions = 3072;
    const delta = buildKBEditDelta(vals, detail);

    expect(delta.embedding_config).toBeDefined();
    expect(delta.embedding_config!.dimensions).toBe(3072);
  });

  it("[tag:kb][tag:form-utils] detects chunking config change", () => {
    const detail = makeKBDetail();
    const vals = buildKBDefaultValues(detail);
    // For sentence strategy (which makeKBDetail uses), changes are made to max_sentences,
    // which is carried in chunkOptions rather than the raw chunk_size field.
    vals.max_sentences = 500;
    const delta = buildKBEditDelta(vals, detail);

    expect(delta.chunking_config).toBeDefined();
    expect(delta.chunking_config!.options!.maxSentences).toBe(500);
  });

  it("[tag:kb][tag:form-utils] detects indexing config change", () => {
    const detail = makeKBDetail();
    const vals = buildKBDefaultValues(detail);
    vals.vector_quantization = "scalar";
    const delta = buildKBEditDelta(vals, detail);

    expect(delta.indexing_config).toBeDefined();
    expect(delta.indexing_config!.vector_quantization).toBe("scalar");
  });
});
