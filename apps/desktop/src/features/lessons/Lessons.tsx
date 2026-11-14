import { useState } from 'react';
import { Button, Card, Chip, Input, Timestamp } from '@/ui';
import { RefreshCw } from 'lucide-react';
import { dismissLesson, fetchSpec, listLessons } from '../../ipc';
import { errorClause } from '../../errors';
import { useAsync } from '../../hooks';
import { ExternalLink } from '../../components/ExternalLink';
import type { RepoLesson } from '../../wire';

/** Lesson text is distilled from PR discussion: only http(s) addresses become links. */
const webUrl = (u: string): string | undefined => (/^https?:\/\//i.test(u) ? u : undefined);

/** Case-insensitive match of `text` against a lesson's path scope (a repo-wide lesson has none, so only an empty filter shows it). */
export const matchesPath = (l: RepoLesson, text: string): boolean => {
  const q = text.trim().toLowerCase();
  return q === '' || l.paths.some((p) => p.toLowerCase().includes(q));
};

function LessonCard({ lesson, onDismiss }: { lesson: RepoLesson; onDismiss?: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onDismiss?.();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <Card.Root className="py-0">
      <Card.Content className="space-y-2 p-4">
        <div className="break-words font-medium">{lesson.rule}</div>
        {lesson.why !== '' && <div className="break-words text-sm text-muted-foreground">Why: {lesson.why}</div>}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {lesson.stage && (
            <Chip color="secondary" variant="outlined">
              {lesson.stage}
            </Chip>
          )}
          <span className="break-all font-mono">{lesson.paths.length > 0 ? lesson.paths.join(', ') : 'whole repository'}</span>
          <Timestamp ms={Date.parse(lesson.timestamp)} className="tabular-nums" />
          <ExternalLink href={webUrl(lesson.evidence)}>{`Evidence: PR #${lesson.prNumber}`}</ExternalLink>
        </div>
        {onDismiss && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outlined" disabled={busy} onClick={() => (confirming ? void dismiss() : setConfirming(true))}>
              {busy ? 'Dismissing…' : confirming ? 'Confirm dismiss' : 'Dismiss'}
            </Button>
            {confirming && !busy && (
              <>
                <Button variant="text" color="secondary" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <span className="text-xs text-muted-foreground">Later runs will no longer receive this lesson.</span>
              </>
            )}
            {error && (
              <span role="alert" className="text-xs text-destructive-text">
                Not dismissed: {error}
              </span>
            )}
          </div>
        )}
      </Card.Content>
    </Card.Root>
  );
}

const LESSONS_DOCS = 'https://github.com/spietrza/taskcell/blob/main/docs/autonomous-loop.md#per-pr-lessons';

/** Where lessons live and what writes them: the one explanation the empty and the populated screen share. */
function LessonsSource() {
  return (
    <>
      Lessons are stored in <code className="font-mono">lessons.jsonl</code> on the <code className="font-mono">taskcell-metrics</code> branch,
      written by <code className="font-mono">taskcell lessons record</code> (the Lessons workflow) when a factory PR closes.{' '}
      <ExternalLink href={LESSONS_DOCS}>How lessons work</ExternalLink>
    </>
  );
}

/** The project's Lessons view (hub): what the factory learned from past PRs, newest first, with Dismiss. */
export function Lessons({ project }: { project: string }) {
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState('');
  const { data, error, loading } = useAsync(() => listLessons(project), [project, nonce]);
  const shown = (data?.lessons ?? []).filter((l) => matchesPath(l, filter));
  const none = (data?.lessons.length ?? 0) === 0;
  return (
    <section aria-label="Lessons" className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">Lessons</h2>
        <Input aria-label="Filter by path" placeholder="Filter by path…" value={filter} onChange={(e) => setFilter(e.target.value)} disabled={none} className="max-w-xs" />
        <Button className="ml-auto" variant="text" color="secondary" onClick={() => setNonce((n) => n + 1)} startIcon={<RefreshCw className="size-4" />}>
          Refresh
        </Button>
      </div>
      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {error && (
        <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load the lessons: {errorClause(error)}. Check that the hub can reach the repository, then Refresh.
        </div>
      )}
      {data && !data.branchFound && (
        <p className="text-sm text-muted-foreground">
          No lessons yet: this repository has no metrics branch. <LessonsSource />
        </p>
      )}
      {data?.branchFound && data.lessons.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No lessons yet: no closed factory PR has taught anything worth keeping. <LessonsSource />
        </p>
      )}
      {data && data.lessons.length > 0 && (
        <p className="text-xs text-muted-foreground">
          <LessonsSource />
        </p>
      )}
      {data && data.lessons.length > 0 && shown.length === 0 && <p className="text-sm text-muted-foreground">No lesson applies to a path containing “{filter.trim()}”.</p>}
      {shown.map((l) => (
        <LessonCard
          key={l.id}
          lesson={l}
          onDismiss={async () => {
            await dismissLesson(project, l.id);
            setNonce((n) => n + 1);
          }}
        />
      ))}
    </section>
  );
}

/** The lessons a task (or run) with this id would receive: those matching its spec text. Hidden when there are none or the hub cannot say. */
export function AppliedLessons({ project, taskId }: { project: string; taskId: string }) {
  const { data } = useAsync(async () => listLessons(project, await fetchSpec(project, taskId)), [project, taskId]);
  if (!data || data.lessons.length === 0) return null;
  return (
    <section aria-label="Lessons that apply" className="space-y-2">
      <div className="caption">Lessons that apply</div>
      {data.lessons.map((l) => (
        <LessonCard key={l.id} lesson={l} />
      ))}
    </section>
  );
}
