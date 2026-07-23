/**
 * Unit tests for the previously-untested express-validator chains
 * (agent, agentTeam, credential, model, mcpServer, pipeline, manifest)
 * plus the model-selection guard middlewares.
 *
 * Run: node --require ts-node/register --test tests/validators.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';

import {
  createAgentValidator,
  updateAgentValidator,
  validateAgentModelSelection,
} from '../validators/agentValidator';
import {
  createAgentTeamValidator,
  updateAgentTeamValidator,
  validateTeamManagerModelSelection,
} from '../validators/agentTeamValidator';
import {
  createCredentialValidator,
  updateCredentialValidator,
  rotateCredentialValidator,
} from '../validators/credentialValidator';
import { createModelValidator, updateModelValidator } from '../validators/modelValidator';
import { createMCPServerValidator, updateMCPServerValidator } from '../validators/mcpServerValidator';
import { createPipelineValidator, updatePipelineValidator } from '../validators/pipelineValidator';
import {
  addFilesValidator,
  updateStatusValidator,
  updateMetadataValidator,
  replaceManifestSourceUrisValidator,
  appendManifestSourceUrisValidator,
} from '../validators/manifestValidator';
import { updateProviderProxyValidator } from '../validators/providerValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';

const UUID = '123e4567-e89b-12d3-a456-426614174000';

/** Helper for running middleware that returns 400 or calls next(). */
function runMiddleware(mw: (req: Request, res: Response, next: NextFunction) => void, body: any) {
  let status = 0;
  let payload: any = null;
  let nextCalled = false;
  const req = { body } as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(obj: any) {
      payload = obj;
      return this;
    },
  } as unknown as Response;
  mw(req, res, () => {
    nextCalled = true;
  });
  return { status, payload, nextCalled };
}

// -------------------------------------------------------------------- agent
test('createAgentValidator: accepts a full valid body', async () => {
  const res = await runValidators(createAgentValidator, {
    body: {
      name: 'My Agent',
      role: 'assistant',
      systemPrompt: 'You help.',
      modelId: 'm1',
      temperature: 1.0,
      maxTokens: 100,
      knowledgeBaseIds: ['kb12345678'],
      ragConfig: { kb12345678: { topK: 5, similarityThreshold: 0.5, searchMode: 'hybrid' } },
      memoryType: 'conversation',
      guardrails: {
        enabled: true,
        fail_open: false,
        log_blocked_requests: true,
        input_guardrails: [
          { guardrail_id: '11111111-1111-4111-8111-111111111111', action: 'block', config: { mask_ssn: true } },
        ],
        output_guardrails: [{ guardrail_id: '22222222-2222-4222-8222-222222222222' }],
        tool_guardrails: [],
      },
    },
  });
  assert.equal(res.isEmpty(), true, validationMessages(res));
});

test('createAgentValidator: rejects missing role/systemPrompt and bad enums', async () => {
  const missing = await runValidators(createAgentValidator, { body: { name: 'x' } });
  assert.equal(missing.isEmpty(), false);

  const badEnum = await runValidators(createAgentValidator, {
    body: {
      name: 'x',
      role: 'r',
      systemPrompt: 's',
      ragConfig: { kb12345678: { topK: 5, similarityThreshold: 0.5, searchMode: 'nope' } },
      temperature: 9,
    },
  });
  assert.equal(badEnum.isEmpty(), false);
});

test('updateAgentValidator: allows partial + nullable fields', async () => {
  const res = await runValidators(updateAgentValidator, {
    body: { description: null, modelId: null, ragConfig: null },
  });
  assert.equal(res.isEmpty(), true, validationMessages(res));
});

