import { useCallback, useMemo, type ReactElement } from 'react';
import { useStore } from '@tanstack/react-store';

import { useListDatasetsQuery } from '@/api/dataset-api.slice';
import { POLLING_INTERVAL } from '@/consts/api.consts';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import { FormFieldErrorBlock } from '@/ui-lib/base-components/form';
import { BaseTable } from '@/ui-lib/base-components/baseTableMcpBxp';
import type { BaseTableOptions } from '@/ui-lib/base-components/baseTableMcpBxp';
import {
  createKBFormDatasetPickerColumns,
  type KBFormDatasetPickerRow,
} from '@/components/knowledge-base/columns/kb-form-dataset-picker.columns';

import { createKbDatasetIdFieldValidators } from './kb-form.validation';

function DatasetIdFieldError({ form }: { form: AnyReactFormApi }): ReactElement | null {
  const message = useStore(form.store, (s) => {
    const m = s.fieldMeta.dataset_id;
    if (!m?.errors?.length) {
      return undefined;
    }
    return String(m.errors[0]);
  });
  if (message == null) {
    return null;
  }
  return <FormFieldErrorBlock message={message} className="dset-form__message-below" />;
}

const PICKER_TABLE_OPTIONS: BaseTableOptions = {
  enableRowSelection: true,
  enableColumnSorting: true,
  enableTableTopBar: true,
  enableRowFilter: true,
  enableColumnResizing: true,
  enablePagination: true,
  topBarOptions: {
    rowCountLabel: 'Datasets',
    showSearch: true,
  },
};

interface KBDatasetPickerProps {
  form: AnyReactFormApi;
  isEdit: boolean;
}

function KBDatasetPicker({ form, isEdit }: KBDatasetPickerProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useListDatasetsQuery(
    { projectId },
    { pollingInterval: POLLING_INTERVAL, skip: !projectId },
  );

  const tableData: KBFormDatasetPickerRow[] = useMemo(
    () =>
      (data?.data ?? [])
        .filter((d) => !d.deprecated)
        .map((item) => ({ ...item, id: item.dset_id })),
    [data],
  );

  const columns = useMemo(() => createKBFormDatasetPickerColumns(), []);

  const validators = useMemo(() => createKbDatasetIdFieldValidators(isEdit), [isEdit]);

  const handleRowSelectionChange = useCallback(
    (selection: Record<string, boolean>) => {
      const selectedId = Object.keys(selection).find((k) => selection[k]) ?? '';
      form.setFieldValue('dataset_id', selectedId);
    },
    [form],
  );

  return (
    <div className="dset-form__picker">
      <form.Field name="dataset_id" validators={validators}>
        {() => null}
      </form.Field>
      <BaseTable<KBFormDatasetPickerRow>
        options={PICKER_TABLE_OPTIONS}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
        onRowSelectionChange={handleRowSelectionChange}
      />
      <DatasetIdFieldError form={form} />
    </div>
  );
}

export { KBDatasetPicker };
export type { KBDatasetPickerProps };
