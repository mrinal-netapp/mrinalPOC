import { RefResolver } from '../../engine/RefResolver';

describe('RefResolver', () => {
  const r = new RefResolver();

  it('resolves SESSION sentinel against the X-Session-ID header', () => {
    expect(r.resolve('SESSION', 'sess-1')).toBe('refs/heads/sessions/sess-1');
  });

  it('defaults to SESSION sentinel when ref is undefined', () => {
    expect(r.resolve(undefined, 'sess-1')).toBe('refs/heads/sessions/sess-1');
  });

  it('throws if SESSION requested but sessionId missing', () => {
    expect(() => r.resolve('SESSION', undefined)).toThrow(/X-Session-ID/);
  });

  it('passes through fully-qualified refs', () => {
    expect(r.resolve('refs/heads/main')).toBe('refs/heads/main');
    expect(r.resolve('refs/tags/v1')).toBe('refs/tags/v1');
  });

  it('promotes bare names to refs/heads/<name>', () => {
    expect(r.resolve('main')).toBe('refs/heads/main');
    expect(r.resolve('feature-x')).toBe('refs/heads/feature-x');
  });

  it('rejects unsafe ref names', () => {
    expect(() => r.resolve('../etc/passwd')).toThrow();
    expect(() => r.resolve('refs/heads/..')).toThrow();
    expect(() => r.resolve('with space')).toThrow();
  });

  it('rejects unsafe sessionIds', () => {
    expect(() => r.resolve('SESSION', '../escape')).toThrow();
    expect(() => r.resolve('SESSION', '.hidden')).toThrow();
  });

  it('computes the session branch name directly', () => {
    expect(r.sessionBranch('sess-1')).toBe('refs/heads/sessions/sess-1');
  });
});
