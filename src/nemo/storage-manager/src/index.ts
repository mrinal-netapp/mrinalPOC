import { Server, ServerConfig } from './server/Server';
import { parsePort, parseLogLevel, createShutdownHandler, configure_observability_for_service } from '@agentstudio/common';
import { get_logger } from '@agentstudio/observability-client-runtime';

const port = parsePort(process.env.PORT, 8080);
const configService = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';
// DEPLOYMENT_ID and REGION are optional for nemo deployment (defaults provided)
const deploymentID = process.env.DEPLOYMENT_ID || 'nemo';
const region = process.env.REGION || 'us-east-1';
// Parse CONFIG_SYNC_INTERVAL (can be "30s" or milliseconds)
const configSyncIntervalStr = process.env.CONFIG_SYNC_INTERVAL || '30000';
const configSyncInterval = configSyncIntervalStr.endsWith('s')
  ? parseInt(configSyncIntervalStr.slice(0, -1), 10) * 1000
  : parseInt(configSyncIntervalStr, 10);
const logLevel = parseLogLevel(process.env.LOG_LEVEL, 'info');
const k8sNamespace = process.env.K8S_NAMESPACE || process.env.NAMESPACE || 'default';
const kubeconfigPath = process.env.KUBECONFIG_PATH; // Optional, uses in-cluster config if not set

// Note: DEPLOYMENT_ID and REGION are no longer required to be non-empty
// They default to 'nemo' and 'us-east-1' respectively for nemo deployments

// Initialise observability (file logs, OTel traces, Prometheus RED metrics on dedicated port)
configure_observability_for_service('storage-manager');
const logger = get_logger();

const config: ServerConfig = {
  port,
  configService,
  deploymentID,
  region,
  configSyncInterval,
  logLevel,
  k8sNamespace,
  kubeconfigPath
};

logger.info('service_starting', {
  deployment_id: deploymentID,
  region,
  port,
  config_service: configService,
  config_sync_interval_ms: configSyncInterval,
  log_level: logLevel,
  k8s_namespace: k8sNamespace,
  kubeconfig_path: kubeconfigPath ?? 'in-cluster',
});

const server = new Server(config);

// Graceful shutdown
const shutdown = createShutdownHandler(async () => {
  await server.shutdown();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
server
  .start()
  .then(() => {
    logger.info('service_started', { port });
  })
  .catch((error) => {
    logger.error('service_start_failed', { error: String(error) });
    process.exit(1);
  });

