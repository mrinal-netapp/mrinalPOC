import { useState } from 'react';
import type { ReactElement } from 'react';

import {
  useListDatasetsQuery,
  useGetDatasetQuery,
  useListDatasetSnapshotsQuery,
  useListDatasetKnowledgeBasesQuery,
  useCreateDatasetMutation,
  useUpdateDatasetMutation,
  useTriggerDatasetSyncMutation,
  useDeleteDatasetMutation,
  useCreateDatasetSnapshotMutation,
} from './dataset-api.slice';
import { shouldSkipQuery } from './api.slice';
import './api-demos.scss';

interface DemoResult {
  label: string;
  params: Record<string, unknown>;
  data: unknown;
  error: unknown;
  isLoading: boolean;
}

const DEMO_DSET_ID = '8d39b82d-b288-402f-a7b1-a2ed51526da4';
const DEMO_DSRC_ID = '43b88849-73f8-418f-acc3-0b1995d65ab1';
const PROJECT_ID = 'demo-project';

function JsonBlock({ value }: { value: unknown }): ReactElement {
  return (
    <pre className="demo-json">
      {value === undefined ? '—' : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ResultCard({ result }: { result: DemoResult }): ReactElement {
  return (
    <div className="demo-result-card">
      <h3>{result.label}</h3>
      <div className="demo-result-body">
        <div className="demo-result-col">
          <h4>Request Params</h4>
          <JsonBlock value={result.params} />
        </div>
        <div className="demo-result-col">
          <h4>Response</h4>
          {result.isLoading ? (
            <p className="demo-loading">Loading...</p>
          ) : result.error ? (
            <JsonBlock value={result.error} />
          ) : (
            <JsonBlock value={result.data} />
          )}
        </div>
      </div>
    </div>
  );
}

export function DatasetApiDemoPage(): ReactElement {
  const [activeQueries, setActiveQueries] = useState<Set<string>>(new Set());
  const [mutationResults, setMutationResults] = useState<DemoResult[]>([]);

  const toggle = (key: string): void => {
    setActiveQueries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // -- Query params --

  const listParams = { projectId: PROJECT_ID, limit: 10, offset: 0 };
  const getParams = { projectId: PROJECT_ID, dsetId: DEMO_DSET_ID };
  const snapshotsParams = { projectId: PROJECT_ID, dsetId: DEMO_DSET_ID };
  const kbParams = { projectId: PROJECT_ID, dsetId: DEMO_DSET_ID };

  // -- Queries (conditional via skip) --

  const listQuery = useListDatasetsQuery(listParams, {
    skip: shouldSkipQuery() || !activeQueries.has('list'),
  });

  const getQuery = useGetDatasetQuery(getParams, {
    skip: shouldSkipQuery() || !activeQueries.has('get'),
  });

  const snapshotsQuery = useListDatasetSnapshotsQuery(snapshotsParams, {
    skip: shouldSkipQuery() || !activeQueries.has('snapshots'),
  });

  const kbQuery = useListDatasetKnowledgeBasesQuery(kbParams, {
    skip: shouldSkipQuery() || !activeQueries.has('knowledgeBases'),
  });

  // -- Mutations --

  const [createDataset] = useCreateDatasetMutation();
  const [updateDataset] = useUpdateDatasetMutation();
  const [triggerSync] = useTriggerDatasetSyncMutation();
  const [deleteDataset] = useDeleteDatasetMutation();
  const [createSnapshot] = useCreateDatasetSnapshotMutation();

  const runMutation = async (
    label: string,
    params: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    const placeholder: DemoResult = { label, params, data: undefined, error: undefined, isLoading: true };
    setMutationResults((prev) => [placeholder, ...prev]);

    try {
      const result = await fn();
      setMutationResults((prev) =>
        prev.map((r) => (r === placeholder ? { ...r, data: result, isLoading: false } : r)),
      );
    } catch (err) {
      setMutationResults((prev) =>
        prev.map((r) => (r === placeholder ? { ...r, error: err, isLoading: false } : r)),
      );
    }
  };

  // -- Mutation param sets --
  const createParams = {
    projectId: PROJECT_ID,
    body: {
      name: 'demo-dataset',
      input_type: 'data-source' as const,
      kind: 'unstructured' as const,
      data_source_id: DEMO_DSRC_ID,
      description: 'Demo dataset created from the API demo page',
      labels: ['demo', 'test'],
      spec: { folder_scope: 'all' as const },
    },
  };
  const updateParams = {
    projectId: PROJECT_ID,
    dsetId: DEMO_DSET_ID,
    body: { description: 'Updated via demo' },
  };
  const deprecateParams = {
    projectId: PROJECT_ID,
    dsetId: DEMO_DSET_ID,
    body: { deprecated: true },
  };

  const queryCards: DemoResult[] = [
    ...(activeQueries.has('list')
      ? [{ label: 'listDatasets', params: listParams, data: listQuery.data, error: listQuery.error, isLoading: listQuery.isLoading }]
      : []),
    ...(activeQueries.has('get')
      ? [{ label: 'getDataset', params: getParams, data: getQuery.data, error: getQuery.error, isLoading: getQuery.isLoading }]
      : []),
    ...(activeQueries.has('snapshots')
      ? [{ label: 'listDatasetSnapshots', params: snapshotsParams, data: snapshotsQuery.data, error: snapshotsQuery.error, isLoading: snapshotsQuery.isLoading }]
      : []),
    ...(activeQueries.has('knowledgeBases')
      ? [{ label: 'listDatasetKnowledgeBases', params: kbParams, data: kbQuery.data, error: kbQuery.error, isLoading: kbQuery.isLoading }]
      : []),
  ];

  return (
    <div className="api-demo-page">
      <h1>Dataset API Demo</h1>

      <section className="demo-section">
        <h2>Queries</h2>
        <p className="demo-hint">Toggle to activate/deactivate each query.</p>
        <div className="demo-button-row">
          <button
            className={`demo-btn ${activeQueries.has('list') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('list')}
          >
            listDatasets
          </button>
          <button
            className={`demo-btn ${activeQueries.has('get') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('get')}
          >
            getDataset
          </button>
          <button
            className={`demo-btn ${activeQueries.has('snapshots') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('snapshots')}
          >
            listDatasetSnapshots
          </button>
          <button
            className={`demo-btn ${activeQueries.has('knowledgeBases') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('knowledgeBases')}
          >
            listDatasetKnowledgeBases
          </button>
        </div>
        {queryCards.map((card) => (
          <ResultCard key={card.label} result={card} />
        ))}
      </section>

      <section className="demo-section">
        <h2>Mutations</h2>
        <p className="demo-hint">
          Click to fire each mutation. Results appear below.
          Replace <code>{DEMO_DSET_ID}</code> in the file with a real dataset UUID for ID-based calls.
        </p>
        <div className="demo-button-row">
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('createDataset', createParams, () => createDataset(createParams).unwrap())}
          >
            createDataset
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('updateDataset', updateParams, () => updateDataset(updateParams).unwrap())}
          >
            updateDataset
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('deprecateDataset', deprecateParams, () => updateDataset(deprecateParams).unwrap())}
          >
            deprecateDataset
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('triggerDatasetSync', { projectId: PROJECT_ID, dsetId: DEMO_DSET_ID }, () => triggerSync({ projectId: PROJECT_ID, dsetId: DEMO_DSET_ID }).unwrap())}
          >
            triggerDatasetSync
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('createDatasetSnapshot', { projectId: PROJECT_ID, dsetId: DEMO_DSET_ID }, () => createSnapshot({ projectId: PROJECT_ID, dsetId: DEMO_DSET_ID }).unwrap())}
          >
            createSnapshot
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('deleteDataset', { projectId: PROJECT_ID, dsetId: DEMO_DSET_ID }, () => deleteDataset({ projectId: PROJECT_ID, dsetId: DEMO_DSET_ID, dsrcId: DEMO_DSRC_ID }).unwrap())}
          >
            deleteDataset
          </button>
        </div>
        {mutationResults.map((result, i) => (
          <ResultCard key={`${result.label}-${i}`} result={result} />
        ))}
      </section>
    </div>
  );
}

export default DatasetApiDemoPage;
