import type { ScheduleType } from '@/api/dataset.types';
import type {
  KBChunkOptions,
  KBCreateRequest,
  KBDetail,
  KBQuantizationOptions,
  KBSynchronizationConfig,
  KBUpdateRequest,
} from '@/api/kb.types';
import { toBuilderScheduleType } from '@/routes/pages/data-management/dataset/create-edit/form/dataset-form.utils';

import {
  KB_DEFAULT_EMBEDDING_DIMENSIONS,
  KB_DEFAULT_EMBEDDING_MODEL,
  KB_CHUNKING_STRATEGY_DEFAULTS,
  type KBFormValues,
} from './kb-form.consts';

const KB_HOURLY_MIN_MINUTES = 120;

function parseTimeOfDay(tod: string | null): { hour: number; minute: number } {
  if (!tod) {
    return { hour: 0, minute: 0 };
  }
  const parts = tod.split(':');
  /* v8 ignore start -- fallback for malformed time-of-day strings */
  return {
    hour: Number(parts[0]) || 0,
    minute: Number(parts[1]) || 0,
  };
  /* v8 ignore stop */
}

function defaultKbSchedule(): KBFormValues['kb_schedule'] {
  return {
    sync_schedule_mode: 'builder',
    refresh_config: {
      schedule_type: 'daily',
      interval_minutes: KB_HOURLY_MIN_MINUTES,
      time_of_day_hour: 0,
      time_of_day_minute: 0,
      day_of_week: [],
      day_of_month: 1,
      cron_expression: '',
    },
  };
}

function kbScheduleFromSync(sync: KBSynchronizationConfig | undefined): KBFormValues['kb_schedule'] {
  if (!sync) {
    return defaultKbSchedule();
  }
  const isCronFromApi = sync.schedule_type === 'cron';
  const tod = parseTimeOfDay(sync.time_of_day ?? null);
  return {
    sync_schedule_mode: isCronFromApi ? 'cron' : 'builder',
    refresh_config: {
      schedule_type: toBuilderScheduleType(sync.schedule_type ?? undefined),
      interval_minutes: sync.interval_minutes ?? KB_HOURLY_MIN_MINUTES,
      time_of_day_hour: tod.hour,
      time_of_day_minute: tod.minute,
      day_of_week: sync.day_of_week ?? [],
      day_of_month: sync.day_of_month ?? 1,
      cron_expression: sync.cron_expression ?? '',
    },
  };
}