test('agent validators: ragConfig per-KB map shape', async () => {
  const base = { name: 'a', role: 'r', systemPrompt: 's', modelId: 'm1' };

  // Valid per-KB map (one full entry, one with an optional flag).
  const ok = await runValidators(createAgentValidator, {
    body: {
      ...base,
      knowledgeBaseIds: ['kb11111111', 'kb22222222'],
      ragConfig: {
        kb11111111: { topK: 10, similarityThreshold: 0.3, searchMode: 'hybrid' },
        kb22222222: { topK: 5, similarityThreshold: 0.1, searchMode: 'fts', rerankingEnabled: true },
      },
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  // Empty map is shape-valid (the 1:1 coverage check lives in the route layer).
  const emptyMap = await runValidators(createAgentValidator, { body: { ...base, ragConfig: {} } });
  assert.equal(emptyMap.isEmpty(), true, validationMessages(emptyMap));

  // Entry missing a required field (searchMode).
  const missingField = await runValidators(createAgentValidator, {
    body: { ...base, ragConfig: { kb11111111: { topK: 10, similarityThreshold: 0.3 } } },
  });
  assert.equal(missingField.isEmpty(), false);

  // Entry with out-of-range topK.
  const badTopK = await runValidators(createAgentValidator, {
    body: { ...base, ragConfig: { kb11111111: { topK: 0, similarityThreshold: 0.3, searchMode: 'hybrid' } } },
  });
  assert.equal(badTopK.isEmpty(), false);

  // Entry value is not an object.
  const notObject = await runValidators(createAgentValidator, {
    body: { ...base, ragConfig: { kb11111111: 'nope' } },
  });
  assert.equal(notObject.isEmpty(), false);

  // Update path: explicit null clears (allowed at the shape layer).
  const updateNull = await runValidators(updateAgentValidator, { body: { ragConfig: null } });
  assert.equal(updateNull.isEmpty(), true, validationMessages(updateNull));
});

test('validateAgentModelSelection: create requires modelId or modelClass', () => {
  assert.equal(runMiddleware(validateAgentModelSelection('create'), {}).status, 400);
  assert.equal(runMiddleware(validateAgentModelSelection('create'), { modelId: 'm' }).nextCalled, true);
  assert.equal(
    runMiddleware(validateAgentModelSelection('update'), { modelId: null, modelClass: null }).status,
    400,
  );
  assert.equal(runMiddleware(validateAgentModelSelection('update'), { modelId: null }).nextCalled, true);
});

test('agent validators: structuredOutput responseFormat + outputSchema', async () => {
  const base = { name: 'a', role: 'r', systemPrompt: 's', modelId: 'm1' };

  // Valid json_object card.
  const okJson = await runValidators(createAgentValidator, {
    body: {
      ...base,
      structuredOutput: {
        enabled: true,
        responseFormat: 'json_object',
        outputSchema: '{"type":"object"}',
      },
    },
  });
  assert.equal(okJson.isEmpty(), true, validationMessages(okJson));

  // Valid text card (outputSchema is free-form guidelines).
  const okText = await runValidators(createAgentValidator, {
    body: {
      ...base,
      structuredOutput: {
        enabled: true,
        responseFormat: 'text',
        outputSchema: 'Respond in bullet points.',
      },
    },
  });
  assert.equal(okText.isEmpty(), true, validationMessages(okText));

  // Disabled card needs neither field.
  const disabled = await runValidators(createAgentValidator, {
    body: { ...base, structuredOutput: { enabled: false } },
  });
  assert.equal(disabled.isEmpty(), true, validationMessages(disabled));

  // enabled=true but missing responseFormat.
  const missingFormat = await runValidators(createAgentValidator, {
    body: { ...base, structuredOutput: { enabled: true, outputSchema: '{}' } },
  });
  assert.equal(missingFormat.isEmpty(), false);

  // enabled=true but invalid responseFormat enum.
  const badFormat = await runValidators(createAgentValidator, {
    body: {
      ...base,
      structuredOutput: { enabled: true, responseFormat: 'yaml', outputSchema: '{}' },
    },
  });
  assert.equal(badFormat.isEmpty(), false);

  // enabled=true but empty outputSchema.
  const emptySchema = await runValidators(createAgentValidator, {
    body: {
      ...base,
      structuredOutput: { enabled: true, responseFormat: 'json_object', outputSchema: '   ' },
    },
  });
  assert.equal(emptySchema.isEmpty(), false);

  // outputSchema over the 5000-char cap.
  const tooLong = await runValidators(createAgentValidator, {
    body: {
      ...base,
      structuredOutput: {
        enabled: true,
        responseFormat: 'text',
        outputSchema: 'x'.repeat(5001),
      },
    },
  });
  assert.equal(tooLong.isEmpty(), false);

  // json_object with arbitrary JSON (not a JSON Schema object).
  const notSchema = await runValidators(createAgentValidator, {
    body: {
      ...base,
      structuredOutput: {
        enabled: true,
        responseFormat: 'json_object',
        outputSchema: '{"message":"hello","count":1,"active":true}',
      },
    },
  });
  assert.equal(notSchema.isEmpty(), false);

  // json_object with boolean JSON Schema (object-only constraint).
  const booleanSchema = await runValidators(createAgentValidator, {
    body: {
      ...base,
      structuredOutput: {
        enabled: true,
        responseFormat: 'json_object',
        outputSchema: 'true',
      },
    },
  });
  assert.equal(booleanSchema.isEmpty(), false);
});

test('createAgentValidator: termination strategy, retries, and rate limiting branches', async () => {
  const ok = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      terminationStrategy: { type: 'maximum_iterations', maximum_iterations: 5 },
      retries: { enabled: true, max_retries: 2 },
      rateLimiting: { enabled: true, max_requests_per_minute: 30 },
      functionChoiceBehavior: 'auto',
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const badTermination = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, terminationStrategy: { type: 'bogus' } },
  });
  assert.equal(badTermination.isEmpty(), false);

  const badRetries = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, retries: { enabled: true, max_retries: 99 } },
  });
  assert.equal(badRetries.isEmpty(), false);
});

