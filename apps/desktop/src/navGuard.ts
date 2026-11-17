import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * App-level navigation guard (S8, issue #339). A screen holding unsaved state registers a guard;
 * every App-owned navigation (project switch, screen switch, home, remove, running-run open) runs
 * it first and aborts when the guard returns false. Needed because `<Inspector key={project}>`
 * REMOUNTS the subtree on project switch and a Rail screen-switch unmounts the editor — component-
 * local confirms never see either.
 *
 * Pure registry (no React) so the semantics are unit-testable: guards are a set (a screen can hold two
 * dirty editors, e.g. Line's app.json draft and its flow draft), navigation proceeds only when every
 * guard passes, and unregister is idempotent and removes only that guard.
 *
 * Dirty-screen inventory (#339 follow-up): `WorkflowEditor` and `Settings` hold real unsaved work
 * behind an explicit Save and register a confirm guard via `useDiscardGuard`. `TaskDraftScreen`
 * persists via debounced autosave plus an unmount flush and a close-time `registerFlush` — nothing
 * to confirm, it is never lost. `StageInspector`'s text buffer and `NewRunForm`'s launch params are
 * transient/reconstructible — not "work" worth a prompt. This holds together only because
 * `Inspector` renders screens as an exclusive ternary, so guards from different screens never meet;
 * within Line two can be live at once, which is why the registry holds a set.
 */
export interface NavGuardRegistry {
  register: (guard: () => boolean) => void;
  unregister: (guard: () => boolean) => void;
  /** True ⇒ proceed with the navigation. Runs the guards in order; the first refusal aborts and skips the rest. */
  confirm: () => boolean;
  /** Whether a guard is currently registered (drives the window-close hook). */
  guarded: () => boolean;
  /**
   * Async flush hook (S10): a screen with debounced writes registers one so window close can
   * AWAIT the pending save — the synchronous confirm() cannot, and a fire-and-forget invoke
   * issued during close races webview teardown. Same last-wins/idempotent-unregister semantics
   * as the confirm guard.
   */
  registerFlush: (flush: () => Promise<void>) => void;
  unregisterFlush: (flush: () => Promise<void>) => void;
  hasFlush: () => boolean;
  /** Run the registered flush, bounded. Resolves false on failure or timeout — never rejects. */
  flush: (timeoutMs: number) => Promise<boolean>;
}

export function createNavGuardRegistry(): NavGuardRegistry {
  const guards = new Set<() => boolean>();
  let currentFlush: (() => Promise<void>) | null = null;
  return {
    register: (guard) => {
      guards.add(guard);
    },
    unregister: (guard) => {
      guards.delete(guard);
    },
    // Stops at the first refusal: no further prompts once one guard has said no.
    confirm: () => [...guards].every((g) => g() !== false),
    guarded: () => guards.size > 0,
    registerFlush: (flush) => {
      currentFlush = flush;
    },
    unregisterFlush: (flush) => {
      if (currentFlush === flush) currentFlush = null;
    },
    hasFlush: () => currentFlush !== null,
    flush: (timeoutMs) => {
      if (currentFlush === null) return Promise.resolve(true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        currentFlush().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ])
        .catch(() => false)
        .finally(() => clearTimeout(timer));
    },
  };
}

/** Context carrying the registry from App down to whichever screen needs to register. */
export const NavGuardContext = createContext<NavGuardRegistry | null>(null);

export function useNavGuardRegistry(): NavGuardRegistry | null {
  return useContext(NavGuardContext);
}

/**
 * Register a discard confirm with the App registry while `dirty`. Every dirty screen uses this —
 * shell navigation (project switch, Rail screen switch, home, remove, running-run open, window
 * close) unmounts or remounts the screen, so a component-local confirm never fires for any of them.
 *
 * `confirmDiscard` is read through a ref at fire time: its identity changes every render (it closes
 * over the message), and re-registering per keystroke would churn the single registry slot.
 */
export function useDiscardGuard(dirty: boolean, confirmDiscard: () => boolean): void {
  const registry = useNavGuardRegistry();
  const confirmRef = useRef(confirmDiscard);
  confirmRef.current = confirmDiscard;
  useEffect(() => {
    if (registry === null || !dirty) return;
    const guard = (): boolean => confirmRef.current();
    registry.register(guard);
    return () => registry.unregister(guard);
  }, [registry, dirty]);
}
