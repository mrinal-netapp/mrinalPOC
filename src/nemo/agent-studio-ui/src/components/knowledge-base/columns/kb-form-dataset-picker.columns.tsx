import type { ColumnDef } from '@tanstack/react-table';

import type { DatasetListItem } from '@/api/dataset.types';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { ChipList } from '@/ui-lib/base-components/chip-list/chip-list';
import { formatDateTimeFull } from '@/components/data-source/utils/data-source.utils';
import { DatasetStatusCell } from '@/components/dataset/columns/cells/status-cell';
import {
  formatKbDatasetPickerFileScope,
  getKbDatasetPickerSyncScheduleLabel,
} from '@/components/knowledge-base/utils/kb-dataset-picker.utils';

export interface KBFormDatasetPickerRow extends DatasetListItem {
  id: string;
}

function createKBFormDatasetPickerColumns(): ColumnDef<KBFormDatasetPickerRow>[] {
  return [
    {
      accessorKey: 'name',
      header: 'Name',
      size: 200,
      minSize: 140,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
          {row.original.name}
        </Typography>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      size: 130,
      cell: ({ row }) => <DatasetStatusCell status={row.original.status} />,
    },
    {
      id: 'file_scope',
      header: 'File scope',
      size: 220,
      minSize: 160,
      enableSorting: false,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatKbDatasetPickerFileScope(row.original)}
        </Typography>
      ),
    },
    {
      id: 'sync_schedule',
      header: 'Sync schedule',
      size: 130,
      enableSorting: false,
      cell: () => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {getKbDatasetPickerSyncScheduleLabel()}
        </Typography>
      ),
    },
    {
      id: 'last_sync',
      header: 'Last sync',
      size: 190,
      minSize: 160,
      enableSorting: false,
      cell: ({ row }) => {
        const date = row.original.latest_snapshot?.date;
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular">
            {date ? formatDateTimeFull(date) : '—'}
          </Typography>
        );
      },
    },
    {
      accessorKey: 'labels',
      header: 'Labels',
      size: 180,
      minSize: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const { labels } = row.original;
        if (!labels.length) {
          return <span className="ds-cell-placeholder">—</span>;
        }
        return (
          <ChipList
            values={labels}
            getLabel={(v) => String(v)}
            isRemovable={false}
            isDisabled={row.original.deprecated}
          />
        );
      },
    },
  ];
}

export { createKBFormDatasetPickerColumns };