export function buildKBDefaultValues(initialData?: KBDetail): KBFormValues {
  const defaultStrategy = 'chunk_by_character';
  const strategyDefaults = KB_CHUNKING_STRATEGY_DEFAULTS[defaultStrategy];

  if (initialData) {
    const sync = initialData.synchronization_config;
    const strategy = initialData.chunking_config?.strategy ?? defaultStrategy;
    const defaults = KB_CHUNKING_STRATEGY_DEFAULTS[strategy] ?? strategyDefaults;
    return {
      name: initialData.name,
      description: initialData.description ?? '',
      labels: initialData.labels ?? [],
      use_pipeline: initialData.use_pipeline ?? false,
      dataset_id: initialData.assigned_dataset?.dset_id ?? '',
      text_columns: initialData.text_columns ?? '',
      sync_mode: sync?.sync_mode ?? 'manual',
      kb_schedule: kbScheduleFromSync(sync),
      data_change_threshold_enabled: sync?.data_change_threshold_enabled ?? false,
      data_change_threshold_value:
        sync?.data_change_threshold_value != null && sync.data_change_threshold_value > 0
          ? String(sync.data_change_threshold_value)
          : '',
      embedding_model: initialData.embedding_config?.model ?? KB_DEFAULT_EMBEDDING_MODEL,
      embedding_dimensions: initialData.embedding_config?.dimensions ?? KB_DEFAULT_EMBEDDING_DIMENSIONS,
      chunking_strategy: strategy,
      ...resolveChunkSizeAndOverlap(initialData.chunking_config, strategy, defaults),
      // Prefer the strategy-specific `options` (the correct shape); fall back to the
      // legacy behavior of reading chunk_size/overlap for KBs persisted before options
      // were wired up, then to the strategy defaults.
      max_sentences: strategy === 'sentence'
        ? (initialData.chunking_config?.options?.maxSentences
          ?? initialData.chunking_config?.chunk_size
          ?? defaults.max_sentences)
        : defaults.max_sentences,
      overlap_sentences: strategy === 'sentence'
        ? (initialData.chunking_config?.options?.overlapSentences
          ?? initialData.chunking_config?.overlap
          ?? defaults.overlap_sentences)
        : defaults.overlap_sentences,
      max_tokens: strategy === 'chunk_by_token'
        ? (initialData.chunking_config?.options?.maxTokens
          ?? initialData.chunking_config?.chunk_size
          ?? defaults.max_tokens)
        : defaults.max_tokens,
      token_overlap: strategy === 'chunk_by_token'
        ? (initialData.chunking_config?.options?.tokenOverlap
          ?? initialData.chunking_config?.overlap
          ?? defaults.token_overlap)
        : defaults.token_overlap,
      index_type: initialData.indexing_config?.index_type ?? 'hybrid_search',
      vector_quantization: initialData.indexing_config?.vector_quantization ?? 'auto',
      quant_num_partitions: initialData.indexing_config?.quantization_options?.numPartitions?.toString() ?? '',
      quant_num_sub_vectors: initialData.indexing_config?.quantization_options?.numSubVectors?.toString() ?? '',
      quant_ef_construction: initialData.indexing_config?.quantization_options?.efConstruction?.toString() ?? '',
      quant_m: initialData.indexing_config?.quantization_options?.m?.toString() ?? '',
      quant_num_bits: initialData.indexing_config?.quantization_options?.numBits?.toString() ?? '',
      vector_index_configuration: initialData.indexing_config?.vector_index_configuration ?? 'hnsw',
    };
  }

  return {
    name: '',
    description: '',
    labels: [],
    use_pipeline: false,
    dataset_id: '',
    text_columns: '',
    sync_mode: 'manual',
    kb_schedule: defaultKbSchedule(),
    data_change_threshold_enabled: false,
    data_change_threshold_value: '',
    embedding_model: KB_DEFAULT_EMBEDDING_MODEL,
    embedding_dimensions: KB_DEFAULT_EMBEDDING_DIMENSIONS,
    chunking_strategy: defaultStrategy,
    chunk_size: strategyDefaults.chunk_size,
    chunk_overlap: strategyDefaults.chunk_overlap,
    max_sentences: strategyDefaults.max_sentences,
    overlap_sentences: strategyDefaults.overlap_sentences,
    max_tokens: strategyDefaults.max_tokens,
    token_overlap: strategyDefaults.token_overlap,
    index_type: 'hybrid_search',
    vector_quantization: 'auto',
    quant_num_partitions: '',
    quant_num_sub_vectors: '',
    quant_ef_construction: '',
    quant_m: '',
    quant_num_bits: '',
    vector_index_configuration: 'hnsw',
  };
}

function toInt(v: unknown): number {
  const n = Math.trunc(Number(v));
  /* v8 ignore start -- NaN fallback for non-numeric input */
  return Number.isNaN(n) ? 0 : n;
  /* v8 ignore stop */
}

