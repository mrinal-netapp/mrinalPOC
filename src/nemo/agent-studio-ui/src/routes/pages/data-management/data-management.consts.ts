import { ROUTES } from "@/routes/routes.consts";

export const DATA_SOURCE_STRINGS = {
  PAGE_TITLE: "Data sources",
  PAGE_SUBTITLE: "Add data sources to connect your storage, then organize it into datasets by defining the data you need.",
} as const;

export const DATASET_STRINGS = {
  PAGE_TITLE: "Datasets",
  PAGE_SUBTITLE: "Select a data source or upload files, define the scope of content to include, and set a sync schedule. Your dataset provides the content for building a knowledge base.",
} as const;

// Route path builders. Data sources and datasets are now top-level routes
// (the former `/data-management` tab page was split into two siblings).
const DS_BASE = `/${ROUTES.DATA_SOURCES}`;
const DSET_BASE = `/${ROUTES.DATASETS}`;

export const dataManagementPaths = {
  dataSources: DS_BASE,
  datasets: DSET_BASE,
  dataSourceCreate: `${DS_BASE}/${ROUTES.CREATE}`,
  dataSourceDetail: (dsrcId: string): string => `${DS_BASE}/${dsrcId}`,
  dataSourceEdit: (dsrcId: string): string => `${DS_BASE}/${dsrcId}/${ROUTES.EDIT}`,
  datasetCreate: `${DSET_BASE}/${ROUTES.CREATE}`,
  datasetDetail: (dsetId: string): string => `${DSET_BASE}/${dsetId}`,
  datasetEdit: (dsetId: string): string => `${DSET_BASE}/${dsetId}/${ROUTES.EDIT}`,
} as const;
