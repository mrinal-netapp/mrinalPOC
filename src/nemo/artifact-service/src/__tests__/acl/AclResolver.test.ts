import { AclResolver } from '../../acl/AclResolver';
import {
  ArtifactStoreAclRow,
  ArtifactStoreRow,
} from '../../types/ArtifactStore';
import { Principal, RequestContext } from '../../types/Principal';

const store: ArtifactStoreRow = {
  id: 'asabc12345',
  projectId: 'proj1',
  name: 'demo',
  description: null,
  ownerUserId: 'user-owner',
  defaultBranch: 'main',
  lfsThresholdBytes: 102400,
  quotaBytes: null,
  state: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const acl = (
  principalType: ArtifactStoreAclRow['principalType'],
  principalId: string,
  role: ArtifactStoreAclRow['role'],
): ArtifactStoreAclRow => ({
  id: 'acl-' + principalId,
  storeId: store.id,
  principalType,
  principalId,
  role,
  grantedBy: null,
  grantedAt: new Date(),
});

const p = (kind: Principal['kind'], id: string): Principal => ({ kind, id });

describe('AclResolver.resolveFromRows', () => {
  it('grants implicit owner to the store creator (user kind)', () => {
    expect(
      AclResolver.resolveFromRows(p('user', 'user-owner'), store, []),
    ).toBe('owner');
  });

  it('does not auto-grant owner to a user with the same id but agent kind', () => {
    expect(
      AclResolver.resolveFromRows(p('agent', 'user-owner'), store, []),
    ).toBe('none');
  });

  it('returns the role from a matching ACL row', () => {
    const rows = [acl('agent', 'agent-1', 'writer')];
    expect(AclResolver.resolveFromRows(p('agent', 'agent-1'), store, rows)).toBe(
      'writer',
    );
  });

  it('matches by principalType (no cross-type confusion)', () => {
    const rows = [acl('user', 'shared-id', 'owner')];
    expect(AclResolver.resolveFromRows(p('team', 'shared-id'), store, rows)).toBe(
      'none',
    );
  });

  it('reader when explicit reader row', () => {
    const rows = [acl('user', 'u2', 'reader')];
    expect(AclResolver.resolveFromRows(p('user', 'u2'), store, rows)).toBe('reader');
  });

  it('none when no row matches and not implicit owner', () => {
    expect(AclResolver.resolveFromRows(p('agent', 'nobody'), store, [])).toBe(
      'none',
    );
  });

  it('grants implicit owner to a service principal that created the store', () => {
    const serviceOwned: ArtifactStoreRow = {
      ...store,
      ownerUserId: 'service:pipeline-runner',
    };
    expect(
      AclResolver.resolveFromRows(p('service', 'pipeline-runner'), serviceOwned, []),
    ).toBe('owner');
  });

  it('does not confuse service-encoded ownership with a user of the same id', () => {
    const serviceOwned: ArtifactStoreRow = {
      ...store,
      ownerUserId: 'service:pipeline-runner',
    };
    expect(
      AclResolver.resolveFromRows(p('user', 'pipeline-runner'), serviceOwned, []),
    ).toBe('none');
  });

  it('agent acting in a team picks up the team-row grant via RequestContext', () => {
    const rows = [acl('team', 'eng-team', 'writer')];
    const ctx: RequestContext = {
      principal: p('agent', 'agent-1'),
      projectId: 'proj1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      teamId: 'eng-team',
    };
    expect(AclResolver.resolveFromRows(ctx, store, rows)).toBe('writer');
  });

  it('agent-in-team takes the max of explicit agent grant and team grant', () => {
    const rows = [
      acl('agent', 'agent-1', 'reader'),
      acl('team', 'eng-team', 'writer'),
    ];
    const ctx: RequestContext = {
      principal: p('agent', 'agent-1'),
      projectId: 'proj1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      teamId: 'eng-team',
    };
    expect(AclResolver.resolveFromRows(ctx, store, rows)).toBe('writer');
  });

  it('agent without a team context does NOT inherit team grants', () => {
    const rows = [acl('team', 'eng-team', 'writer')];
    const ctxNoTeam: RequestContext = {
      principal: p('agent', 'agent-1'),
      projectId: 'proj1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
    };
    expect(AclResolver.resolveFromRows(ctxNoTeam, store, rows)).toBe('none');
  });
});