test('updateAgentValidator: structuredOutput and terminationStrategy update paths', async () => {
  const ok = await runValidators(updateAgentValidator, {
    body: {
      structuredOutput: { enabled: true, responseFormat: 'json_object', outputSchema: '{}' },
      terminationStrategy: { type: 'maximum_iterations', maximum_iterations: 3 },
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const badStructured = await runValidators(updateAgentValidator, {
    body: { structuredOutput: { enabled: true, responseFormat: 'yaml', outputSchema: '{}' } },
  });
  assert.equal(badStructured.isEmpty(), false);
});

test('createAgentValidator: requirements shape validation branches', async () => {
  const ok = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      requirements: {
        knowledgeBases: [
          {
            id: UUID,
            label: ' Customer KB ',
            description: 'Primary KB',
            required: true,
          },
        ],
      },
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const badReq = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      requirements: { knowledgeBases: [{ id: 'not-uuid', label: 'x', description: 'd' }] },
    },
  });
  assert.equal(badReq.isEmpty(), false);
});

// ----------------------------------------------------------------- agentTeam
test('createAgentTeamValidator: valid team passes; bad policy/members fail', async () => {
  const ok = await runValidators(createAgentTeamValidator, {
    body: {
      name: 'team',
      orchestrationPolicy: 'coordinate',
      manager: { name: 'mgr', systemPrompt: 'lead', modelId: 'm1' },
      members: [{ memberType: 'agent', memberId: 'a1' }],
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const badPolicy = await runValidators(createAgentTeamValidator, {
    body: { name: 'team', orchestrationPolicy: 'invalid', manager: { name: 'm', systemPrompt: 's' }, members: [] },
  });
  assert.equal(badPolicy.isEmpty(), false);
});

test('updateAgentTeamValidator: optional members + manager model nullable', async () => {
  const res = await runValidators(updateAgentTeamValidator, {
    body: { manager: { modelId: null }, name: 'renamed' },
  });
  assert.equal(res.isEmpty(), true, validationMessages(res));
});

// --------------------------------------------------------------- memory ctx
const VALID_AGENT_BASE = { name: 'a', role: 'r', systemPrompt: 's', modelId: 'm1' };

test('memoryContext validators: summary_refresh_every_turns accepts 0 (always-summarize sentinel)', async () => {
  const ok = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      memoryContext: { type: 'summary_buffer', summary_refresh_every_turns: 0 },
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const okUpd = await runValidators(updateAgentTeamValidator, {
    body: { memoryContext: { type: 'summary_buffer', summary_refresh_every_turns: 0 } },
  });
  assert.equal(okUpd.isEmpty(), true, validationMessages(okUpd));
});

test('memoryContext validators: summary_token_limit accepts 0 (default) and >=64; rejects 1..63', async () => {
  // 0 is the "use server default" sentinel — accepted.
  const okZero = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, memoryContext: { type: 'summary', summary_token_limit: 0 } },
  });
  assert.equal(okZero.isEmpty(), true, validationMessages(okZero));

  // 64 is the floor — accepted.
  const okFloor = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, memoryContext: { type: 'summary', summary_token_limit: 64 } },
  });
  assert.equal(okFloor.isEmpty(), true, validationMessages(okFloor));

  // 32 is non-zero but below floor — rejected.
  const tooSmall = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, memoryContext: { type: 'summary', summary_token_limit: 32 } },
  });
  assert.equal(tooSmall.isEmpty(), false);

  // Same rule on the team-create and team-update paths.
  const teamCreate = await runValidators(createAgentTeamValidator, {
    body: {
      name: 't',
      orchestrationPolicy: 'sequential',
      members: [{ memberType: 'agent', memberId: 'a' }],
      memoryContext: { type: 'summary', summary_token_limit: 50 },
    },
  });
  assert.equal(teamCreate.isEmpty(), false);

  const teamUpd = await runValidators(updateAgentTeamValidator, {
    body: { memoryContext: { type: 'summary', summary_token_limit: 50 } },
  });
  assert.equal(teamUpd.isEmpty(), false);
});

