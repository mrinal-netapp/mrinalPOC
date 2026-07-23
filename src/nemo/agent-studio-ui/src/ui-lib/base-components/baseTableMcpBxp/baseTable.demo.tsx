import { useState } from "react"
import BaseTable from "./baseTable"
import { jobColumns } from "./columns/jobTable.columns"
import { datasourceColumns } from "./columns/datasourceTable.columns"
import { Typography } from "../typography/typography"
import type { JobTableRow, DataSourceRow, StatusEnumModel } from "./baseTable.types"
import "./baseTable.demo.scss"

const MOCK_STATUSES: StatusEnumModel[] = ["Initialized", "Pending", "In Progress", "Done", "Failed", "Error"]

function generateMockJobs(count: number): JobTableRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `job-${String(i + 1).padStart(3, "0")}`,
    status: [MOCK_STATUSES[i % MOCK_STATUSES.length]] as [StatusEnumModel],
    createdBy: `user-${(i % 5) + 1}`,
    createdAt: new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
    updatedBy: `user-${((i + 2) % 5) + 1}`,
    updatedAt: new Date(2025, 0, 10 + i).toISOString().slice(0, 10),
    executionMap: `map-${i + 1}`,
    metadata: `{"step":${i + 1}}`,
    steps: [],
  }))
}

const PROTOCOLS = ["NFS", "SMB"] as const

function generateMockDatasources(count: number): DataSourceRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ds-${String(i + 1).padStart(3, "0")}`,
    name: `Datasource ${i + 1}`,
    description: `Sample datasource #${i + 1} for ingestion pipeline`,
    createdBy: `admin-${(i % 3) + 1}`,
    createdAt: new Date(2025, 1, 1 + i).toISOString().slice(0, 10),
    updatedBy: `admin-${((i + 1) % 3) + 1}`,
    updatedAt: new Date(2025, 1, 15 + i).toISOString().slice(0, 10),
    volumes: [
      {
        type: PROTOCOLS[i % 2],
        nfsSmb: {
          protocol: PROTOCOLS[i % 2],
          host: `storage-${(i % 4) + 1}.local`,
          exportPath: `/data/share-${i + 1}`,
          directories: [{ path: `/vol${i + 1}/dir1` }],
        },
        schedule: i % 2 === 0 ? "daily" : "weekly",
      },
    ],
    interval: i % 3 === 0 ? "15m" : i % 3 === 1 ? "1h" : "6h",
    filters: {
      fileExtensions: [".csv", ".json", ".parquet"].slice(0, (i % 3) + 1),
      regularExpressions: i % 2 === 0 ? ["^data_.*"] : [],
    },
    tags: ["ingestion", `team-${(i % 4) + 1}`, ...(i % 3 === 0 ? ["priority"] : [])],
  }))
}

export default function BaseTableDemo() {
  const [jobData, setJobData] = useState<JobTableRow[]>(() => generateMockJobs(25))
  const [dsData] = useState<DataSourceRow[]>(() => generateMockDatasources(20))

  const handleBatchDelete = (ids: string[]) => {
    setJobData((prev) => prev.filter((row) => !ids.includes(row.id)))
  }

  return (
    <div className="base-table-demo">
      {/* Demo 1: Full-featured job table */}
      <section className="base-table-demo__section">
        <Typography Component="h2" fontSize="fs20" boldness="semibold" className="base-table-demo__title">
          Job Table — All Features
        </Typography>
        <Typography Component="p" fontSize="fs14" className="base-table-demo__description">
          Selection, multi-select, sorting, column DnD, row DnD, expansion, pagination, resize, search, column visibility, batch delete.
        </Typography>
        <BaseTable<JobTableRow>
          data={jobData}
          columns={jobColumns}
          options={{
            enableRowFilter: true,
            enableRowSelection: true,
            enableRowMultiSelection: true,
            enableRowExpansion: true,
            enablePagination: true,
            enableColumnSorting: true,
            enableColumnResizing: true,
            enableColumnDrag: true,
            enableRowDrag: true,
            enableStickyHeaders: true,
            enableTableTopBar: true,
            onBatchDelete: handleBatchDelete,
            topBarOptions: {
              rowCountLabel: "Jobs",
              showSearch: true,
              onDownload: () => {},
              showSecondaryAction: true,
              onPrimaryAction: () => {},
              primaryActionLabel: "Primary action",
              secondaryActionLabel: "Secondary action",
            },
          }}
        />
      </section>

      {/* Demo 2: Datasource table — subset of options */}
      <section className="base-table-demo__section">
        <Typography Component="h2" fontSize="fs20" boldness="semibold" className="base-table-demo__title">
          Datasource Table — Sorting + Pagination
        </Typography>
        <Typography Component="p" fontSize="fs14" className="base-table-demo__description">
          Demonstrates column sorting and pagination with a different column configuration. No DnD, expansion, or selection.
        </Typography>
        <BaseTable<DataSourceRow>
          data={dsData}
          columns={datasourceColumns}
          options={{
            enableColumnSorting: true,
            enablePagination: true,
            enableColumnResizing: true,
            enableStickyHeaders: true,
            enableTableTopBar: true,
            enableRowFilter: true,
            topBarOptions: {
              rowCountLabel: "Data sources",
              showSearch: true,
            },
          }}
        />
      </section>
    </div>
  )
}
