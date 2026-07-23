/**
 * Unit tests for utils/s3Utils.ts. The shared S3 client's `send` is stubbed
 * via mock.method; the presigner is module-mocked for the presigned-URL path.
 *
 * Run: node --require ts-node/register --test tests/s3Utils.unit.test.ts
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  hostnameToS3GatewayHostname,
  deploymentEndpointToS3GatewayUrl,
  S3_CONFIG,
  s3Client,
  ensureBucketExists,
  createDirectory,
  createS3ClientForDeployment,
} from '../utils/s3Utils';
import { mockModule, loadFresh, clearModule } from './helpers/moduleMock';

afterEach(() => mock.restoreAll());

test('hostnameToS3GatewayHostname: maps app./s3./other hosts', () => {
  assert.equal(hostnameToS3GatewayHostname('s3.example.com'), 's3.example.com');
  assert.equal(hostnameToS3GatewayHostname('app.example.com'), 's3.example.com');
  assert.equal(hostnameToS3GatewayHostname('example.com'), 's3.example.com');
});

test('deploymentEndpointToS3GatewayUrl: URL + port + invalid', () => {
  assert.equal(deploymentEndpointToS3GatewayUrl('https://app.agentstudio.local:8443'), 'https://s3.agentstudio.local:8443');
  assert.equal(deploymentEndpointToS3GatewayUrl('http://app.local'), 'http://s3.local');
  assert.throws(() => deploymentEndpointToS3GatewayUrl('not a url'), /Invalid deployment endpoint/);
});

test('deploymentEndpointToS3GatewayUrl: regex fallback for malformed URL strings', () => {
  assert.equal(
    deploymentEndpointToS3GatewayUrl('https://app.example.com:8443/extra/path'),
    'https://s3.example.com:8443',
  );
  assert.equal(
    deploymentEndpointToS3GatewayUrl('http://app.local:9000'),
    'http://s3.local:9000',
  );
  assert.equal(
    deploymentEndpointToS3GatewayUrl('https://app.example.com:not-a-port'),
    'https://s3.example.com',
  );
});

test('S3_CONFIG + createS3ClientForDeployment expose configuration', () => {
  assert.ok(S3_CONFIG.DEFAULT_BUCKET);
  assert.ok(S3_CONFIG.S3_ENDPOINT);
  const client = createS3ClientForDeployment('https://s3.example.com');
  assert.ok(client);
});

test('ensureBucketExists: no-op when bucket exists', async () => {
  mock.method(s3Client, 'send', async () => ({}));
  await ensureBucketExists('my-bucket');
});

test('ensureBucketExists: creates bucket on NotFound', async () => {
  let calls = 0;
  mock.method(s3Client, 'send', async (cmd: any) => {
    calls++;
    if (calls === 1) {
      const err: any = new Error('missing');
      err.name = 'NotFound';
      throw err;
    }
    return {};
  });
  await ensureBucketExists('new-bucket');
  assert.equal(calls, 2);
});

test('ensureBucketExists: rethrows non-NotFound errors', async () => {
  mock.method(s3Client, 'send', async () => {
    const err: any = new Error('AccessDenied');
    err.name = 'AccessDenied';
    throw err;
  });
  await assert.rejects(() => ensureBucketExists('x', 5000), /AccessDenied/);
});

test('ensureBucketExists: rejects when the check times out', async () => {
  mock.method(s3Client, 'send', () => new Promise(() => {}));
  await assert.rejects(() => ensureBucketExists('slow', 20), /timed out/);
});

test('createDirectory: puts placeholder; wraps errors', async () => {
  mock.method(s3Client, 'send', async () => ({}));
  await createDirectory('bucket', 'projects/p1');

  mock.restoreAll();
  mock.method(s3Client, 'send', async () => {
    throw new Error('boom');
  });
  await assert.rejects(() => createDirectory('bucket', 'projects/p1'), /Failed to create directory structure/);
});

test('generatePresignedUrl: default + deployment endpoint paths', async () => {
  const restore = mockModule('@aws-sdk/s3-request-presigner', {
    getSignedUrl: async () => 'https://s3.example.com/bucket/key?X-Amz-Signature=abc',
  });
  let restoreGetSignedUrl: (() => void) | undefined;
  try {
    const fresh = loadFresh('utils/s3Utils');
    mock.method(fresh.s3Client, 'send', async () => ({}));
    const url = await fresh.generatePresignedUrl('bucket', 'key');
    assert.match(url, /X-Amz-Signature/);
    const url2 = await fresh.generatePresignedUrl('bucket', 'key', 3600, 'https://app.agentstudio.local:8443');
    assert.match(url2, /X-Amz-Signature/);

    restoreGetSignedUrl = mockModule('@aws-sdk/s3-request-presigner', {
      getSignedUrl: async () => '/bucket/key?X-Amz-Signature=relative',
    });
    clearModule('utils/s3Utils');
    const fresh2 = loadFresh('utils/s3Utils');
    mock.method(fresh2.s3Client, 'send', async () => ({}));
    const relative = await fresh2.generatePresignedUrl(
      'bucket',
      'key',
      3600,
      'https://app.agentstudio.local:8443',
    );
    assert.match(relative, /^https:\/\/s3\.agentstudio\.local:8443\/bucket\//);
  } finally {
    restoreGetSignedUrl?.();
    restore();
    clearModule('utils/s3Utils');
  }
});
