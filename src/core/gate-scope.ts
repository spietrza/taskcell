// Decides which app verifications the lighter `verify:gate` script must run for a set of changed paths.
export interface GateScope {
  desktop: boolean;
  mobile: boolean;
}

const SHARED = ['packages/hub-client/', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json'];
// Root `src/` dirs that apps/desktop tests import (hub.integration.test.ts and what it pulls in).
const DESKTOP_SRC = ['src/core/', 'src/hub/', 'src/sidecar/', 'src/pipeline/'];

export function gateScope(changed: readonly string[]): GateScope {
  const shared = changed.some((f) => SHARED.some((p) => f === p || f.startsWith(p)));
  return {
    desktop: shared || changed.some((f) => f.startsWith('apps/desktop/') || DESKTOP_SRC.some((p) => f.startsWith(p))),
    mobile: shared || changed.some((f) => f.startsWith('apps/mobile/')),
  };
}
