const http = require('http');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 8000);
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const TAVILY_TIMEOUT_MS = Number(process.env.TAVILY_TIMEOUT_MS || 10000);
const TAVILY_MAX_RESULTS = Number(process.env.TAVILY_MAX_RESULTS || 5);
const TAVILY_ALLOWED_DOMAINS = (process.env.TAVILY_ALLOWED_DOMAINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

async function tavilySearch(args) {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY is not configured');
  }
  const query = String(args?.query || '').trim();
  if (!query) {
    throw new Error("Missing required argument 'query'");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  try {
    const body = {
      api_key: TAVILY_API_KEY,
      query,
      max_results: TAVILY_MAX_RESULTS,
    };
    if (TAVILY_ALLOWED_DOMAINS.length > 0) {
      body.include_domains = TAVILY_ALLOWED_DOMAINS;
    }

    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.detail || data?.error || `Tavily HTTP ${resp.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
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
            serverInfo: { name: 'tavily-native-mcp', version: '1.0.0' },
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
              name: 'tavily_search',
              description: 'Search the web using Tavily and return structured results.',
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
        if (toolName !== 'tavily_search') {
          return mcpError(res, id, -32601, `Unknown tool: ${toolName}`);
        }
        const result = await tavilySearch(args);
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
  console.log(`tavily-native-mcp listening on :${PORT}`);
});
