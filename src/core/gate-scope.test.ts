import { describe, expect, it } from 'vitest';
import { gateScope } from './gate-scope.js';

describe('gateScope', () => {
  it('skips both apps for unrelated changes', () => {
    expect(gateScope(['src/cli/x.ts', 'README.md'])).toEqual({ desktop: false, mobile: false });
  });
  it('selects only the touched app', () => {
    expect(gateScope(['apps/desktop/src/App.tsx'])).toEqual({ desktop: true, mobile: false });
    expect(gateScope(['apps/mobile/app.json'])).toEqual({ desktop: false, mobile: true });
  });
  it('selects both for shared code', () => {
    expect(gateScope(['packages/hub-client/src/a.ts'])).toEqual({ desktop: true, mobile: true });
    expect(gateScope(['pnpm-lock.yaml'])).toEqual({ desktop: true, mobile: true });
  });
  it('selects desktop for root src it imports', () => {
    expect(gateScope(['src/hub/server.ts'])).toEqual({ desktop: true, mobile: false });
  });
  it('selects nothing for an empty diff', () => {
    expect(gateScope([])).toEqual({ desktop: false, mobile: false });
  });
});
