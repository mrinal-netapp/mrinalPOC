import { useMemo, type ReactElement } from 'react';
import { useStore } from '@tanstack/react-store';

import { useListDatasetsQuery } from '@/api/dataset-api.slice';
import type { DatasetStatus } from '@/api/dataset.types';
import type { KBDetail } from '@/api/kb.types';
import { POLLING_INTERVAL } from '@/consts/api.consts';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardHeader } from '@/ui-lib/base-components/card/card.header';
import { CardContent } from '@/ui-lib/base-components/card/card.content';
import { CardBlock } from '@/ui-lib/base-components/card/card.block';
import { ChipList } from '@/ui-lib/base-components/chip-list/chip-list';
import { DatasetStatusCell } from '@/components/dataset/columns/cells/status-cell';
import { formatKbAssignedDatasetFileScope } from '@/components/knowledge-base/utils/kb-dataset-picker.utils';
import { IconDatabase } from '@tabler/icons-react';

import { KBDatasetPicker } from './kb-dataset-picker';
import { KBTextColumnsField } from './kb-text-columns-field';

interface KBDatasetConfigSectionProps {
  form: AnyReactFormApi;
  isEdit: boolean;
  initialData?: KBDetail;
}

function KBDatasetConfigSection({ form, isEdit, initialData }: KBDatasetConfigSectionProps): ReactElement {
  const dataset = initialData?.assigned_dataset;
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const selectedDatasetId = useStore(form.store, (s) => s.values.dataset_id as string);

  // Create mode: the dataset list is already fetched by KBDatasetPicker;
  // RTK Query dedupes this identical query so no extra request is made.
  const { data: datasetsData } = useListDatasetsQuery(
    { projectId },
    { pollingInterval: POLLING_INTERVAL, skip: isEdit || !projectId },
  );

  const isStructuredDataset = useMemo(() => {
    if (isEdit) {
      return dataset?.kind === 'structured';
    }
    return (datasetsData?.data ?? []).some(
      (d) => d.dset_id === selectedDatasetId && d.kind === 'structured',
    );
  }, [isEdit, dataset, datasetsData, selectedDatasetId]);

  return (
    <section className="dset-form__section">
      <div className="dset-form__section-header">
        <Typography Component="h2" fontSize="fs14" boldness="semibold" className="dset-form__section-title">
          Dataset configuration
        </Typography>
        <Typography Component="p" fontSize="fs14" boldness="regular" className="dset-form__section-subtitle">
          {isEdit
            ? 'The dataset assigned to this knowledge base cannot be changed from this form.'
            : 'Select an existing dataset to power the knowledge base.'}
        </Typography>
      </div>

      {isEdit && initialData ? (
        <Card className="dset-form__source-card">
          <CardHeader icon={<IconDatabase size={20} />} title="Assigned dataset" hasSeparator />
          <CardContent>
            <CardBlock type="key-value">
              <div className="dset-form__access-info">
                <div className="dset-form__access-info-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular">Name</Typography>
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    {dataset?.name ?? '—'}
                  </Typography>
                </div>
                <div className="dset-form__access-info-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular">Status</Typography>
                  {dataset?.status ? (
                    <DatasetStatusCell status={dataset.status as DatasetStatus} />
                  ) : (
                    <Typography Component="span" fontSize="fs14" boldness="regular">—</Typography>
                  )}
                </div>
                <div className="dset-form__access-info-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular">File scope</Typography>
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    {dataset ? formatKbAssignedDatasetFileScope(dataset) : '—'}
                  </Typography>
                </div>
                <div className="dset-form__access-info-row">
                  <Typography Component="span" fontSize="fs14" boldness="regular">Labels</Typography>
                  {dataset?.labels?.length ? (
                    <ChipList
                      values={dataset.labels}
                      getLabel={(v) => String(v)}
                      isRemovable={false}
                      isDisabled={false}
                    />
                  ) : (
                    <Typography Component="span" fontSize="fs14" boldness="regular">—</Typography>
                  )}
                </div>
              </div>
            </CardBlock>
          </CardContent>
        </Card>
      ) : (
        <KBDatasetPicker form={form} isEdit={isEdit} />
      )}

      {isStructuredDataset && <KBTextColumnsField form={form} />}
    </section>
  );
}

export { KBDatasetConfigSection };
export type { KBDatasetConfigSectionProps };
