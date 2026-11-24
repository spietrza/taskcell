import { useEffect, useState, type ReactNode } from 'react';
import { Button, Chip, Input, ScrollTable, Table } from '@/ui';
import { RefreshCw } from 'lucide-react';
import { addSkillPr } from '../../ipc';
import { errorClause, errorMessage } from '../../errors';
import { gateProps, useAsync, useCallerCapabilities } from '../../hooks';
import { ExternalLink } from '../../components/ExternalLink';
import type { DiscoveredSkill, RepoSkill } from '../../wire';
import { hub } from '../../transport';

const webUrl = (u: string): string | undefined => (/^https?:\/\//i.test(u) ? u : undefined);

const pct = (v: number | undefined): string => (v === undefined ? '-' : `${(v * 100).toFixed(0)}%`);

/** A skill needs an update PR when its upstream moved. */
export const isOutdated = (s: RepoSkill): boolean => s.check === 'outdated';

const prNumber = (u: string): string => /\/(\d+)\/?$/.exec(u)?.[1] ?? '';

/** The folder a skill sits in: skills/engineering/foo -> skills/engineering; a root skill has none. */
const groupOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(root)');

/** A group checkbox: checked when all of its skills are picked, indeterminate when some are. */
function GroupBox({ label, all, some, onChange }: { label: string; all: boolean; some: boolean; onChange: (on: boolean) => void }): ReactNode {
  return (
    <input
      type="checkbox"
      aria-label={`Select all in ${label}`}
      checked={all}
      ref={(el) => {
        if (el) el.indeterminate = some && !all;
      }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** A pull request a skills action opened, or why it did not. */
type Outcome = { kind: 'ok'; prUrl: string } | { kind: 'error'; message: string };

/** The project's Skills view (hub): staleness and usage, and PR-only changes. Skill content is never edited here. */
export function Skills({ project }: { project: string }) {
  const [nonce, setNonce] = useState(0);
  const [onlyOutdated, setOnlyOutdated] = useState(false);
  const [source, setSource] = useState('');
  // The skills discovery found in the pasted repository, and the ones ticked to add.
  const [found, setFound] = useState<{ source: string; commit: string; skills: DiscoveredSkill[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({});
  // The PR an add opened, kept until the view is left: its skills are not in the list until it is merged.
  const [notice, setNotice] = useState<{ prUrl: string; names: string[] } | null>(null);
  const [pull, setPull] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const { data, error, loading } = useAsync(() => hub().call('list_repo_skills', { repoPath: project }), [project, nonce]);
  // Best effort: a caller who may not read the forge, or a project without a GitHub remote, simply sees none.
  const { data: pendingData } = useAsync(() => hub().call('list_pending_skill_prs', { repoPath: project }).catch(() => ({ prs: [] })), [project, nonce]);
  const pending = pendingData?.prs ?? [];
  const caps = useCallerCapabilities(project)?.project;
  const groups = Object.entries(
    (found?.skills ?? []).reduce<Record<string, DiscoveredSkill[]>>((acc, s) => ({ ...acc, [groupOf(s.path)]: [...(acc[groupOf(s.path)] ?? []), s] }), {}),
  );
  const shown = (data?.skills ?? []).filter((s) => !onlyOutdated || isOutdated(s));

  // The pull result is stale once another action starts or the project changes.
  const clearPull = (): void => setPull(null);
  useEffect(clearPull, [project]);

  const run = async (key: string, action: () => Promise<{ prUrl: string }>, names: string[] = []): Promise<boolean> => {
    clearPull();
    setBusy(key);
    try {
      const { prUrl } = await action();
      setOutcome((o) => ({ ...o, [key]: { kind: 'ok', prUrl } }));
      if (key === 'add') {
        setNotice({ prUrl, names });
        setNonce((n) => n + 1);
      }
      return true;
    } catch (e) {
      setOutcome((o) => ({ ...o, [key]: { kind: 'error', message: errorClause(errorMessage(e)) } }));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const pullNow = async (): Promise<void> => {
    setBusy('pull');
    try {
      const { updated } = await hub().call('pull_checkout', { repoPath: project });
      setPull({ kind: 'ok', message: updated ? 'Checkout updated.' : 'Checkout already up to date.' });
      setNonce((n) => n + 1);
    } catch (e) {
      setPull({ kind: 'error', message: errorClause(errorMessage(e)) });
    } finally {
      setBusy(null);
    }
  };
  const pullButton = (
    <span className="flex flex-wrap items-center gap-2">
      <Button variant="outlined" {...gateProps(caps?.canEditSkills)} disabled={busy !== null || caps?.canEditSkills.allowed === false} onClick={() => void pullNow()}>
        {busy === 'pull' ? 'Pulling…' : 'Pull checkout'}
      </Button>
      {pull && (
        <span role={pull.kind === 'error' ? 'alert' : 'status'} className={pull.kind === 'error' ? 'text-xs text-destructive-text' : 'text-xs text-muted-foreground'}>
          {pull.kind === 'error' ? `Not pulled: ${pull.message}` : pull.message}
        </span>
      )}
    </span>
  );
  // A repository or a folder link is looked through first (a folder may hold several skills); a folder that is itself
  // one skill (the only hit is the linked folder) is added directly.
  const pointsAtFolder = (u: string): boolean => /\/(-\/)?(tree|blob)\/[^/]+\/[^/]/.test(u);
  const add = async (): Promise<void> => {
    const src = source.trim();
    clearPull();
    setBusy('add');
    try {
      const r = await hub().call('discover_skills', { repoPath: project, source: src });
      const folder = src.replace(/\/SKILL\.md$/, '').replace(/\/$/, '');
      if (pointsAtFolder(src) && r.skills.length === 1 && folder.endsWith(`/${r.skills[0]!.path}`)) {
        setBusy(null);
        await run('add', () => addSkillPr(project, src));
        return;
      }
      if (r.skills.length === 0) throw new Error('No skill (a folder with SKILL.md) found in this repository.');
      setFound({ source: src, ...r });
      setPicked(r.skills.length === 1 ? [r.skills[0]!.path] : []);
      setOutcome(({ add: _gone, ...rest }) => rest);
    } catch (e) {
      setOutcome((o) => ({ ...o, add: { kind: 'error', message: errorClause(errorMessage(e)) } }));
    } finally {
      setBusy(null);
    }
  };
  const result = (key: string) => {
    const o = outcome[key];
    if (o === undefined) return null;
    // An add's PR stays in the notice below; the inline link is for the per-skill actions.
    if (key === 'add' && o.kind === 'ok') return null;
    return o.kind === 'ok' ? (
      <ExternalLink href={webUrl(o.prUrl)}>Pull request opened</ExternalLink>
    ) : (
      <span role="alert" className="text-xs text-destructive-text">
        Failed: {o.message}
      </span>
    );
  };

  return (
    <section aria-label="Skills" className="flex min-h-0 flex-1 flex-col space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">Skills</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyOutdated} onChange={(e) => setOnlyOutdated(e.target.checked)} />
          Outdated only
        </label>
        <Button className="ml-auto" variant="text" color="secondary" onClick={() => { clearPull(); setNonce((n) => n + 1); }} startIcon={<RefreshCw className="size-4" />}>
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Skills live in the repository, so the factory reads them on every run. Adding one opens a pull request for you to review; it shows here after you merge it and update this checkout.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Skill source" placeholder="https://github.com/org/skill-repo" value={source} onChange={(e) => { setSource(e.target.value); setFound(null); }} className="max-w-md" />
        <Button variant="outlined" {...gateProps(caps?.canEditSkills)} disabled={busy !== null || source.trim() === '' || caps?.canEditSkills.allowed === false} onClick={() => void add()}>
          {busy === 'add' ? 'Adding…' : 'Add skill'}
        </Button>
        {result('add')}
      </div>
      <p className="text-xs text-muted-foreground">A repository or a folder in it — paste the GitHub link to the folder.</p>
      {notice && (
        <p role="status" className="rounded border border-border bg-muted/40 px-3 py-2 text-sm">
          <ExternalLink href={webUrl(notice.prUrl)}>{`Pull request ${prNumber(notice.prUrl) && `#${prNumber(notice.prUrl)} `}opened`}</ExternalLink>
          {notice.names.length > 0 && `: ${notice.names.join(', ')}`} — the skill{notice.names.length > 1 ? 's' : ''} appear{notice.names.length > 1 ? '' : 's'} here once it is merged.
        </p>
      )}
      {pending.length > 0 && (
        <section aria-label="Waiting for merge" className="space-y-1 text-sm">
          <h3 className="text-xs font-medium text-muted-foreground">Waiting for merge</h3>
          <ul className="space-y-1">
            {pending.map((p) => (
              <li key={p.number} className="flex flex-wrap items-center gap-2">
                <ExternalLink href={webUrl(p.url)}>{`Pull request #${p.number}`}</ExternalLink>
                <span>{p.names.join(', ')}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">After merging, pull the checkout to see them here.</p>
          {pullButton}
        </section>
      )}
      {pending.length === 0 && <div>{pullButton}</div>}
      {found && (
        <fieldset className="space-y-1 rounded border border-border p-3 text-sm">
          <legend className="px-1 text-xs text-muted-foreground">
            Found {found.skills.length} skill{found.skills.length === 1 ? '' : 's'} in this repository — pick which to add
          </legend>
          <div className="flex items-center gap-2">
            <Button variant="text" color="secondary" onClick={() => setPicked(found.skills.map((s) => s.path))}>
              Select all
            </Button>
            <Button variant="text" color="secondary" onClick={() => setPicked([])}>
              Clear
            </Button>
          </div>
          {groups.map(([group, items]) => {
            const n = items.filter((s) => picked.includes(s.path)).length;
            const toggle = (on: boolean): void => setPicked((p) => [...p.filter((x) => !items.some((s) => s.path === x)), ...(on ? items.map((s) => s.path) : [])]);
            return (
              <div key={group} role="group" aria-label={group} className="space-y-1">
                <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                  <GroupBox label={group} all={n === items.length} some={n > 0} onChange={toggle} />
                  {group} ({n}/{items.length})
                </div>
                {items.map((s) => (
                  <label key={s.path} className="flex items-center gap-2 pl-5">
                    <input type="checkbox" checked={picked.includes(s.path)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.path] : p.filter((x) => x !== s.path)))} />
                    <span className="font-medium">{s.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{s.path}</span>
                  </label>
                ))}
              </div>
            );
          })}
          <Button
            variant="outlined"
            disabled={busy !== null || picked.length === 0}
            onClick={() => {
              const chosen = found.skills.filter((s) => picked.includes(s.path));
              void run('add', () => addSkillPr(project, found.source, { ref: found.commit, paths: chosen.map((s) => s.path) }), chosen.map((s) => s.name)).then((ok) => {
                if (ok) setFound(null);
              });
            }}
          >
            {picked.length === 0 ? 'Add skills' : `Add ${picked.length} skill${picked.length === 1 ? '' : 's'}`}
          </Button>
        </fieldset>
      )}
      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {error && (
        <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load the skills: {errorClause(error)}. Then Refresh.
        </div>
      )}
      {data && data.skills.length === 0 && <p className="text-sm text-muted-foreground">No skills in this repository's skills directory.</p>}
      {data && data.skills.length > 0 && shown.length === 0 && <p className="text-sm text-muted-foreground">No outdated skills.</p>}
      {shown.length > 0 && (
        <ScrollTable>
          <Table.Root>
            <Table.Header className="sticky top-0 z-10 bg-background [&_th]:caption">
              <Table.Row>
                <Table.Head>Skill</Table.Head>
                <Table.Head>Source</Table.Head>
                <Table.Head>Commit</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Runs</Table.Head>
                <Table.Head>Pass</Table.Head>
                <Table.Head>Repairs</Table.Head>
                <Table.Head>Cost</Table.Head>
                <Table.Head>Actions</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {shown.map((s) => (
                <Table.Row key={s.name}>
                  <Table.Cell>
                    <span className="font-medium">{s.name}</span>
                    {s.runs30d !== undefined && <span className="block text-xs text-muted-foreground">used in {s.runs30d} {s.runs30d === 1 ? 'run' : 'runs'} (30 days)</span>}
                  </Table.Cell>
                  <Table.Cell className="break-all font-mono text-xs">{s.source}</Table.Cell>
                  <Table.Cell className="font-mono">{s.commit}</Table.Cell>
                  <Table.Cell>
                    <Chip color={isOutdated(s) ? 'warning' : 'secondary'} variant="outlined">
                      {s.check}
                    </Chip>
                    {s.status === 'modified' && <span className="ml-1 text-xs text-muted-foreground">modified</span>}
                  </Table.Cell>
                  <Table.Cell className="tabular-nums">{s.usage?.runs ?? 0}</Table.Cell>
                  <Table.Cell className="tabular-nums">{pct(s.usage?.passRate)}</Table.Cell>
                  <Table.Cell className="tabular-nums">{s.usage?.avgRepairRounds.toFixed(2) ?? '-'}</Table.Cell>
                  <Table.Cell className="tabular-nums">{s.usage?.avgCostUsd.toFixed(4) ?? '-'}</Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap items-center gap-2">
                      {isOutdated(s) && (
                        <Button variant="outlined" {...gateProps(caps?.canUpdateSkill)} disabled={busy !== null || caps?.canUpdateSkill.allowed === false} onClick={() => void run(`update:${s.name}`, () => hub().call('update_skill_pr', { repoPath: project, name: s.name }))}>
                          {busy === `update:${s.name}` ? 'Opening…' : 'Open update PR'}
                        </Button>
                      )}
                      <Button variant="text" color="secondary" {...gateProps(caps?.canEditSkills)} disabled={busy !== null || caps?.canEditSkills.allowed === false} onClick={() => void run(`remove:${s.name}`, () => hub().call('remove_skill_pr', { repoPath: project, name: s.name }))}>
                        {busy === `remove:${s.name}` ? 'Opening…' : 'Remove (PR)'}
                      </Button>
                      {result(`update:${s.name}`)}
                      {result(`remove:${s.name}`)}
                    </div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </ScrollTable>
      )}
    </section>
  );
}
