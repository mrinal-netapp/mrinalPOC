import { useMemo } from 'react';

import { useListProjectModelsQuery } from '@/routes/pages/agents/api/agents-config-api.slice';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import type { SelectDropdownItemData } from '@/ui-lib/base-components/select-dropdown/select-dropdown.types';

import {
  KB_EMBEDDING_MODEL_DIMENSIONS,
  KB_EMBEDDING_MODEL_OPTIONS,
} from './kb-form.consts';

/** Fields from config-service `Model` rows used to extend the KB embedding picker. */
export type KbEmbeddingCatalogRow = {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  isBuiltin?: boolean;
  model_info?: { dimensions?: number };
};

function readDimensions(row: KbEmbeddingCatalogRow): number | undefined {
  const dim = row.model_info?.dimensions;
  return typeof dim === 'number' && dim > 0 ? dim : undefined;
}

/**
 * Platform built-ins first, then project-registered embedding models that are
 * not already covered by the static catalog (matched by `Model.name`).
 */
export function mergeKbEmbeddingModelOptions(
  catalogRows: KbEmbeddingCatalogRow[] | undefined,
): { items: SelectDropdownItemData[]; dimensionsByName: Record<string, number> } {
  const dimensionsByName: Record<string, number> = { ...KB_EMBEDDING_MODEL_DIMENSIONS };
  const builtinNames = new Set(KB_EMBEDDING_MODEL_OPTIONS.map((option) => option.value));
  const items: SelectDropdownItemData[] = [...KB_EMBEDDING_MODEL_OPTIONS];

  for (const row of catalogRows ?? []) {
    const name = row.name?.trim();
    if (!name || builtinNames.has(name)) {
      continue;
    }

    const dimensions = readDimensions(row);
    if (dimensions !== undefined) {
      dimensionsByName[name] = dimensions;
    }

    const label = row.displayName?.trim() || name;
    const providerSuffix =
      row.provider && row.isBuiltin !== true ? ` (${row.provider})` : '';

    items.push({
      key: row.id || name,
      value: name,
      label: `${label}${providerSuffix}`,
      ...(dimensions === undefined ? { isDisabled: true } : {}),
    });
  }

  return { items, dimensionsByName };
}

export function useKbEmbeddingModelOptions(): {
  items: SelectDropdownItemData[];
  dimensionsByName: Record<string, number>;
  isLoading: boolean;
} {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: catalogRows, isLoading } = useListProjectModelsQuery(
    { projectId: projectId ?? '', modelType: 'embedding' },
    { skip: !projectId },
  );

  const merged = useMemo(
    () => mergeKbEmbeddingModelOptions(catalogRows as KbEmbeddingCatalogRow[] | undefined),
    [catalogRows],
  );

  return { ...merged, isLoading };
}
