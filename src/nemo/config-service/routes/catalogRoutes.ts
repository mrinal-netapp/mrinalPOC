import { Router, Request, Response } from 'express';
import { MCP_SERVER_CATALOG, MCPServerCatalogEntry } from '../catalog/mcpServerCatalog';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const resolved = MCP_SERVER_CATALOG.map((entry) => {
    const defaults = entry.defaultEnvFn?.() ?? {};
    if (Object.keys(defaults).length === 0) return entry;

    const envSchema = entry.envSchema.map((env) => ({
      ...env,
      defaultValue: defaults[env.name] ?? env.defaultValue,
    }));

    const { defaultEnvFn: _fn, ...rest } = entry;
    return { ...rest, envSchema } as MCPServerCatalogEntry;
  });
  res.json(resolved);
});

export default router;