function padTwo(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Resolve the real character-based `chunk_size`/`chunk_overlap` to hydrate into the
 * form for a given persisted chunking config.
 *
 * For `sentence`/`chunk_by_token`, KBs persisted *before* `chunkOptions` existed have
 * their `chunk_size`/`overlap` fields holding the misrouted max-sentences/max-tokens
 * values (e.g. `5`/`1`) instead of a real character size — and since the UI doesn't
 * expose chunk_size/overlap sliders for those strategies, blindly round-tripping that
 * stale value back out would silently corrupt the backend's `maxSentenceChars`
 * fallback (which defaults to `chunk_size`) on the next save. Once `options` is
 * present (i.e. the KB was saved after this fix), `chunk_size`/`overlap` reliably
 * hold the real value, so they're safe to read as-is.
 */
function resolveChunkSizeAndOverlap(
  chunkingConfig: KBDetail['chunking_config'],
  strategy: KBFormValues['chunking_strategy'],
  defaults: { chunk_size: number; chunk_overlap: number },
): { chunk_size: number; chunk_overlap: number } {
  const isLegacyProne = strategy === 'sentence' || strategy === 'chunk_by_token';
  const hasOptions = chunkingConfig?.options != null;

  if (isLegacyProne && !hasOptions) {
    return { chunk_size: defaults.chunk_size, chunk_overlap: defaults.chunk_overlap };
  }

  return {
    chunk_size: chunkingConfig?.chunk_size ?? defaults.chunk_size,
    chunk_overlap: chunkingConfig?.overlap ?? defaults.chunk_overlap,
  };
}

/**
 * Maps schedule UI state into `KBSynchronizationConfig` for create/update payloads.
 * Omits schedule fields when `sync_mode` is not `scheduled`.
 */
export function buildKBSynchronizationConfigPayload(values: KBFormValues): KBSynchronizationConfig {
  const thresholdEnabled = values.data_change_threshold_enabled;
  const thresholdRaw = values.data_change_threshold_value;
  const thresholdNum =
    thresholdEnabled && thresholdRaw !== '' && Number.isFinite(Number(thresholdRaw))
      ? Math.trunc(Number(thresholdRaw))
      : null;

  const base: KBSynchronizationConfig = {
    sync_mode: values.sync_mode,
    data_change_threshold_enabled: thresholdEnabled,
    data_change_threshold_value: thresholdEnabled ? thresholdNum : null,
  };

  if (values.sync_mode !== 'scheduled') {
    return {
      ...base,
      schedule_type: null,
      interval_minutes: null,
      time_of_day: null,
      day_of_week: null,
      day_of_month: null,
      timezone: null,
      cron_expression: null,
    };
  }

  const kbSched = values.kb_schedule;
  const rc = kbSched.refresh_config;

  if (kbSched.sync_schedule_mode === 'cron') {
    /* v8 ignore start -- nullish fallback for missing cron expression */
    const expression = (rc.cron_expression ?? '').trim();
    /* v8 ignore stop */
    return {
      ...base,
      schedule_type: 'cron',
      interval_minutes: null,
      time_of_day: null,
      day_of_week: null,
      day_of_month: null,
      timezone: 'UTC',
      cron_expression: expression || null,
    };
  }

  const st = toBuilderScheduleType(rc.schedule_type) as ScheduleType;
  const th = toInt(rc.time_of_day_hour);
  const tmin = toInt(rc.time_of_day_minute);
  const timeOfDay = `${padTwo(th)}:${padTwo(tmin)}`;

  if (st === 'hourly') {
    return {
      ...base,
      schedule_type: 'hourly',
      interval_minutes: toInt(rc.interval_minutes),
      time_of_day: null,
      day_of_week: null,
      day_of_month: null,
      timezone: 'UTC',
      cron_expression: null,
    };
  }

  return {
    ...base,
    schedule_type: st,
    interval_minutes: null,
    time_of_day: timeOfDay,
    day_of_week: st === 'weekly' ? rc.day_of_week : null,
    day_of_month: st === 'monthly' ? toInt(rc.day_of_month) : null,
    timezone: 'UTC',
    cron_expression: null,
  };
}

/**
 * Build the strategy-specific `chunkOptions` knobs sent alongside `chunk_size`/`overlap`.
 * - Fixed / Recursive: no strategy-specific knobs — chunk_size/overlap fully describe them.
 * - Sentence: maxSentences + overlapSentences (chunk_size/overlap are unused by the processor
 *   for sizing, but chunk_size still serves as the `maxSentenceChars` fallback).
 * - Token: maxTokens + tokenOverlap (chunk_size/overlap are ignored entirely by the processor).
 * - Markdown: splitOnHeaders (chunk_size/overlap are used directly for section sizing).
 */
function buildChunkOptionsPayload(values: KBFormValues): KBChunkOptions | undefined {
  switch (values.chunking_strategy) {
    case 'sentence':
      return {
        maxSentences: values.max_sentences,
        overlapSentences: values.overlap_sentences,
      };
    case 'chunk_by_token':
      return {
        maxTokens: values.max_tokens,
        tokenOverlap: values.token_overlap,
      };
    case 'hierarchical':
      return { splitOnHeaders: true };
    default:
      return undefined;
  }
}

/**
 * Build chunk_size, overlap, and strategy-specific options based on the active
 * chunking strategy. `chunk_size`/`overlap` always carry the real character-based
 * values from the form; strategy-specific knobs (max sentences, max tokens, etc.)
 * are carried separately in `options` so the backend's `chunkOptions` receives them.
 */
function buildChunkingConfigPayload(values: KBFormValues): {
  strategy: typeof values.chunking_strategy;
  chunk_size: number;
  overlap: number;
  options?: KBChunkOptions;
} {
  return {
    strategy: values.chunking_strategy,
    chunk_size: values.chunk_size,
    overlap: values.chunk_overlap,
    options: buildChunkOptionsPayload(values),
  };
}

function buildQuantizationOptions(values: KBFormValues): KBQuantizationOptions | undefined {
  const strategy = values.vector_quantization;
  
  if (strategy === 'auto' || strategy === 'none') {
    return undefined;
  }

  const parseNum = (val: string): number | undefined => {
    const n = parseInt(val, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  switch (strategy) {
    case 'ivf_pq':
      return {
        numPartitions: parseNum(values.quant_num_partitions),
        numSubVectors: parseNum(values.quant_num_sub_vectors),
      };
    case 'scalar':
      return {
        efConstruction: parseNum(values.quant_ef_construction),
        m: parseNum(values.quant_m),
        numPartitions: parseNum(values.quant_num_partitions),
      };
    case 'ivf_rq':
      return {
        numBits: parseNum(values.quant_num_bits),
        numPartitions: parseNum(values.quant_num_partitions),
      };
    default:
      return undefined;
  }
}

function buildIndexingConfigPayload(values: KBFormValues): KBCreateRequest['indexing_config'] {
  return {
    index_type: values.index_type,
    vector_quantization: values.vector_quantization,
    quantization_options: buildQuantizationOptions(values),
    vector_index_configuration: values.vector_index_configuration,
  };
}

export function buildKBCreatePayload(values: KBFormValues): KBCreateRequest {
  return {
    name: values.name.trim(),
    dataset_id: values.dataset_id.trim(),
    description: values.description.trim() || undefined,
    labels: (values.labels as string[]).length > 0 ? (values.labels as string[]) : undefined,
    use_pipeline: values.use_pipeline,
    synchronization_config: buildKBSynchronizationConfigPayload(values),
    embedding_config: {
      model: values.embedding_model,
      dimensions: values.embedding_dimensions,
    },
    chunking_config: buildChunkingConfigPayload(values),
    indexing_config: buildIndexingConfigPayload(values),
    text_columns: values.text_columns.trim() || undefined,
  };
}

export function buildKBEditDelta(values: KBFormValues, initialData: KBDetail): KBUpdateRequest {
  const delta: KBUpdateRequest = {};
  const baseline = buildKBDefaultValues(initialData);

  const newName = values.name.trim();
  const oldName = baseline.name.trim();
  if (newName && newName !== oldName) {
    delta.name = newName;
  }

  const newDescription = values.description || undefined;
  const oldDescription = baseline.description || undefined;
  if (newDescription !== oldDescription) {
    delta.description = newDescription;
  }

  const newLabels = [...(values.labels as string[])].sort();
  const oldLabels = [...(baseline.labels as string[])].sort();
  if (JSON.stringify(newLabels) !== JSON.stringify(oldLabels)) {
    delta.labels = values.labels as string[];
  }

  const newTextColumns = values.text_columns.trim() || undefined;
  const oldTextColumns = baseline.text_columns.trim() || undefined;
  if (newTextColumns !== oldTextColumns) {
    delta.text_columns = newTextColumns;
  }

  // Normalize values before comparison so that string-vs-number drift from HTML
  // text inputs (e.g. interval_minutes: "120" vs 120) does not produce a false delta.
  const normalizedValues = normalizeFormValues(values);
  const normalizedBaseline = normalizeFormValues(baseline);

  const newSync = buildKBSynchronizationConfigPayload(normalizedValues);
  const oldSync = buildKBSynchronizationConfigPayload(normalizedBaseline);
  if (JSON.stringify(newSync) !== JSON.stringify(oldSync)) {
    delta.synchronization_config = newSync;
  }

  const newEmb = { model: normalizedValues.embedding_model, dimensions: normalizedValues.embedding_dimensions };
  const oldEmb = { model: normalizedBaseline.embedding_model, dimensions: normalizedBaseline.embedding_dimensions };
  if (JSON.stringify(newEmb) !== JSON.stringify(oldEmb)) {
    delta.embedding_config = newEmb;
  }

  const newChunk = buildChunkingConfigPayload(normalizedValues);
  const oldChunk = buildChunkingConfigPayload(normalizedBaseline);
  if (JSON.stringify(newChunk) !== JSON.stringify(oldChunk)) {
    delta.chunking_config = newChunk;
  }

  const newIdx = buildIndexingConfigPayload(normalizedValues);
  const oldIdx = buildIndexingConfigPayload(normalizedBaseline);
  if (JSON.stringify(newIdx) !== JSON.stringify(oldIdx)) {
    delta.indexing_config = newIdx;
  }

  return delta;
}

/**
 * Coerce numeric form fields to numbers so that HTML input string drift
 * (e.g. interval_minutes: "120" instead of 120) doesn't create false deltas.
 */
function normalizeFormValues(v: KBFormValues): KBFormValues {
  return {
    ...v,
    embedding_dimensions: toInt(v.embedding_dimensions),
    chunk_size: toInt(v.chunk_size),
    chunk_overlap: toInt(v.chunk_overlap),
    max_sentences: toInt(v.max_sentences),
    overlap_sentences: toInt(v.overlap_sentences),
    max_tokens: toInt(v.max_tokens),
    token_overlap: toInt(v.token_overlap),
    kb_schedule: {
      ...v.kb_schedule,
      refresh_config: {
        ...v.kb_schedule.refresh_config,
        interval_minutes: toInt(v.kb_schedule.refresh_config.interval_minutes),
        time_of_day_hour: toInt(v.kb_schedule.refresh_config.time_of_day_hour),
        time_of_day_minute: toInt(v.kb_schedule.refresh_config.time_of_day_minute),
        day_of_month: toInt(v.kb_schedule.refresh_config.day_of_month),
      },
    },
  };
}

export { KB_HOURLY_MIN_MINUTES };
