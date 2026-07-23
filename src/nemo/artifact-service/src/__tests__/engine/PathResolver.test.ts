import { PathResolver } from '../../engine/PathResolver';

describe('PathResolver', () => {
  const paths = new PathResolver('/tmp/agent-studio-test');

  it('builds repo path under projects/{pid}/artifacts/{storeId}', () => {
    expect(paths.repoDir('proj1', 'asabc12345')).toBe(
      '/tmp/agent-studio-test/projects/proj1/artifacts/asabc12345',
    );
  });

  it('builds project-scoped blobs path', () => {
    expect(paths.blobsDir('proj1')).toBe(
      '/tmp/agent-studio-test/projects/proj1/artifacts/_blobs',
    );
  });

  it('shards CAS blob path by sha prefix', () => {
    const sha = '0011223344556677889900112233445566778899001122334455667788990011';
    expect(paths.blobPath('proj1', sha)).toBe(
      `/tmp/agent-studio-test/projects/proj1/artifacts/_blobs/sha256/00/11/${sha}`,
    );
  });

  it('rejects path traversal in projectId', () => {
    expect(() => paths.repoDir('../etc', 'asabc12345')).toThrow();
  });

  it('rejects path traversal in storeId', () => {
    expect(() => paths.repoDir('proj1', '../escape')).toThrow();
  });

  it('rejects non-hex sha256', () => {
    expect(() => paths.blobPath('proj1', 'not-a-hash')).toThrow();
  });
});
