import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { S3Client, PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const S3_ENDPOINT = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || 'http://minio:9000';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || 'minioadmin';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || process.env.MINIO_SECRET_KEY || 'minioadmin';
const S3_REGION = process.env.S3_REGION || process.env.MINIO_REGION || 'us-east-1';
const DEFAULT_BUCKET = process.env.S3_DEFAULT_BUCKET || process.env.MINIO_DEFAULT_BUCKET || 'nemo-datasets';

export const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
  forcePathStyle: true,
  maxAttempts: 3,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 10_000,
    socketTimeout: 120_000,
  }),
});

/**
 * Create an S3 client with a custom deployment endpoint
 * @param deploymentEndpoint - Full URL of the deployment endpoint (e.g., "https://us-east-1.s3.agentstudio.io")
 * @returns S3Client configured for that deployment
 */
/**
 * Map a deployment/API hostname to the S3 gateway hostname.
 * The console defaults to app.{apex} while S3 is s3.{apex}. Blindly prepending
 * "s3." to app.agentstudio.local yields s3.app.agentstudio.local (invalid DNS).
 */
export function hostnameToS3GatewayHostname(hostname: string): string {
  if (hostname.startsWith('s3.')) {
    return hostname;
  }
  if (hostname.startsWith('app.')) {
    return `s3.${hostname.slice(4)}`;
  }
  return `s3.${hostname}`;
}

/**
 * Full deployment base URL (e.g. https://app.agentstudio.local:8443) → S3 gateway base URL (https://s3.agentstudio.local:8443).
 */
export function deploymentEndpointToS3GatewayUrl(deploymentEndpoint: string): string {
  try {
    const endpointUrl = new URL(deploymentEndpoint);
    endpointUrl.hostname = hostnameToS3GatewayHostname(endpointUrl.hostname);
    return `${endpointUrl.protocol}//${endpointUrl.hostname}${endpointUrl.port ? `:${endpointUrl.port}` : ''}`;
  } catch {
    const match = deploymentEndpoint.match(/^(https?:\/\/)([^\/:]+)(:\d+)?/);
    if (!match) {
      throw new Error(`Invalid deployment endpoint: ${deploymentEndpoint}`);
    }
    const [, protocol, host, port = ''] = match;
    const s3Host = hostnameToS3GatewayHostname(host);
    return `${protocol}${s3Host}${port}`;
  }
}

export function createS3ClientForDeployment(deploymentEndpoint: string): S3Client {
  return new S3Client({
    endpoint: deploymentEndpoint,
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    },
    forcePathStyle: true,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 10_000,
      socketTimeout: 120_000,
    }),
  });
}

export const S3_CONFIG = {
  DEFAULT_BUCKET,
  S3_ENDPOINT,
  S3_REGION,
};

/** Default timeout for bucket existence check/create (ms). Used only for non-default buckets (default is provisioned at install). */
const DEFAULT_BUCKET_CHECK_TIMEOUT_MS = 20_000;

/**
 * Ensure bucket exists, create if it doesn't.
 * Call only for non-default buckets; the app-level default bucket (e.g. default-nemo) is provisioned at install.
 * Uses a timeout to avoid hanging when S3/MinIO is slow or unreachable.
 */
export async function ensureBucketExists(
  bucketName: string,
  timeoutMs: number = DEFAULT_BUCKET_CHECK_TIMEOUT_MS
): Promise<void> {
  const doCheck = async (): Promise<void> => {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
      } else {
        throw error;
      }
    }
  };
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Bucket check/create for "${bucketName}" timed out after ${timeoutMs}ms (S3 may be slow or unreachable)`)),
      timeoutMs
    )
  );
  await Promise.race([doCheck(), timeout]);
}

/**
 * Create directory structure in S3 (by creating a placeholder object)
 */
export async function createDirectory(bucketName: string, prefix: string): Promise<void> {
  const key = `${prefix}/.keep`;
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: Buffer.from(''),
      })
    );
  } catch (error) {
    throw new Error(`Failed to create directory structure: ${error}`);
  }
}

/**
 * Generate pre-signed URL for file upload
 * @param bucketName - Name of the S3 bucket
 * @param key - S3 object key
 * @param expiresIn - URL expiration time in seconds (default: 3600)
 * @param deploymentEndpoint - Optional deployment endpoint URL. If provided, the presigned URL will point to s3.<endpoint>
 * @returns Presigned URL for uploading to S3
 */
export async function generatePresignedUrl(
  bucketName: string, 
  key: string, 
  expiresIn: number = 3600,
  deploymentEndpoint?: string
): Promise<string> {
  const putCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  // If deployment endpoint is provided, use it to create a client with the S3 gateway host
  if (deploymentEndpoint) {
    const s3Endpoint = deploymentEndpointToS3GatewayUrl(deploymentEndpoint);
    
    // Create S3 client with s3.<endpoint> format
    // The endpoint should be a full URL without trailing slash for forcePathStyle
    const deploymentClient = createS3ClientForDeployment(s3Endpoint);
    const presignedUrl = await getSignedUrl(deploymentClient, putCommand, { expiresIn });
    
    // Verify the presigned URL includes the hostname
    // AWS SDK should generate a full URL, but let's verify and fix if needed
    try {
      const presignedUrlObj = new URL(presignedUrl);
      // If the presigned URL already has a hostname, return it as-is
      if (presignedUrlObj.hostname) {
        return presignedUrl;
      }
    } catch {
      // If presigned URL is not a valid URL (might be relative), construct it manually
      try {
        const s3EndpointUrl = new URL(s3Endpoint);
        // With forcePathStyle, the path should be /bucket/key
        const path = `/${bucketName}/${encodeURIComponent(key)}`;
        // Extract query string from presigned URL if it exists (signature parameters)
        const queryMatch = presignedUrl.match(/\?.*$/);
        const queryString = queryMatch ? queryMatch[0] : '';
        const fullUrl = `${s3EndpointUrl.protocol}//${s3EndpointUrl.hostname}${s3EndpointUrl.port ? `:${s3EndpointUrl.port}` : ''}${path}${queryString}`;
        logger.info(`[Presigned URL] Constructed full URL: ${fullUrl}`);
        return fullUrl;
      } catch (error) {
        logger.warn('Failed to construct full presigned URL, returning original:', error);
        return presignedUrl;
      }
    }
    
    return presignedUrl;
  }

  // Default behavior: use the default S3 client
  return await getSignedUrl(s3Client, putCommand, { expiresIn });
}

