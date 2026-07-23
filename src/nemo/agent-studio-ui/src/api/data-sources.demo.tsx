import { useState } from 'react';
import type { ReactElement } from 'react';

import {
  useListDataSourcesQuery,
  useGetDataSourceQuery,
  useListDataSourceDatasetsQuery,
  useCreateDataSourceMutation,
  useUpdateDataSourceMutation,
  useDeleteDataSourceMutation,
  useUpdateDataSourceDeprecationMutation,
} from './data-source-api.slice';
import { shouldSkipQuery } from './api.slice';
import './api-demos.scss';

interface DemoResult {
  label: string;
  params: Record<string, unknown>;
  data: unknown;
  error: unknown;
  isLoading: boolean;
}

const DEMO_DSRC_ID = "b0f66b21-9af2-4104-8dcd-d109f29f9922";
const PROJECT_ID = "demo-project";

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

export function ApiDemoPage(): ReactElement {
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
  const getParams = { projectId: PROJECT_ID, dsrcId: DEMO_DSRC_ID };
  const datasetsParams = { projectId: PROJECT_ID, dsrcId: DEMO_DSRC_ID };

  // -- Queries (conditional via skip) --

  const listQuery = useListDataSourcesQuery(listParams, {
    skip: shouldSkipQuery() || !activeQueries.has('list'),
  });

  const getQuery = useGetDataSourceQuery(getParams, {
    skip: shouldSkipQuery() || !activeQueries.has('get'),
  });

  const datasetsQuery = useListDataSourceDatasetsQuery(datasetsParams, {
    skip: shouldSkipQuery() || !activeQueries.has('datasets'),
  });

  // -- Mutations --

  const [createDs] = useCreateDataSourceMutation();
  const [updateDs] = useUpdateDataSourceMutation();
  const [deleteDs] = useDeleteDataSourceMutation();
  const [updateDeprecation] = useUpdateDataSourceDeprecationMutation();

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
      name: 'demo-data-source13',
      source_type: 'NFS' as const,
      description: 'Demo data source description',
      labels: ['demo', 'test', 'data-source'],
      connection: {
        server: '192.168.1.100',
        export_path: '/data',
        folder_boundary: '/',
        auth_method: 'none',
        username: undefined,
        password: undefined,
      },
      scan_config: {
        scan_depth: 'top_2_levels' as const,
        custom_depth: null,
      },
    },
  };
  const updateParams = {
    projectId: PROJECT_ID,
    dsrcId: DEMO_DSRC_ID,
    body: { name: 'demo-data-source-updated1' },
  };
  const deleteParams = { projectId: PROJECT_ID, dsrcId: DEMO_DSRC_ID };
  const deprecationParams = {
    projectId: PROJECT_ID,
    dsrcId: DEMO_DSRC_ID,
    body: { deprecated: true },
  };

  const queryCards: DemoResult[] = [
    ...(activeQueries.has('list')
      ? [{ label: 'listDataSources', params: listParams, data: listQuery.data, error: listQuery.error, isLoading: listQuery.isLoading }]
      : []),
    ...(activeQueries.has('get')
      ? [{ label: 'getDataSource', params: getParams, data: getQuery.data, error: getQuery.error, isLoading: getQuery.isLoading }]
      : []),
    ...(activeQueries.has('datasets')
      ? [{ label: 'listDataSourceDatasets', params: datasetsParams, data: datasetsQuery.data, error: datasetsQuery.error, isLoading: datasetsQuery.isLoading }]
      : []),
  ];

  return (
    <div className="api-demo-page">
      <h1>Data Source API Demo</h1>

      <section className="demo-section">
        <h2>Queries</h2>
        <p className="demo-hint">Toggle to activate/deactivate each query.</p>
        <div className="demo-button-row">
          <button
            className={`demo-btn ${activeQueries.has('list') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('list')}
          >
            listDataSources
          </button>
          <button
            className={`demo-btn ${activeQueries.has('get') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('get')}
          >
            getDataSource
          </button>
          <button
            className={`demo-btn ${activeQueries.has('datasets') ? 'demo-btn--active' : ''}`}
            onClick={() => toggle('datasets')}
          >
            listDataSourceDatasets
          </button>
        </div>
        {queryCards.map((card) => (
          <ResultCard key={card.label} result={card} />
        ))}
      </section>

      <section className="demo-section">
        <h2>Mutations</h2>
        <p className="demo-hint">Click to fire each mutation. Results appear below.</p>
        <div className="demo-button-row">

          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('createDataSource', createParams, () => createDs(createParams).unwrap())}
          >
            createDataSource
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('updateDataSource', updateParams, () => updateDs(updateParams).unwrap())}
          >
            updateDataSource
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('deleteDataSource', deleteParams, () => deleteDs(deleteParams).unwrap())}
          >
            deleteDataSource
          </button>
          <button
            className="demo-btn demo-btn--mutation"
            onClick={() => runMutation('updateDeprecation', deprecationParams, () => updateDeprecation(deprecationParams).unwrap())}
          >
            updateDeprecation
          </button>
        </div>
        {mutationResults.map((result, i) => (
          <ResultCard key={`${result.label}-${i}`} result={result} />
        ))}
      </section>
    </div>
  );
}

export default ApiDemoPage;
