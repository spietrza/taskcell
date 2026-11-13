/**
 * Environment access for `TASKCELL_*` variables. The product was called Vanguard, so every variable also
 * answers to its old `VANGUARD_*` spelling; the new name wins when both are set (an empty new value counts
 * as unset, so a blank placeholder cannot silently disable a switch or secret still set under the old name).
 * Read every such variable through `readEnv`, never `process.env.VANGUARD_*`.
 */

const NEW_PREFIX = 'TASKCELL_';
const OLD_PREFIX = 'VANGUARD_';

/** The value of `name` (a `TASKCELL_*` variable), else of its old `VANGUARD_*` spelling. */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (value !== undefined && value !== '') return value;
  const legacy = name.startsWith(NEW_PREFIX) ? env[OLD_PREFIX + name.slice(NEW_PREFIX.length)] : undefined;
  return legacy ?? value;
}
