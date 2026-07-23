import { CommitBuilder } from '../../engine/CommitBuilder';
import { RequestContext } from '../../types/Principal';

const baseCtx: RequestContext = {
  principal: { kind: 'agent', id: 'asabc12345' },
  projectId: 'proj1',
  sessionId: 'sess-1',
  agentId: 'asabc12345',
};

describe('CommitBuilder', () => {
  it('always emits X-Principal and X-Op trailers', () => {
    const msg = CommitBuilder.buildMessage({ ctx: baseCtx, op: 'write', subject: 'hello' });
    const trailers = CommitBuilder.parseTrailers(msg);
    expect(trailers['X-Principal']).toBe('agent:asabc12345');
    expect(trailers['X-Op']).toBe('write');
  });

  it('includes session/agent/team ids when supplied', () => {
    const ctx: RequestContext = { ...baseCtx, teamId: 'team-1' };
    const msg = CommitBuilder.buildMessage({ ctx, op: 'tag', subject: 'v1' });
    const trailers = CommitBuilder.parseTrailers(msg);
    expect(trailers['X-Session-Id']).toBe('sess-1');
    expect(trailers['X-Agent-Id']).toBe('asabc12345');
    expect(trailers['X-Team-Id']).toBe('team-1');
  });

  it('omits optional trailers when absent', () => {
    const ctx: RequestContext = {
      principal: { kind: 'user', id: 'u1' },
      projectId: 'p1',
    };
    const msg = CommitBuilder.buildMessage({ ctx, op: 'merge' });
    const trailers = CommitBuilder.parseTrailers(msg);
    expect(trailers['X-Session-Id']).toBeUndefined();
    expect(trailers['X-Agent-Id']).toBeUndefined();
    expect(trailers['X-Team-Id']).toBeUndefined();
    expect(trailers['X-Idempotency-Key']).toBeUndefined();
  });

  it('round-trips an idempotency key through trailers', () => {
    const ctx: RequestContext = { ...baseCtx, idempotencyKey: 'abc-123' };
    const msg = CommitBuilder.buildMessage({ ctx, op: 'write' });
    expect(CommitBuilder.parseTrailers(msg)['X-Idempotency-Key']).toBe('abc-123');
  });

  it('uses op-specific default subject when none supplied', () => {
    const msg = CommitBuilder.buildMessage({ ctx: baseCtx, op: 'revert' });
    expect(msg.split('\n')[0]).toBe('artifact: revert');
  });

  it('builds an author with sensible defaults from the principal', () => {
    const author = CommitBuilder.buildAuthor({
      principal: { kind: 'agent', id: 'asabc12345', displayName: 'demo-agent' },
    });
    expect(author.name).toBe('demo-agent');
    expect(author.email).toBe('agent+asabc12345@artifact-service.invalid');
    expect(typeof author.timestamp).toBe('number');
  });

  it('committer is always the service identity', () => {
    const committer = CommitBuilder.serviceCommitter();
    expect(committer.name).toBe('artifact-service');
    expect(committer.email).toBe('artifact-service@platform.invalid');
  });
});
