import { useState } from 'react';
import { Button, Chip, Input, ScrollTable, Table } from '@/ui';
import { RefreshCw } from 'lucide-react';
import { addSkillPr, listRepoSkills, removeSkillPr, updateSkillPr } from '../../ipc';
import { errorClause, errorMessage } from '../../errors';
import { useAsync } from '../../hooks';
import { ExternalLink } from '../../components/ExternalLink';
import type { RepoSkill } from '../../wire';

const webUrl = (u: string): string | undefined => (/^https?:\/\//i.test(u) ? u : undefined);

const pct = (v: number | undefined): string => (v === undefined ? '-' : `${(v * 100).toFixed(0)}%`);

/** A skill needs an update PR when its upstream moved. */
export const isOutdated = (s: RepoSkill): boolean => s.check === 'outdated';

/** A pull request a skills action opened, or why it did not. */
type Outcome = { kind: 'ok'; prUrl: string } | { kind: 'error'; message: string };

/** The project's Skills view (hub): staleness and usage, and PR-only changes. Skill content is never edited here. */
export function Skills({ project }: { project: string }) {
  const [nonce, setNonce] = useState(0);
  const [onlyOutdated, setOnlyOutdated] = useState(false);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({});
  const { data, error, loading } = useAsync(() => listRepoSkills(project), [project, nonce]);
  const shown = (data?.skills ?? []).filter((s) => !onlyOutdated || isOutdated(s));

  const run = async (key: string, action: () => Promise<{ prUrl: string }>): Promise<void> => {
    setBusy(key);
    try {
      const { prUrl } = await action();
      setOutcome((o) => ({ ...o, [key]: { kind: 'ok', prUrl } }));
    } catch (e) {
      setOutcome((o) => ({ ...o, [key]: { kind: 'error', message: errorClause(errorMessage(e)) } }));
    } finally {
      setBusy(null);
    }
  };
  const result = (key: string) => {
    const o = outcome[key];
    if (o === undefined) return null;
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
        <Button className="ml-auto" variant="text" color="secondary" onClick={() => setNonce((n) => n + 1)} startIcon={<RefreshCw className="size-4" />}>
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Shows the hub checkout's working tree; every change here opens a pull request off the default branch, which can differ.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Skill source" placeholder="https://github.com/org/skill-repo" value={source} onChange={(e) => setSource(e.target.value)} className="max-w-md" />
        <Button variant="outlined" disabled={busy !== null || source.trim() === ''} onClick={() => void run('add', () => addSkillPr(project, source.trim()))}>
          {busy === 'add' ? 'Adding…' : 'Add skill'}
        </Button>
        {result('add')}
      </div>
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
                  <Table.Cell className="font-medium">{s.name}</Table.Cell>
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
                        <Button variant="outlined" disabled={busy !== null} onClick={() => void run(`update:${s.name}`, () => updateSkillPr(project, s.name))}>
                          {busy === `update:${s.name}` ? 'Opening…' : 'Open update PR'}
                        </Button>
                      )}
                      <Button variant="text" color="secondary" disabled={busy !== null} onClick={() => void run(`remove:${s.name}`, () => removeSkillPr(project, s.name))}>
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
