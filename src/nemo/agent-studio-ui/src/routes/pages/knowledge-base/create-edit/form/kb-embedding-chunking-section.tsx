import { useEffect, useRef, type ReactElement } from 'react';

import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import type { KBChunkingStrategy } from '@/api/kb.types';
import { useStore } from '@tanstack/react-store';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { SelectDropdownField } from '@/ui-lib/base-components/form/form-field.select-dropdown';
import { SliderField } from '@/ui-lib/base-components/form';

import {
  KB_CHUNKING_STRATEGY_OPTIONS,
  KB_CHUNKING_STRATEGY_DEFAULTS,
} from './kb-form.consts';
import { useKbEmbeddingModelOptions } from './use-kb-embedding-model-options';

interface KBEmbeddingChunkingSectionProps {
  form: AnyReactFormApi;
}

/** Strategy-specific slider config for the "size" field */
const STRATEGY_SIZE_CONFIG: Record<KBChunkingStrategy, { label: string; name: string; min: number; max: number; step: number }> = {
  chunk_by_character: { label: 'Chunk size', name: 'chunk_size', min: 100, max: 2000, step: 10 },
  sentence: { label: 'Max sentences', name: 'max_sentences', min: 1, max: 20, step: 1 },
  recursive: { label: 'Max chunk size', name: 'chunk_size', min: 100, max: 2000, step: 10 },
  chunk_by_token: { label: 'Max tokens', name: 'max_tokens', min: 50, max: 1000, step: 10 },
  hierarchical: { label: 'Max chunk size', name: 'chunk_size', min: 100, max: 2000, step: 10 },
  semantic: { label: 'Chunk size', name: 'chunk_size', min: 100, max: 2000, step: 10 },
  none: { label: 'Chunk size', name: 'chunk_size', min: 100, max: 2000, step: 10 },
};

/** Strategy-specific slider config for the "overlap" field */
const STRATEGY_OVERLAP_CONFIG: Record<KBChunkingStrategy, { label: string; name: string; min: number; max: number; step: number } | null> = {
  chunk_by_character: { label: 'Chunk overlap', name: 'chunk_overlap', min: 0, max: 500, step: 10 },
  sentence: { label: 'Overlap sentences', name: 'overlap_sentences', min: 0, max: 10, step: 1 },
  recursive: null,
  chunk_by_token: { label: 'Token overlap', name: 'token_overlap', min: 0, max: 100, step: 5 },
  hierarchical: null,
  semantic: { label: 'Chunk overlap', name: 'chunk_overlap', min: 0, max: 500, step: 10 },
  none: null,
};

function KBEmbeddingChunkingSection({ form }: KBEmbeddingChunkingSectionProps): ReactElement {
  const { items: embeddingModelOptions, dimensionsByName } = useKbEmbeddingModelOptions();
  const embeddingModel = useStore(form.store, (s) => s.values.embedding_model);
  const embeddingDimensions = useStore(form.store, (s) => s.values.embedding_dimensions);
  const chunkingStrategy = useStore(form.store, (s) => s.values.chunking_strategy) as KBChunkingStrategy;

  const prevStrategyRef = useRef<KBChunkingStrategy | null>(null);

  useEffect(() => {
    const suggestedDimensions = dimensionsByName[embeddingModel];
    if (suggestedDimensions) {
      form.setFieldValue('embedding_dimensions', suggestedDimensions);
    }
  }, [embeddingModel, dimensionsByName, form]);

  useEffect(() => {
    if (prevStrategyRef.current !== null && prevStrategyRef.current !== chunkingStrategy) {
      const defaults = KB_CHUNKING_STRATEGY_DEFAULTS[chunkingStrategy];
      if (defaults) {
        form.setFieldValue('chunk_size', defaults.chunk_size);
        form.setFieldValue('chunk_overlap', defaults.chunk_overlap);
        form.setFieldValue('max_sentences', defaults.max_sentences);
        form.setFieldValue('overlap_sentences', defaults.overlap_sentences);
        form.setFieldValue('max_tokens', defaults.max_tokens);
        form.setFieldValue('token_overlap', defaults.token_overlap);
      }
    }
    prevStrategyRef.current = chunkingStrategy;
  }, [chunkingStrategy, form]);

  const sizeConfig = STRATEGY_SIZE_CONFIG[chunkingStrategy] ?? STRATEGY_SIZE_CONFIG.chunk_by_character;
  const overlapConfig = STRATEGY_OVERLAP_CONFIG[chunkingStrategy];

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Embedding & chunking configuration
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Select how documents are split, normalized, and filtered before indexing.
        </Typography>
      </div>

      <div className="dset-form__fields">
        <div className="dset-form__field">
          <SelectDropdownField
            form={form}
            name="embedding_model"
            label="Embedding model"
            items={embeddingModelOptions}
            placeholder="Select embedding model"
            size="fill"
            options={{
              isMultiSelect: false,
              isSearchable: true,
            }}
          />
        </div>

        <div className="dset-form__field">
          <Typography Component="span" fontSize="fs14" boldness="regular" className="kb-embedding-dimensions">
            Embedding dimensions - {embeddingDimensions}
          </Typography>
        </div>

        <div className="dset-form__field">
          <SelectDropdownField
            form={form}
            name="chunking_strategy"
            label="Chunking strategy"
            items={KB_CHUNKING_STRATEGY_OPTIONS}
            placeholder="Select strategy"
            size="fill"
            options={{
              isMultiSelect: false,
              isSearchable: true,
            }}
          />
        </div>

        <div className="dset-form__field">
          <SliderField
            form={form}
            name={sizeConfig.name}
            label={sizeConfig.label}
            min={sizeConfig.min}
            max={sizeConfig.max}
            step={sizeConfig.step}
            isShowLimits={true}
            isShowCurrent={true}
            isEditInput={true}
          />
        </div>

        {overlapConfig && (
          <div className="dset-form__field">
            <SliderField
              form={form}
              name={overlapConfig.name}
              label={overlapConfig.label}
              min={overlapConfig.min}
              max={overlapConfig.max}
              step={overlapConfig.step}
              isShowLimits={true}
              isShowCurrent={true}
              isEditInput={true}
            />
          </div>
        )}
      </div>
    </section>
  );
}

export { KBEmbeddingChunkingSection };
export type { KBEmbeddingChunkingSectionProps };