test('memoryContext validators: summary_token_limit string-"0" and "64" pass; "32" rejected', async () => {
  // express-validator can pass the value as a string when the body
  // went through a permissive parser. The custom check must coerce
  // (Number(v)) before strict-equality comparison.
  const okStrZero = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, memoryContext: { type: 'summary', summary_token_limit: '0' } },
  });
  assert.equal(okStrZero.isEmpty(), true, validationMessages(okStrZero));

  const okStrFloor = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, memoryContext: { type: 'summary', summary_token_limit: '64' } },
  });
  assert.equal(okStrFloor.isEmpty(), true, validationMessages(okStrFloor));

  const tooSmallStr = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, memoryContext: { type: 'summary', summary_token_limit: '32' } },
  });
  assert.equal(tooSmallStr.isEmpty(), false);
});

test('memoryContext validators: message_window_limit rejects 0 (UI/API alignment); accepts 1..200', async () => {
  // Was previously min:0 with a "0 = unlimited" semantic — dropped to
  // close the round-trip ambiguity (UI input is 1..200, the magic
  // unlimited mode was never reachable from the form).
  const tooSmall = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, memoryContext: { type: 'window', message_window_limit: 0 } },
  });
  assert.equal(tooSmall.isEmpty(), false);

  const okFloor = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, memoryContext: { type: 'window', message_window_limit: 1 } },
  });
  assert.equal(okFloor.isEmpty(), true, validationMessages(okFloor));

  const okMid = await runValidators(updateAgentTeamValidator, {
    body: { memoryContext: { type: 'window', message_window_limit: 50 } },
  });
  assert.equal(okMid.isEmpty(), true, validationMessages(okMid));

  // Team update path likewise rejects 0.
  const teamZero = await runValidators(updateAgentTeamValidator, {
    body: { memoryContext: { type: 'window', message_window_limit: 0 } },
  });
  assert.equal(teamZero.isEmpty(), false);
});

