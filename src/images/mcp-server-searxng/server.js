const http = require('http');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 8000);
const SEARXNG_URL = (process.env.SEARXNG_URL || process.env.SEARXNG_BASE_URL || '').replace(/\/$/, '');
const SEARXNG_TIMEOUT_MS = Number(process.env.SEARXNG_TIMEOUT_MS || 10000);
const SEARXNG_MAX_RESULTS = Number(process.env.SEARXNG_MAX_RESULTS || 5);
const SEARXNG_ENGINES = (process.env.SEARXNG_ENGINES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SEARXNG_SAFE_SEARCH = Number(process.env.SEARXNG_SAFE_SEARCH || 1);
const SEARXNG_PUBLIC_ENDPOINTS = (process.env.SEARXNG_PUBLIC_ENDPOINTS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const SEARXNG_AUTO_DISCOVER = String(process.env.SEARXNG_AUTO_DISCOVER || '').toLowerCase() === 'true';
const SEARXNG_DISCOVERY_URL = process.env.SEARXNG_DISCOVERY_URL || 'https://searx.space/data/instances.json';
const SEARXNG_DISCOVERY_CACHE_MS = Number(process.env.SEARXNG_DISCOVERY_CACHE_MS || 300000);
const SEARXNG_ENDPOINT_COOLDOWN_MS = Number(process.env.SEARXNG_ENDPOINT_COOLDOWN_MS || 60000);

let endpointCursor = 0;
const endpointCooldownUntil = new Map();
let discoveredEndpoints = [];
let discoveredAtMs = 0;

function writeJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function mcpError(res, id, code, message, status = 200) {
  writeJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function getFromPath(obj, path) {
  return path.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function extractPublicSearxUrls(instancesJson) {
  const urls = new Set();
  const candidatePaths = [
    ['instances'],
    ['instances', 'https'],
    ['instances', 'http'],
  ];
  for (const path of candidatePaths) {
    const node = getFromPath(instancesJson, path);
    if (!node) continue;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string' && item.startsWith('http')) urls.add(item.replace(/\/$/, ''));
        if (item && typeof item === 'object' && typeof item.url === 'string' && item.url.startsWith('http')) {
          urls.add(item.url.replace(/\/$/, ''));
        }
      }
    } else if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        const maybeUrl = key.startsWith('http') ? key : (value && typeof value.url === 'string' ? value.url : null);
        if (maybeUrl) urls.add(String(maybeUrl).replace(/\/$/, ''));
      }
    }
  }
  return [...urls];
}

async function discoverPublicEndpoints() {
  const now = Date.now();
  if (now - discoveredAtMs < SEARXNG_DISCOVERY_CACHE_MS && discoveredEndpoints.length > 0) {
    return discoveredEndpoints;
  }
  try {
    const resp = await fetch(SEARXNG_DISCOVERY_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'nemo-searxng-mcp/1.0' },
    });
    const raw = await resp.text();
    const data = raw ? JSON.parse(raw) : {};
    discoveredEndpoints = extractPublicSearxUrls(data);
    discoveredAtMs = now;
  } catch (e) {
    console.warn(`SearxNG endpoint discovery failed: ${e.message || e}`);
  }
  return discoveredEndpoints;
}

async function getEndpointPool() {
  const pool = [];
  if (SEARXNG_URL) pool.push(SEARXNG_URL);
  for (const p of SEARXNG_PUBLIC_ENDPOINTS) {
    if (!pool.includes(p)) pool.push(p);
  }
  if (SEARXNG_AUTO_DISCOVER) {
    const discovered = await discoverPublicEndpoints();
    for (const p of discovered) {
      if (!pool.includes(p)) pool.push(p);
    }
  }
  return pool;
}

function nextCandidateEndpoints(pool) {
  if (pool.length <= 1) return pool;
  endpointCursor = endpointCursor % pool.length;
  return [...pool.slice(endpointCursor), ...pool.slice(0, endpointCursor)];
}

async function queryEndpoint(baseUrl, query) {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', String(SEARXNG_SAFE_SEARCH));
  url.searchParams.set('language', 'en');
  url.searchParams.set('pageno', '1');
  if (SEARXNG_MAX_RESULTS > 0) url.searchParams.set('count', String(SEARXNG_MAX_RESULTS));
  if (SEARXNG_ENGINES.length > 0) url.searchParams.set('engines', SEARXNG_ENGINES.join(','));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARXNG_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'nemo-searxng-mcp/1.0',
      },
    });
    const raw = await resp.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      const snippet = raw.slice(0, 180).replace(/\s+/g, ' ').trim();
      throw new Error(`SearxNG returned non-JSON response (HTTP ${resp.status}): ${snippet}`);
    }
    if (!resp.ok) {
      throw new Error(data?.error || data?.message || `SearxNG HTTP ${resp.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function searxngSearch(args) {
  const query = String(args?.query || '').trim();
  if (!query) {
    throw new Error("Missing required argument 'query'");
  }

  const pool = await getEndpointPool();
  if (pool.length === 0) {
    throw new Error('No SearxNG endpoints configured. Set SEARXNG_URL or SEARXNG_AUTO_DISCOVER=true');
  }

  const candidates = nextCandidateEndpoints(pool);
  const failures = [];
  for (const endpoint of candidates) {
    const blockedUntil = endpointCooldownUntil.get(endpoint) || 0;
    if (Date.now() < blockedUntil) continue;

    try {
      const result = await queryEndpoint(endpoint, query);
      endpointCursor = (pool.indexOf(endpoint) + 1) % pool.length;
      return result;
    } catch (e) {
      endpointCooldownUntil.set(endpoint, Date.now() + SEARXNG_ENDPOINT_COOLDOWN_MS);
      failures.push(`${endpoint}: ${e.message || e}`);
    }
  }

  throw new Error(`All SearxNG endpoints failed. ${failures.slice(0, 3).join(' | ')}`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return writeJson(res, 200, { ok: true });
  }
  if (req.method !== 'POST' || req.url !== '/mcp') {
    return writeJson(res, 404, { error: 'Not found' });
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return mcpError(res, null, -32700, 'Parse error');
    }

    const id = payload?.id;
    const method = payload?.method;
    const sessionId = req.headers['mcp-session-id'] || randomUUID();
    const headers = { 'mcp-session-id': String(sessionId) };

    try {
      if (method === 'initialize') {
        const requested = payload?.params?.protocolVersion;
        const protocolVersion = requested || '2024-11-05';
        return writeJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'searxng-native-mcp', version: '1.0.0' },
          },
        }, headers);
      }

      if (method === 'notifications/initialized') {
        res.writeHead(202, headers);
        return res.end();
      }

      if (method === 'tools/list') {
        return writeJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [{
              name: 'searxng_search',
              description: 'Search the web through SearxNG and return raw JSON results.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Search query text' },
                },
                required: ['query'],
                additionalProperties: false,
              },
            }],
          },
        }, headers);
      }

      if (method === 'tools/call') {
        const toolName = payload?.params?.name;
        const args = payload?.params?.arguments || {};
        if (toolName !== 'searxng_search') {
          return mcpError(res, id, -32601, `Unknown tool: ${toolName}`);
        }
        const result = await searxngSearch(args);
        return writeJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        }, headers);
      }

      return mcpError(res, id, -32601, `Method not found: ${method}`);
    } catch (e) {
      return mcpError(res, id, -32000, e.message || 'Internal error');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`searxng-native-mcp listening on :${PORT}`);
});
