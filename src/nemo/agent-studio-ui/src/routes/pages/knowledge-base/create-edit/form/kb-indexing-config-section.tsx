import { useEffect, useRef, type ReactElement } from 'react';

import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import type { KBVectorQuantization } from '@/api/kb.types';
import { useStore } from '@tanstack/react-store';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { SelectDropdownField } from '@/ui-lib/base-components/form/form-field.select-dropdown';
import { InputField } from '@/ui-lib/base-components/form/form-field.input';

import {
  KB_INDEX_TYPE_OPTIONS,
  KB_VECTOR_QUANTIZATION_OPTIONS,
  KB_QUANTIZATION_DEFAULTS,
} from './kb-form.consts';

interface KBIndexingConfigSectionProps {
  form: AnyReactFormApi;
}

function KBIndexingConfigSection({ form }: KBIndexingConfigSectionProps): ReactElement {
  const vectorQuantization = useStore(form.store, (s) => s.values.vector_quantization) as KBVectorQuantization;
  const prevQuantizationRef = useRef<KBVectorQuantization | null>(null);

  useEffect(() => {
    if (prevQuantizationRef.current !== null && prevQuantizationRef.current !== vectorQuantization) {
      const defaults = KB_QUANTIZATION_DEFAULTS[vectorQuantization];
      if (defaults) {
        form.setFieldValue('quant_num_partitions', defaults.numPartitions?.toString() ?? '');
        form.setFieldValue('quant_num_sub_vectors', defaults.numSubVectors?.toString() ?? '');
        form.setFieldValue('quant_ef_construction', defaults.efConstruction?.toString() ?? '');
        form.setFieldValue('quant_m', '');
        form.setFieldValue('quant_num_bits', defaults.numBits?.toString() ?? '');
      }
    }
    prevQuantizationRef.current = vectorQuantization;
  }, [vectorQuantization, form]);

  const renderQuantizationFields = (): ReactElement | null => {
    switch (vectorQuantization) {
      case 'ivf_pq':
        return (
          <>
            <div className="dset-form__field">
              <InputField
                form={form}
                name="quant_num_partitions"
                label="Num Partitions"
                type="number"
                placeholder="256"
                description="Number of Voronoi cells (default: 256)"
              />
            </div>
            <div className="dset-form__field">
              <InputField
                form={form}
                name="quant_num_sub_vectors"
                label="Num Sub-Vectors"
                type="number"
                placeholder="96"
                description="PQ sub-vectors for compression (default: 96)"
              />
            </div>
          </>
        );

      case 'scalar':
        return (
          <>
            <div className="dset-form__field">
              <InputField
                form={form}
                name="quant_ef_construction"
                label="ef_construction"
                type="number"
                placeholder="150"
                description="HNSW construction parameter (default: 150)"
              />
            </div>
            <div className="dset-form__field">
              <InputField
                form={form}
                name="quant_m"
                label="m (Connectivity)"
                type="number"
                placeholder="Auto"
                description="HNSW graph connections per node (default: auto)"
              />
            </div>
            <div className="dset-form__field">
              <InputField
                form={form}
                name="quant_num_partitions"
                label="Num Partitions"
                type="number"
                placeholder="Auto"
                description="IVF partitions (default: auto)"
              />
            </div>
          </>
        );

      case 'ivf_rq':
        return (
          <>
            <div className="dset-form__field">
              <InputField
                form={form}
                name="quant_num_bits"
                label="Num Bits"
                type="number"
                placeholder="1"
                description="Bits per dimension: 1 (standard RaBitQ), 2/4/8 for higher fidelity"
              />
            </div>
            <div className="dset-form__field">
              <InputField
                form={form}
                name="quant_num_partitions"
                label="Num Partitions"
                type="number"
                placeholder="Auto"
                description="IVF partitions (default: auto)"
              />
            </div>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Indexing configuration
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          Select the embedding stack and storage strategy for this corpus.
        </Typography>
      </div>

      <div className="dset-form__fields">
        <div className="dset-form__field">
          <SelectDropdownField
            form={form}
            name="index_type"
            label="Index type"
            items={KB_INDEX_TYPE_OPTIONS}
            placeholder="Select index type"
            size="fill"
            options={{
              isMultiSelect: false,
              isSearchable: true,
              isCellMultiline: true,
              side: 'bottom',
            }}
          />
        </div>

        <div className="dset-form__field">
          <SelectDropdownField
            form={form}
            name="vector_quantization"
            label="Vector Index"
            items={KB_VECTOR_QUANTIZATION_OPTIONS}
            placeholder="Select quantization"
            size="fill"
            options={{
              isMultiSelect: false,
              isSearchable: true,
              isCellMultiline: true,
              side: 'bottom',
            }}
          />
        </div>

        {renderQuantizationFields()}
      </div>
      <div className="kb-indexing-section-spacer" />
    </section>
  );
}

export { KBIndexingConfigSection };
export type { KBIndexingConfigSectionProps };
