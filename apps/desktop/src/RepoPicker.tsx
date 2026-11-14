import { useEffect, useRef, useState } from 'react';
import { ArrowUp, FolderGit2, Folder } from 'lucide-react';
import { Button, Input, Tabs, useFocusTrap } from '@/ui';
import { browseDirs } from './ipc';
import { subscribe } from './transport';
import { errorMessage } from './errors';
import type { DirListing } from './taskcell-output';

type Mode = 'existing' | 'clone';

/** The "Add a repo" folder picker: walks `browse_dirs`, or jumps straight to a typed path (the only
 * way to a folder the tree cannot reach, e.g. another Windows drive). The hub decides what is
 * allowed: a hub served to a browser confines both to its browse root, the desktop app's own hub
 * does not. Two modes share the same browser: **Existing folder** adds whichever git work tree is
 * currently shown; **Clone repository** clones a pasted URL into the shown folder as the parent dir. */
export function RepoPicker({
  onAdd,
  onClone,
  onClose,
}: {
  onAdd: (path: string) => Promise<void>;
  onClone: (url: string, parentDir: string, name?: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  const [mode, setMode] = useState<Mode>('existing');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the CURRENTLY SHOWN directory is itself a git work tree: the listing's own flag, or (a
  // hub that predates it) the flag of the row that was clicked to get here.
  const [currentIsGit, setCurrentIsGit] = useState(false);
  const [typedPath, setTypedPath] = useState('');

  const [url, setUrl] = useState('');
  const [folderName, setFolderName] = useState('');
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);

  const navigate = async (path?: string, isGitRepo = false): Promise<void> => {
    try {
      const next = await browseDirs(path);
      setListing(next);
      setCurrentIsGit(next.isGitRepo ?? isGitRepo);
      setError(null);
    } catch (err) {
      setError(`Could not open that folder: ${errorMessage(err)}`);
    }
  };

  useEffect(() => {
    navigate();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Only wired up while a clone is in flight — the dialog has no reason to hold the SSE
  // subscription open the rest of the time.
  useEffect(() => {
    if (!cloning) return;
    let unlisten: (() => void) | undefined;
    void subscribe<{ line: string }>('vanguard:clone-progress', (e) => {
      setProgress((lines) => [...lines, e.payload.line]);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [cloning]);

  const add = async (): Promise<void> => {
    if (!listing) return;
    try {
      await onAdd(listing.path);
    } catch (err) {
      setError(`Could not add this repo: ${errorMessage(err)} — check it has a .taskcell directory and try again.`);
    }
  };

  const clone = async (): Promise<void> => {
    if (!listing || url.trim() === '') return;
    setError(null);
    setProgress([]);
    setCloning(true);
    try {
      await onClone(url.trim(), listing.path, folderName.trim() || undefined);
    } catch (err) {
      setError(`Clone failed: ${errorMessage(err)} — check the URL and that you have access, then try again.`);
    } finally {
      setCloning(false);
    }
  };

  // What the hub would refuse (src/hub/clone.ts), said before the click.
  const cloneProblem = /[\s\\]/.test(url.trim())
    ? 'A repository URL has no spaces or backslashes.'
    : /[\\/]/.test(folderName.trim()) || folderName.trim() === '.' || folderName.trim() === '..'
      ? 'A folder name is one name, without / or \\: the repository is cloned into the folder shown.'
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add a repository"
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Tabs.Root value={mode} onValueChange={(v) => {
          setMode(v as Mode);
          setError(null); // an error belongs to the tab it happened on
        }} className="flex flex-col">
          <Tabs.List className="shrink-0 px-3 pt-2">
            <Tabs.Tab value="existing">Existing folder</Tabs.Tab>
            <Tabs.Tab value="clone">Clone repository</Tabs.Tab>
            <Tabs.Indicator />
          </Tabs.List>

          {mode === 'clone' && (
            <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
              <Input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
                aria-label="Repository URL"
                disabled={cloning}
              />
              <Input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="Folder name (default: repo name)"
                aria-label="Folder name"
                disabled={cloning}
              />
            </div>
          )}

          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button
              variant="text"
              aria-label="Parent directory"
              disabled={!listing?.parent || cloning}
              onClick={() => navigate(listing?.parent)}
            >
              <ArrowUp className="size-4" />
            </Button>
            <span className="truncate text-sm text-muted-foreground">
              {mode === 'clone' ? `Clone into: ${listing?.path ?? 'Loading…'}` : listing?.path ?? 'Loading…'}
            </span>
          </div>
          <form
            className="flex items-center gap-2 border-b border-border px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (typedPath.trim() !== '') void navigate(typedPath.trim());
            }}
          >
            <Input
              value={typedPath}
              onChange={(e) => setTypedPath(e.target.value)}
              placeholder="Or type a folder path (e.g. ~/code/repo)"
              aria-label="Folder path"
              disabled={cloning}
            />
            <Button type="submit" variant="text" disabled={typedPath.trim() === '' || cloning}>
              Go
            </Button>
          </form>
          <div className="max-h-80 overflow-auto p-1">
            {error && <div role="alert" className="px-3 py-2 text-sm text-destructive-text">{error}</div>}
            {listing?.entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => navigate(entry.path, entry.isGitRepo)}
                disabled={cloning}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted/60"
              >
                {entry.isGitRepo ? (
                  <FolderGit2 className="size-4 text-muted-foreground" />
                ) : (
                  <Folder className="size-4 text-muted-foreground" />
                )}
                <span className="truncate">{entry.name}</span>
                <span className="ml-auto flex items-center gap-1 pl-3">
                  {entry.isGitRepo && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">git</span>
                  )}
                  {entry.hasTaskcell && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">.taskcell</span>
                  )}
                </span>
              </button>
            ))}
          </div>

          {mode === 'clone' && progress.length > 0 && (
            <div className="max-h-24 overflow-auto border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
              {progress.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
            {mode === 'existing' && listing && !currentIsGit && (
              <span className="mr-auto text-xs text-muted-foreground">This folder is not a git repository. Open one that is, or run git init in it.</span>
            )}
            {mode === 'clone' && cloneProblem !== null && <span role="alert" className="mr-auto text-xs text-destructive-text">{cloneProblem}</span>}
            <Button variant="text" onClick={onClose} disabled={cloning}>
              Cancel
            </Button>
            {mode === 'existing' ? (
              <Button onClick={add} disabled={!listing || !currentIsGit}>
                Add this repo
              </Button>
            ) : (
              <Button onClick={clone} disabled={!listing || url.trim() === '' || cloning || cloneProblem !== null}>
                {cloning ? 'Cloning…' : 'Clone & add'}
              </Button>
            )}
          </div>
        </Tabs.Root>
      </div>
    </div>
  );
}