test('validateTeamManagerModelSelection: guards manager model selection', () => {
  assert.equal(runMiddleware(validateTeamManagerModelSelection('create'), {}).nextCalled, true);
  assert.equal(runMiddleware(validateTeamManagerModelSelection('create'), { manager: {} }).status, 400);
  assert.equal(
    runMiddleware(validateTeamManagerModelSelection('create'), { manager: { modelClass: 'fast' } }).nextCalled,
    true,
  );
  assert.equal(
    runMiddleware(validateTeamManagerModelSelection('update'), { manager: { modelId: null, modelClass: null } }).status,
    400,
  );
  assert.equal(
    runMiddleware(validateTeamManagerModelSelection('create'), { manager: { agent_id: 'ag-1' } }).nextCalled,
    true,
  );
});

test('createAgentTeamValidator: manager agent_id reference and a2a server branches', async () => {
  const refManager = await runValidators(createAgentTeamValidator, {
    body: {
      name: 'team',
      manager: { agent_id: 'ag-1' },
      members: [{ memberType: 'agent', memberId: 'a1' }],
    },
  });
  assert.equal(refManager.isEmpty(), true, validationMessages(refManager));

  const a2aOk = await runValidators(createAgentTeamValidator, {
    body: {
      name: 'team',
      manager: { name: 'mgr', systemPrompt: 'lead', modelId: 'm1' },
      members: [{ memberType: 'agent', memberId: 'a1' }],
      a2aServer: { enabled: true, server_url: 'https://a2a.example.com' },
    },
  });
  assert.equal(a2aOk.isEmpty(), true, validationMessages(a2aOk));

  const a2aBad = await runValidators(createAgentTeamValidator, {
    body: {
      name: 'team',
      manager: { name: 'mgr', systemPrompt: 'lead', modelId: 'm1' },
      members: [{ memberType: 'agent', memberId: 'a1' }],
      a2aServer: { enabled: true, server_url: '   ' },
    },
  });
  assert.equal(a2aBad.isEmpty(), false);
});

test('updateAgentTeamValidator: partial manager patch and invalid manager object', async () => {
  const partial = await runValidators(updateAgentTeamValidator, {
    body: { manager: { name: 'Renamed Manager' } },
  });
  assert.equal(partial.isEmpty(), true, validationMessages(partial));

  const badManager = await runValidators(updateAgentTeamValidator, {
    body: { manager: 'not-an-object' },
  });
  assert.equal(badManager.isEmpty(), false);
});

