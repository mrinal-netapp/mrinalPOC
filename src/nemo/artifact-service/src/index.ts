import 'reflect-metadata';
import { Server, ArtifactServiceConfig } from './server/Server';
import {
  parsePort,
  parseLogLevel,
  createShutdownHandler,
  configure_observability_for_service,
} from '@agentstudio/common';
import { get_logger } from '@agentstudio/observability-client-runtime';
import { Db, dbConfigFromEnv } from './db/Db';
import { maybeCreateRedis } from './services/IdempotencyStore';

const port = parsePort(process.env.PORT, 8080);
const logLevel = parseLogLevel(process.env.LOG_LEVEL, 'info');
const storeRoot = process.env.NEMO_DEFAULT_STORE_ROOT;

configure_observability_for_service('artifact-service');
const logger = get_logger();

async function main() {
  const db = new Db(dbConfigFromEnv());
  const redis = await maybeCreateRedis();

  const config: ArtifactServiceConfig = {
    port,
    logLevel,
    storeRoot,
    db,
    redis,
  };

  logger.info('service_starting', {
    port,
    log_level: logLevel,
    store_root: storeRoot ?? '/mnt/pvcs/default-nemo',
    redis: redis ? 'enabled' : 'disabled',
  });

  const server = new Server(config);

  const shutdown = createShutdownHandler(async () => {
    await server.shutdown();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.start();
  logger.info('service_started', { port });
}

main().catch((err) => {
  get_logger().error('service_start_failed', { error: String(err) });
  process.exit(1);
});
