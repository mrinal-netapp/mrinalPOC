import { createApi } from '@reduxjs/toolkit/query/react';

import { UTILITIES_BASE_URL } from '@/consts/api.consts';
import { createBaseQueryWithReauth } from './api.slice';
import type {
  BrowseParams,
  BrowseResponse,
  ValidateConnectionRequest,
  ValidateConnectionResponse,
} from './utilities.types';

const utilitiesApi = createApi({
  reducerPath: 'utilitiesApi',
  baseQuery: createBaseQueryWithReauth(UTILITIES_BASE_URL),
  endpoints: (builder) => ({
    browse: builder.query<BrowseResponse, BrowseParams>({
      query: ({ datasourceId, path, limit, continuationToken }) => {
        const params = new URLSearchParams({ datasourceId });
        if (path) params.set('path', path);
        if (limit != null) params.set('limit', String(limit));
        if (continuationToken) params.set('continuationToken', continuationToken);
        return { url: `/browse?${params.toString()}` };
      },
    }),

    validateConnection: builder.mutation<
      ValidateConnectionResponse,
      { body: ValidateConnectionRequest }
    >({
      query: ({ body }) => ({
        url: '/validate-connection',
        method: 'POST',
        body,
      }),
    }),

    validateExistingDatasourceConnection: builder.mutation<
      ValidateConnectionResponse,
      { dsrcId: string; body: ValidateConnectionRequest }
    >({
      query: ({ dsrcId, body }) => ({
        url: `/datasources/${dsrcId}/validate-connection`,
        method: 'POST',
        body,
      }),
    }),
  }),
});

export { utilitiesApi };

export const {
  useBrowseQuery,
  useLazyBrowseQuery,
  useValidateConnectionMutation,
  useValidateExistingDatasourceConnectionMutation,
} = utilitiesApi;
