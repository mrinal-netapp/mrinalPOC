import { createApi } from '@reduxjs/toolkit/query/react';

import { AGENT_BASE_URL } from '@/consts/api.consts';
import { createBaseQueryWithReauth } from './api.slice';
import type { AgentChatRequest, AgentChatResponse } from './agent.types';

const agentApi = createApi({
  reducerPath: 'agentApi',
  baseQuery: createBaseQueryWithReauth(AGENT_BASE_URL),
  endpoints: (builder) => ({
    rfcSearchRelevanceChat: builder.mutation<AgentChatResponse, { query: string }>({
      query: ({ query }) => ({
        url: '/agent/rfc_search_relevance_scorer/chat',
        method: 'POST',
        body: {
          query,
        } satisfies AgentChatRequest,
      }),
    }),
  }),
});

export { agentApi };

export const { useRfcSearchRelevanceChatMutation } = agentApi;
