// Guards the Tauri capability files (src-tauri/capabilities): a capability whose remote URLs match any
// host would hand the server switcher's commands (and through `servers_add`, a runtime grant to an
// origin of the caller's choosing) to every page the window lands on. Only loopback (hub.json) and each
// saved server's own origin (servers::grant, at runtime) may carry command permissions.
// @vitest-environment node
import { expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../src-tauri/capabilities', import.meta.url));

type Permission = string | { identifier: string };

interface Capability {
  identifier: string;
  remote?: { urls?: string[] };
  permissions: Permission[];
}

const capabilities = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Capability);

// Any `*` in the host part (`http://*/x`, `https://*.example.com/x`) matches hosts nobody vetted.
const wildcardHost = (url: string): boolean => /^[a-z]+:\/\/[^/:]*\*/i.test(url);

/** App commands (`allow-servers-*`) and plugin/core permissions both count; only the bare default does not. */
const isCommandPermission = (p: Permission): boolean =>
  (typeof p === 'string' ? p : p.identifier) !== 'core:default';

test('the wildcard-host check matches what it should', () => {
  expect(wildcardHost('http://*/*')).toBe(true);
  expect(wildcardHost('https://*:*/*')).toBe(true);
  expect(wildcardHost('https://*.example.com/*')).toBe(true);
  expect(wildcardHost('http://127.0.0.1:*/*')).toBe(false);
  expect(wildcardHost('http://localhost:*/*')).toBe(false);
});

test('no capability grants a command permission to a wildcard remote host', () => {
  expect(capabilities.length).toBeGreaterThan(0);
  const offending = capabilities.filter(
    (c) => (c.remote?.urls ?? []).some(wildcardHost) && c.permissions.some(isCommandPermission),
  );
  expect(offending.map((c) => c.identifier)).toEqual([]);
});
