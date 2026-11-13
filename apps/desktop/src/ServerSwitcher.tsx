import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, HardDrive, Plus, Server as ServerIcon, Trash2 } from 'lucide-react';
import { cn } from '@/ui';
import { errorMessage } from './errors';
import {
  addServer,
  canSwitchServers,
  listServers,
  removeServer,
  switchServer,
  type ServerState,
} from './servers';

/** Top of the rail: Local or a saved remote hub. Desktop app only; renders nothing in a browser. */
export function ServerSwitcher({ collapsed }: { collapsed: boolean }): ReactNode {
  const [state, setState] = useState<ServerState | null>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);

  const refresh = (): void => void listServers().then(setState, () => setState(null));
  useEffect(() => {
    if (canSwitchServers()) refresh();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!canSwitchServers() || !state) return null;

  const current = state.servers.find((s) => s.id === state.active);
  const label = current?.name ?? 'Local';
  const toggle = (): void => {
    // The rail scrolls and clips, so the menu is portalled and fixed under the trigger.
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4 });
    setOpen((o) => !o);
  };
  const run = (fn: () => Promise<unknown>): void => {
    setError(null);
    fn().then(
      () => {
        setOpen(false);
        setAdding(false);
        refresh();
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  };
  const save = (): void =>
    run(async () => {
      const s = await addServer(name, url);
      setName('');
      setUrl('');
      await switchServer(s.id);
    });
  const remove = (id: string, serverName: string): void => {
    if (window.confirm(`Remove ${serverName}? You will need its URL to add it again.`)) run(() => removeServer(id));
  };

  return (
    <div className="px-2 pb-2">
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Server: ${label}`}
        title={`Server: ${label}`}
        className={cn(
          'flex w-full items-center rounded border border-border py-1.5 text-sm hover:bg-muted/60',
          collapsed ? 'justify-center px-0' : 'gap-2 px-2',
        )}
      >
        {current ? <ServerIcon className="size-4 shrink-0" /> : <HardDrive className="size-4 shrink-0" />}
        {!collapsed && <span className="truncate font-medium">{label}</span>}
        {!collapsed && <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {open &&
        createPortal(
          <>
            <div data-testid="server-menu-backdrop" className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div style={pos} className="fixed z-50 w-64 rounded border border-border bg-background p-1 shadow-md">
              <div role="menu">
                <MenuItem active={!current} onClick={() => run(() => switchServer(null))} icon={<HardDrive className="size-4" />}>
                  Local
                </MenuItem>
                {state.servers.map((s) => (
                  <div key={s.id} className="flex items-center">
                    <MenuItem active={s.id === state.active} onClick={() => run(() => switchServer(s.id))} icon={<ServerIcon className="size-4" />} title={s.url}>
                      {s.name}
                    </MenuItem>
                    <button
                      type="button"
                      aria-label={`Remove ${s.name}`}
                      onClick={() => remove(s.id, s.name)}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
                {!adding && (
                  <MenuItem active={false} onClick={() => setAdding(true)} icon={<Plus className="size-4" />}>
                    Add server…
                  </MenuItem>
                )}
              </div>
              {adding && (
                <form
                  className="space-y-1.5 p-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save();
                  }}
                >
                  <Field label="Name" value={name} onChange={setName} placeholder="Team hub" />
                  <Field label="Hub URL" value={url} onChange={setUrl} placeholder="https://hub.example.com" />
                  <p className="text-[11px] text-muted-foreground">You sign in on the hub itself.</p>
                  <button type="submit" className="w-full rounded bg-muted px-2 py-1 text-sm font-medium hover:bg-muted/70">
                    Add and connect
                  </button>
                </form>
              )}
              {error && (
                <p role="alert" className="px-2 py-1 text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  icon,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  title?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      onClick={onClick}
      className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60"
    >
      {icon}
      <span className="truncate">{children}</span>
      {active && <Check className="ml-auto size-3.5 shrink-0" />}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): ReactNode {
  return (
    <label className="block text-xs text-muted-foreground">
      {label}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
      />
    </label>
  );
}