// ---------------------------------------------------------------- credential
test('credential validators: create/update/rotate', async () => {
  const ok = await runValidators(createCredentialValidator, {
    body: { name: 'cred', provider: 'openai', secretData: { api_key: 'sk' }, expiresAt: '2030-01-01T00:00:00Z' },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const missingSecret = await runValidators(createCredentialValidator, { body: { name: 'c', provider: 'p' } });
  assert.equal(missingSecret.isEmpty(), false);

  const badDate = await runValidators(updateCredentialValidator, { body: { expiresAt: 'not-a-date' } });
  assert.equal(badDate.isEmpty(), false);

  const rotateOk = await runValidators(rotateCredentialValidator, { body: { secretData: { api_key: 'x' } } });
  assert.equal(rotateOk.isEmpty(), true, validationMessages(rotateOk));
  const rotateBad = await runValidators(rotateCredentialValidator, { body: {} });
  assert.equal(rotateBad.isEmpty(), false);
});

// --------------------------------------------------------------------- model
test('model validators: provider enum + uuid credential + numeric limits', async () => {
  const ok = await runValidators(createModelValidator, {
    body: {
      name: 'gpt',
      provider: 'openai',
      credentialId: UUID,
      modelType: 'llm',
      limits: { tpm: 1000, timeout: 30 },
      model_info: { size: 7 },
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  // Bifrost-native providers added to the allow-list are accepted.
  for (const provider of ['cohere', 'perplexity', 'huggingface', 'fireworks']) {
    const okProvider = await runValidators(createModelValidator, {
      body: { name: 'm', provider, credentialId: UUID },
    });
    assert.equal(okProvider.isEmpty(), true, validationMessages(okProvider));
  }

  const badProvider = await runValidators(createModelValidator, { body: { name: 'm', provider: 'nope' } });
  assert.equal(badProvider.isEmpty(), false);

  const badUuid = await runValidators(updateModelValidator, { body: { credentialId: 'not-uuid' } });
  assert.equal(badUuid.isEmpty(), false);
});

// ------------------------------------------------------------------ mcpServer
test('createMCPServerValidator: managed requires valid catalogId', async () => {
  const managedOk = await runValidators(createMCPServerValidator, {
    body: { name: 'srv', deploymentType: 'managed', catalogId: 'web_search_mcp', managedConfig: { resourcePreset: 'small' } },
  });
  assert.equal(managedOk.isEmpty(), true, validationMessages(managedOk));

  const managedBad = await runValidators(createMCPServerValidator, {
    body: { name: 'srv', deploymentType: 'managed', catalogId: 'unknown_catalog' },
  });
  assert.equal(managedBad.isEmpty(), false);

  // catalogId is `.optional()`, so a missing value short-circuits the custom
  // check; the managed-without-catalogId gap passes shape validation.
  const managedNoCatalog = await runValidators(createMCPServerValidator, {
    body: { name: 'srv', deploymentType: 'managed' },
  });
  assert.equal(managedNoCatalog.isEmpty(), true, validationMessages(managedNoCatalog));
});

test('createMCPServerValidator: remote requires transport + url/command', async () => {
  const httpOk = await runValidators(createMCPServerValidator, {
    body: { name: 'srv', deploymentType: 'remote', transport: 'http', url: 'http://x' },
  });
  assert.equal(httpOk.isEmpty(), true, validationMessages(httpOk));

  const stdioOk = await runValidators(createMCPServerValidator, {
    body: { name: 'srv', deploymentType: 'remote', transport: 'stdio', command: 'run' },
  });
  assert.equal(stdioOk.isEmpty(), true, validationMessages(stdioOk));

  const noTransport = await runValidators(createMCPServerValidator, { body: { name: 'srv', deploymentType: 'remote' } });
  assert.equal(noTransport.isEmpty(), false);

  const httpNoUrl = await runValidators(createMCPServerValidator, {
    body: { name: 'srv', deploymentType: 'remote', transport: 'http' },
  });
  assert.equal(httpNoUrl.isEmpty(), false);

  const badName = await runValidators(createMCPServerValidator, {
    body: { name: 'bad name!', transport: 'http', url: 'http://x' },
  });
  assert.equal(badName.isEmpty(), false);
});

test('updateMCPServerValidator: transport switch guards', async () => {
  const ok = await runValidators(updateMCPServerValidator, { body: { description: 'just a tweak' } });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const stdioNoCommand = await runValidators(updateMCPServerValidator, {
    body: { transport: 'stdio', url: 'http://old', command: '' },
  });
  assert.equal(stdioNoCommand.isEmpty(), false);

  const httpNoUrl = await runValidators(updateMCPServerValidator, {
    body: { transport: 'http', command: 'old-cmd' },
  });
  assert.equal(httpNoUrl.isEmpty(), false);

  const emptyUrl = await runValidators(updateMCPServerValidator, {
    body: { transport: 'sse', url: '' },
  });
  assert.equal(emptyUrl.isEmpty(), false);
});

// ------------------------------------------------------------------- pipeline
test('pipeline validators: graph structure rules', async () => {
  const graph = {
    nodes: [{ id: 'n1', type: 'source' }, { id: 'n2', type: 'sink' }],
    edges: [{ from: 'n1', to: 'n2' }],
  };
  const ok = await runValidators(createPipelineValidator, { body: { name: 'p', graph } });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const noGraph = await runValidators(createPipelineValidator, { body: { name: 'p' } });
  assert.equal(noGraph.isEmpty(), false);

  const dupNodes = await runValidators(createPipelineValidator, {
    body: { name: 'p', graph: { nodes: [{ id: 'n1', type: 't' }, { id: 'n1', type: 't' }], edges: [] } },
  });
  assert.equal(dupNodes.isEmpty(), false);

  const danglingEdge = await runValidators(createPipelineValidator, {
    body: { name: 'p', graph: { nodes: [{ id: 'n1', type: 't' }], edges: [{ from: 'n1', to: 'ghost' }] } },
  });
  assert.equal(danglingEdge.isEmpty(), false);

  const updateNoGraph = await runValidators(updatePipelineValidator, { body: { name: 'renamed' } });
  assert.equal(updateNoGraph.isEmpty(), true, validationMessages(updateNoGraph));

  const missingNodeId = await runValidators(createPipelineValidator, {
    body: { name: 'p', graph: { nodes: [{ type: 't' }], edges: [] } },
  });
  assert.equal(missingNodeId.isEmpty(), false);

  const missingEdgeEndpoints = await runValidators(createPipelineValidator, {
    body: { name: 'p', graph: { nodes: [{ id: 'n1', type: 't' }], edges: [{ from: 'n1' }] } },
  });
  assert.equal(missingEdgeEndpoints.isEmpty(), false);

  const notObject = await runValidators(createPipelineValidator, { body: { name: 'p', graph: 'bad' } });
  assert.equal(notObject.isEmpty(), false);
});

// ------------------------------------------------------------------- manifest
test('manifest validators: file lists, status, metadata, uris', async () => {
  assert.equal((await runValidators(addFilesValidator, { body: { fileNames: ['a.txt'] } })).isEmpty(), true);
  // `.notEmpty()` only catches a missing field, not an empty array.
  assert.equal((await runValidators(addFilesValidator, { body: {} })).isEmpty(), false);
  assert.equal((await runValidators(addFilesValidator, { body: { fileNames: [123] } })).isEmpty(), false);

  assert.equal((await runValidators(updateStatusValidator, { body: { status: 'committed' } })).isEmpty(), true);
  assert.equal((await runValidators(updateStatusValidator, { body: { status: 'bogus' } })).isEmpty(), false);

  assert.equal((await runValidators(updateMetadataValidator, { body: { metadata: { a: 1 } } })).isEmpty(), true);
  assert.equal((await runValidators(updateMetadataValidator, { body: { metadata: 'no' } })).isEmpty(), false);

  assert.equal((await runValidators(replaceManifestSourceUrisValidator, { body: { uris: ['s3://b/k'] } })).isEmpty(), true);
  const tooMany = Array.from({ length: 2001 }, (_, i) => `s3://b/${i}`);
  assert.equal((await runValidators(replaceManifestSourceUrisValidator, { body: { uris: tooMany } })).isEmpty(), false);

  assert.equal((await runValidators(appendManifestSourceUrisValidator, { body: { uris: ['s3://b/k'] } })).isEmpty(), true);
  assert.equal((await runValidators(appendManifestSourceUrisValidator, { body: {} })).isEmpty(), false);
});

// ------------------------------------------------------------------ provider
test('updateProviderProxyValidator: accepts positive integers', async () => {
  const ok = await runValidators(updateProviderProxyValidator, {
    body: { concurrentRequests: 4, bufferSize: 8 },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));
});

test('updateProviderProxyValidator: rejects missing and non-positive fields', async () => {
  assert.equal((await runValidators(updateProviderProxyValidator, { body: {} })).isEmpty(), false);
  assert.equal(
    (await runValidators(updateProviderProxyValidator, { body: { concurrentRequests: 0, bufferSize: 1 } }))
      .isEmpty(),
    false,
  );
  assert.equal(
    (await runValidators(updateProviderProxyValidator, { body: { concurrentRequests: 1, bufferSize: -2 } }))
      .isEmpty(),
    false,
  );
});

// ----------------------------------------------------------- agentValidator gaps
test('createAgentValidator: guardrails and termination strategy branches', async () => {
  const badGuardrailUuid = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      guardrails: {
        enabled: true,
        input_guardrails: [{ guardrail_id: 'not-a-uuid' }],
      },
    },
  });
  assert.equal(badGuardrailUuid.isEmpty(), false);

  const toolPolicy = await runValidators(createAgentValidator, {
    body: { ...VALID_AGENT_BASE, guardrails: { tool_policy: 'block' } },
  });
  assert.equal(toolPolicy.isEmpty(), false);
  assert.match(validationMessages(toolPolicy), /tool_policy is no longer supported/);

  const keywordOk = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      terminationStrategy: { type: 'keyword', keywords: ['STOP'] },
    },
  });
  assert.equal(keywordOk.isEmpty(), true, validationMessages(keywordOk));

  const timeoutOk = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      terminationStrategy: { type: 'timeout', timeout_seconds: 30 },
    },
  });
  assert.equal(timeoutOk.isEmpty(), true, validationMessages(timeoutOk));

  const aggregatorOk = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      terminationStrategy: {
        type: 'aggregator',
        condition: 'any',
        sub_strategies: [{ type: 'keyword', keywords: ['done'] }],
      },
    },
  });
  assert.equal(aggregatorOk.isEmpty(), true, validationMessages(aggregatorOk));

  const nestedAggregator = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      terminationStrategy: {
        type: 'aggregator',
        condition: 'all',
        sub_strategies: [{ type: 'aggregator', condition: 'any', sub_strategies: [] }],
      },
    },
  });
  assert.equal(nestedAggregator.isEmpty(), false);
});

