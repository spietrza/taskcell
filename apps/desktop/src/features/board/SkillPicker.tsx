import { useEffect, useState, type ReactNode } from 'react';
import { apiListSkills } from '../../ipc';
import { errorMessage } from '../../errors';

/**
 * Multi-select of the skills a run of `project` can load. When the list cannot be read (missing
 * skills dir, lock mismatch) it says why instead of showing an empty picker; the skills already
 * chosen stay listed so they can still be unticked.
 */
export function SkillPicker({
  project,
  value,
  onChange,
  disabled = false,
  empty,
}: {
  project: string;
  value: string[];
  onChange: (skills: string[]) => void;
  disabled?: boolean;
  /** Shown instead of the picker when no skill is installed or chosen. */
  empty?: ReactNode;
}) {
  const [installed, setInstalled] = useState<string[] | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setInstalled(null);
    apiListSkills(project)
      .then(({ skills }) => {
        if (live) setInstalled(skills);
      })
      .catch((e: unknown) => {
        if (live) setInstalled({ error: errorMessage(e) });
      });
    return () => {
      live = false;
    };
  }, [project]);
  const listed = Array.isArray(installed) ? installed : [];
  const ids = [...new Set([...listed, ...value])];
  if (empty !== undefined && Array.isArray(installed) && ids.length === 0) return <>{empty}</>;

  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <legend className="sr-only">Skills</legend>
      <span>skills</span>
      {ids.map((id) => (
        <label key={id} className="flex items-center gap-1 break-all">
          <input type="checkbox" checked={value.includes(id)} onChange={(e) => onChange(e.target.checked ? [...value, id] : value.filter((s) => s !== id))} />
          {id}
          {Array.isArray(installed) && !installed.includes(id) && <span className="text-destructive-text">(not installed)</span>}
        </label>
      ))}
      {installed === null && <span>loading…</span>}
      {Array.isArray(installed) && ids.length === 0 && <span>none installed</span>}
      {installed !== null && !Array.isArray(installed) && (
        <span role="status" className="basis-full text-[11px] text-destructive-text">
          skills unavailable — {installed.error}
        </span>
      )}
    </fieldset>
  );
}
