import { useState } from 'react';
import type { ReactElement } from 'react';

import {
  useListKnowledgeBasesQuery,
  useGetKnowledgeBaseQuery,
  useGetKBAssignedDatasetQuery,
  useListKBSnapshotsQuery,
  useValidateKBNameMutation,
  useCreateKnowledgeBaseMutation,
  useUpdateKnowledgeBaseMutation,
  useDeleteKnowledgeBaseMutation,
  useCreateKBSnapshotMutation,
  useUpdateKBSnapshotMutation,
} from './kb-api.slice';
import { shouldSkipQuery } from './api.slice';
import './api-demos.scss';

interface DemoResult {
  label: string;
  params: Record<string, unknown>;
  data: unknown;
  error: unknown;
  isLoading: boolean;
}

const DEMO_KB_ID = '74f9b925-c67e-4ae2-8dee-bbe004e3cddf';
const DEMO_DSET_ID = "919d2844-7e25-4574-9ad6-f2f67b4c3126";
const DEMO_SNAPSHOT_ID = '8a328994-1ae3-43ab-99c2-29b54b10cd81';
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

export function KnowledgeBaseApiDemoPage(): ReactElement {
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

  const listParams = { projectId: PROJECT_ID, limit: 10, offset: 0 };
  const getParams = { projectId: PROJECT_ID, kbId: DEMO_KB_ID };
  const assignedParams = { projectId: PROJECT_ID, kbId: DEMO_KB_ID };
  const snapshotsParams = { kbId: DEMO_KB_ID };

  const listQuery = useListKnowledgeBasesQuery(listParams, {
    skip: shouldSkipQuery() || !activeQueries.has('list'),
  });

  const getQuery = useGetKnowledgeBaseQuery(getParams, {
    skip: shouldSkipQuery() || !activeQueries.has('get'),
  });

  const assignedQuery = useGetKBAssignedDatasetQuery(assignedParams, {
    skip: shouldSkipQuery() || !activeQueries.has('assignedDataset'),
  });

  const snapshotsQuery = useListKBSnapshotsQuery(snapshotsParams, {
    skip: shouldSkipQuery() || !activeQueries.has('snapshots'),
  });

  const [validateName] = useValidateKBNameMutation();
  const [createKB] = useCreateKnowledgeBaseMutation();
  const [updateKB] = useUpdateKnowledgeBaseMutation();
  const [deleteKB] = useDeleteKnowledgeBaseMutation();
  const [createSnapshot] = useCreateKBSnapshotMutation();
  const [updateSnapshot] = useUpdateKBSnapshotMutation();

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

  const validateParams = { name: 'my-test-knowledge-base' };
  const createParams = {
    projectId: PROJECT_ID,
    body: {
      name: 'demo-knowledge-base',
      dataset_id: DEMO_DSET_ID,
      description: 'Demo KB created from the API demo page',
      labels: ['demo', 'test'],
      embedding_config: { model: 'openai-text-embedding-3-small' },
    },
  };
  const updateParams = {
    projectId: PROJECT_ID,
    kbId: DEMO_KB_ID,
    body: { description: 'Updated via demo' },
  };
  const deprecateParams = {
    projectId: PROJECT_ID,
    kbId: DEMO_KB_ID,
    body: { deprecated: false },
  };

  const queryCards: DemoResult[] = [
    ...(activeQueries.has('list')
      ? [{ label: 'listKnowledgeBases', params: listParams, data: listQuery.data, error: listQuery.error, isLoading: listQuery.isLoading }]
      : []),
    ...(activeQueries.has('get')
      ? [{ label: 'getKnowledgeBase', params: getParams, data: getQuery.data, error: getQuery.error, isLoading: getQuery.isLoading }]
      : []),
    ...(activeQueries.has('assignedDataset')
      ? [{ label: 'getKBAssignedDataset', params: assignedParams, data: assignedQuery.data, error: assignedQuery.error, isLoading: assignedQuery.isLoading }]
      : []),
    ...(activeQueries.has('snapshots')
      ? [{ label: 'listKBSnapshots', params: snapshotsParams, data: snapshotsQuery.data, error: snapshotsQuery.error, isLoading: snapshotsQuery.isLoading }]
      : []),
  ];

  return (
    <div className="api-demo-page">
      <h1>Knowledge Base API Demo</h1>

      <section className="demo-section">
        <h2>Queries</h2>
        <p className="demo-hint">Toggle to activate/deactivate each query.</p>
        <div className="demo-button-row">
          <button
            className={`demo-btn ${activeQueries.has('list') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('list')}
          >
            listKnowledgeBases
          </button>
          <button
            className={`demo-btn ${activeQueries.has('get') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('get')}
          >
            getKnowledgeBase
          </button>
          <button
            className={`demo-btn ${activeQueries.has('assignedDataset') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('assignedDataset')}
          >
            getKBAssignedDataset
          </button>
          <button
            className={`demo-btn ${activeQueries.has('snapshots') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('snapshots')}
          >
            listKBSnapshots
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
          Replace <code>{DEMO_KB_ID}</code> (and snapshot id) with real UUIDs for ID-based calls.
        </p>
        <div className="demo-button-row">
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('validateKBName', validateParams, () => validateName(validateParams).unwrap())}
          >
            validateKBName
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('createKnowledgeBase', createParams, () => createKB(createParams).unwrap())}
          >
            createKnowledgeBase
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('updateKnowledgeBase', updateParams, () => updateKB(updateParams).unwrap())}
          >
            updateKnowledgeBase
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('deprecateKnowledgeBase', deprecateParams, () => updateKB(deprecateParams).unwrap())}
          >
            deprecateKnowledgeBase
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('createKBSnapshot', { kbId: DEMO_KB_ID }, () => createSnapshot({ kbId: DEMO_KB_ID }).unwrap())}
          >
            createKBSnapshot
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() =>
              runMutation(
                'updateKBSnapshot',
                { kbId: DEMO_KB_ID, snapshotId: DEMO_SNAPSHOT_ID, body: { expired: false } },
                () =>
                  updateSnapshot({
                    kbId: DEMO_KB_ID,
                    snapshotId: DEMO_SNAPSHOT_ID,
                    body: { expired: false },
                  }).unwrap(),
              )}
          >
            updateKBSnapshot
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('deleteKnowledgeBase', { projectId: PROJECT_ID, kbId: DEMO_KB_ID }, () => deleteKB({ projectId: PROJECT_ID, kbId: DEMO_KB_ID }).unwrap())}
          >
            deleteKnowledgeBase
          </button>
        </div>
        {mutationResults.map((result, i) => (
          <ResultCard key={`${result.label}-${i}`} result={result} />
        ))}
      </section>
    </div>
  );
}

export default KnowledgeBaseApiDemoPage;
