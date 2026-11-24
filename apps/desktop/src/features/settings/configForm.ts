import { useEffect, useRef, useState } from 'react';
import { hub } from '../../transport';
import { useAppConfig, useCallerCapabilities } from '../../hooks';
import { useDiscardGuard } from '../../navGuard';
import { customProviderRowError, customProviderRows } from './customProviders';
import type { AppConfig } from '../../taskcell-output';
import { appConfigRangeErrors, fallbackChainErrors, type CustomProviderSpec } from '../../wire';
import { errorMessage } from '../../errors';

/**
 * The app.json draft shared by General and Line: load, edit, save, discard and the guards that stop a
 * save from overwriting a file that has not (or could not be) read. One implementation, so the data-loss
 * guards cannot drift between the two screens.
 */
export function useConfigForm(project: string) {
  // Inspector is keyed by project, so this remounts on project switch: config loads once and
  // `dirty`/`saved` start clean without a reset effect.
  const [cfg, setCfg, cfgStatus] = useAppConfig(project);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveGate = useCallerCapabilities(project)?.project?.canChangeSettings;
  // The config as last read or saved: Discard goes back to it.
  const [lastSaved, setLastSaved] = useState<AppConfig | null>(null);
  useEffect(() => {
    if (cfgStatus === 'ready') setLastSaved((prev) => prev ?? cfg);
  }, [cfgStatus, cfg]);

  // Shell navigation unmounts this screen — see useDiscardGuard (S8 seam, #339 follow-up).
  useDiscardGuard(dirty, () => window.confirm('Discard unsaved changes to .taskcell/app.json?'));

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]): void => {
    setCfg((c) => ({ ...c, [k]: v }));
    setDirty(true);
    setSaved(false);
    setSaveError(null);
  };

  const customs: CustomProviderSpec[] = customProviderRows(cfg);
  const customErrors = customs.map((row, i) => customProviderRowError(row, i, customs));
  const customsValid = customErrors.every((e) => e === undefined);

  // Save gating (S6 §8 guards): before the config read resolves, a save would write the {} seed
  // over the file; after a FAILED read ('error' = the file exists but does not parse), a save
  // would replace the user's hand-edited JSON with defaults. Invalid custom rows also block.
  const rangeErrors = appConfigRangeErrors(cfg);
  const chainErrors = fallbackChainErrors(cfg.fallbackChain, { primary: cfg.provider || 'claude' });
  const chainValid = chainErrors.list === undefined && chainErrors.rows.every((r) => r === undefined);
  const savable = dirty && cfgStatus === 'ready' && customsValid && Object.keys(rangeErrors).length === 0 && chainValid;

  // Latest cfg, readable after an await (the save closure's `cfg` is the render's snapshot).
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const save = async (): Promise<void> => {
    const shipped = cfg; // the exact object written — dirty clears only if it is still current
    try {
      await hub().call('write_app_config', { repoPath: project, config: shipped });
    } catch (e) {
      // The form keeps the user's input and stays dirty: they correct the named field and save again.
      setSaveError(errorMessage(e));
      return;
    }
    // An edit made while the write was in flight lives in cfg but NOT on disk. Clearing dirty would
    // disable Save and disarm the guard above, letting the next navigation discard it silently —
    // the same rule flowEditorReducer's saveOk follows. Every `set` builds a new object, so
    // reference identity is exactly "unchanged since save".
    setLastSaved(shipped);
    if (cfgRef.current !== shipped) return;
    setDirty(false);
    setSaved(true);
  };

  const discard = (): void => {
    if (lastSaved === null) return;
    setCfg(lastSaved);
    setDirty(false);
    setSaveError(null);
  };

  return { cfg, setCfg, cfgStatus, dirty, saved, saveError, saveGate, lastSaved, set, customs, customErrors, customsValid, rangeErrors, savable, save, discard };
}

export type ConfigForm = ReturnType<typeof useConfigForm>;