test('createAgentValidator: requirements mcpServers and duplicate ids', async () => {
  const mcpReq = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      requirements: {
        mcpServers: [{ id: UUID, label: ' MCP ', description: 'Primary MCP', required: false }],
      },
    },
  });
  assert.equal(mcpReq.isEmpty(), true, validationMessages(mcpReq));

  const unknownKey = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      requirements: { unknownList: [] },
    },
  });
  assert.equal(unknownKey.isEmpty(), false);

  const duplicate = await runValidators(createAgentValidator, {
    body: {
      ...VALID_AGENT_BASE,
      requirements: {
        knowledgeBases: [
          { id: UUID, label: 'A', description: 'd', required: true },
          { id: UUID, label: 'B', description: 'd', required: false },
        ],
      },
    },
  });
  assert.equal(duplicate.isEmpty(), false);
  assert.match(validationMessages(duplicate), /duplicate id/);
});

test('updateAgentValidator: summary_token_limit string coercion on update path', async () => {
  const ok = await runValidators(updateAgentValidator, {
    body: { memoryContext: { type: 'summary', summary_token_limit: '128' } },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const bad = await runValidators(updateAgentValidator, {
    body: { memoryContext: { type: 'summary', summary_token_limit: '32' } },
  });
  assert.equal(bad.isEmpty(), false);
});

test('validateAgentModelSelection: update accepts modelClass-only patch', () => {
  assert.equal(
    runMiddleware(validateAgentModelSelection('update'), { modelId: null, modelClass: 'fast' }).nextCalled,
    true,
  );
  assert.equal(runMiddleware(validateAgentModelSelection('create'), { modelClass: 'fast' }).nextCalled, true);
});
