export const ASSIGNED_KB_PANEL_STRINGS = {
  ROW_LABEL: "Knowledge bases",
  RESOURCE_LABEL: "Assigned knowledge bases",
  PRIMARY_ACTION: "Assign",
  PRIMARY_ACTION_FEEDBACK: "Assign knowledge base",
  NAVIGATE_FEEDBACK_PREFIX: "Open knowledge base",
  COL_NAME: "Name",
  COL_STATUS: "Status",
  COL_JOB_DETAILS: "Job details",
  COL_INDEXED_DATA: "Indexed data",
  COL_LAST_SYNC: "Last synchronization",
  COL_LABELS: "Labels",
  COL_ACTIONS: "Actions",
  JOB_READY: "Ready",
  JOB_PROCESSING: "Processing",
  INDEXED_FILES_SUFFIX: "files",
  INDEXED_VECTORS_SUFFIX: "vectors",
  ACTION_VIEW_DETAILS: "View details",
  ACTION_RESYNCHRONIZE: "Re-synchronize",
  ACTION_UNASSIGN: "Unassign",
} as const;

// Total segments in the segmented progress bar shown in the Job details
// column. The fill is `ceil(progress * SEGMENT_COUNT)` so a half-finished
// job lights up the first two of four segments — matches the screenshot.
export const KB_JOB_SEGMENT_COUNT = 4;
