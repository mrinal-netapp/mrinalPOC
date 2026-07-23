import type {
  BaseQueryFn,
  FetchArgs,
  FetchBaseQueryError,
} from "@reduxjs/toolkit/query/react";

import { PROJECTS_BASE_URL } from "@/consts/api.consts";
import { apiSlice, createBaseQueryWithReauth } from "./api.slice";
import type {
  ProviderCatalogEntry,
  ProviderCatalogListResponse,
} from "./provider-catalog.types";

const configBaseQuery = createBaseQueryWithReauth(PROJECTS_BASE_URL);

async function runConfigQuery<T>(
  args: string | FetchArgs,
  api: Parameters<BaseQueryFn>[1],
  extraOptions: Parameters<BaseQueryFn>[2],
): Promise<{ data: T } | { error: FetchBaseQueryError }> {
  const result = await configBaseQuery(args, api, extraOptions);
  if (result.error) {
    return { error: result.error };
  }
  if (result.data == null) {
    return {
      error: {
        status: "CUSTOM_ERROR",
        error: "Empty response body",
        data: "Empty response body",
      },
    };
  }
  return { data: result.data as T };
}

const providerCatalogApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    listProviderCatalog: builder.query<ProviderCatalogEntry[], void>({
      queryFn: async (_arg, api, extraOptions) => {
        const result = await runConfigQuery<ProviderCatalogListResponse>(
          "/explorer/providers",
          api,
          extraOptions,
        );
        if ("error" in result) {
          return result;
        }
        return { data: result.data.providers ?? [] };
      },
      providesTags: [{ type: "ProviderCatalog", id: "LIST" }],
    }),

    getProviderCatalogEntry: builder.query<ProviderCatalogEntry, string>({
      queryFn: async (providerId, api, extraOptions) =>
        runConfigQuery<ProviderCatalogEntry>(
          `/explorer/providers/${providerId}`,
          api,
          extraOptions,
        ),
      providesTags: (_result, _error, providerId) => [
        { type: "ProviderCatalog", id: providerId },
      ],
    }),
  }),
});

export { providerCatalogApi };

export const {
  useListProviderCatalogQuery,
  useGetProviderCatalogEntryQuery,
} = providerCatalogApi;
