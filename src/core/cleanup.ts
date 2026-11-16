/** What a signal must tear down: a sandbox, or a sidecar whose teardown does more than `rm` (the chatgpt LLM proxy). */
type Destroyable = { destroy: () => Promise<void> };

const live = new Set<Destroyable>();
// Sidecars that read state back from a sandbox's peer: destroyed only after every sandbox.
const liveProxies = new Set<Destroyable>();
let installed = false;

/** Track a started sandbox so a termination signal can destroy it (a `finally` block misses SIGINT/SIGTERM). */
export function trackSandbox(sandbox: Destroyable, opts: { proxy?: boolean } = {}): void {
  (opts.proxy === true ? liveProxies : live).add(sandbox);
}

/** Stop tracking a sandbox once it has been destroyed (or intentionally handed off). */
export function untrackSandbox(sandbox: Destroyable): void {
  live.delete(sandbox);
  liveProxies.delete(sandbox);
}

/** Destroy every tracked sandbox, swallowing errors. Returns how many were tracked. */
export async function destroyAllTracked(): Promise<number> {
  const sandboxes = [...live];
  live.clear();
  const destroy = (all: Destroyable[]): Promise<unknown> => Promise.all(all.map((d) => d.destroy().catch(() => undefined)));
  // Sandboxes first: a cell still running could rotate the token between the proxy's read-back and its removal.
  await destroy(sandboxes);
  // Snapshotted after the sandbox phase so a proxy started meanwhile is not missed.
  const proxies = [...liveProxies];
  liveProxies.clear();
  await destroy(proxies);
  return sandboxes.length + proxies.length;
}

/**
 * Install one-time SIGINT/SIGTERM handlers that best-effort destroy every tracked sandbox before the
 * process exits, so Ctrl-C or a kill does not orphan containers/VMs (concurrent runs are all tracked,
 * so a single signal cleans them all). Idempotent; safe to call from every prepareContext.
 */
export function installSignalCleanup(): void {
  if (installed) return;
  installed = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void destroyAllTracked().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  }
}
