import { describe, expect, it } from 'vitest';

import { KB_EMBEDDING_MODEL_OPTIONS } from './kb-form.consts';
import { mergeKbEmbeddingModelOptions } from './use-kb-embedding-model-options';

describe('mergeKbEmbeddingModelOptions', () => {
  it('[tag:kb][tag:embedding-options] keeps all built-in options when catalog is empty', () => {
    const { items } = mergeKbEmbeddingModelOptions(undefined);
    expect(items).toHaveLength(KB_EMBEDDING_MODEL_OPTIONS.length);
    expect(items[0]).toEqual(KB_EMBEDDING_MODEL_OPTIONS[0]);
  });

  it('[tag:kb][tag:embedding-options] skips built-in rows already in the static list', () => {
    const { items } = mergeKbEmbeddingModelOptions([
      {
        id: 'builtin-1',
        name: 'sentence-transformers/all-MiniLM-L6-v2',
        displayName: 'all-MiniLM-L6-v2 (Default)',
        isBuiltin: true,
        model_info: { dimensions: 384 },
      },
    ]);
    expect(items).toHaveLength(KB_EMBEDDING_MODEL_OPTIONS.length);
  });

  it('[tag:kb][tag:embedding-options] appends project-registered embedding models', () => {
    const { items, dimensionsByName } = mergeKbEmbeddingModelOptions([
      {
        id: 'mdl-remote-1',
        name: 'Text Embedding 3 Large',
        displayName: 'Text Embedding 3 Large',
        provider: 'openai',
        isBuiltin: false,
        model_info: { dimensions: 3072 },
      },
    ]);

    expect(items).toHaveLength(KB_EMBEDDING_MODEL_OPTIONS.length + 1);
    expect(items.at(-1)).toMatchObject({
      key: 'mdl-remote-1',
      value: 'Text Embedding 3 Large',
      label: 'Text Embedding 3 Large (openai)',
    });
    expect(dimensionsByName['Text Embedding 3 Large']).toBe(3072);
  });

  it('[tag:kb][tag:embedding-options] disables registered models with unknown dimensions', () => {
    const { items } = mergeKbEmbeddingModelOptions([
      {
        id: 'mdl-bad',
        name: 'Unknown Embed',
        displayName: 'Unknown Embed',
        provider: 'openai_compatible',
        isBuiltin: false,
      },
    ]);

    expect(items.at(-1)).toMatchObject({
      value: 'Unknown Embed',
      isDisabled: true,
    });
  });
});
