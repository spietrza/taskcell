import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Button, Card, Chip, Empty, Textarea } from '@/ui';
import { MessageCircleQuestionMark, RefreshCw } from 'lucide-react';
import { listNeedsYou, listNeedsYouAll, mergeNeedsYou, replyNeedsYou, type NeedsYouItem, type RepoReadFailure, type RepoStamp } from '../../ipc';
import { RepoFailures, RepoLabel } from '../../RepoViews';
import { isHubMode } from '../../transport';
import { ExternalLink } from '../../components/ExternalLink';

/** `list_needs_you`/`reply_needs_you` are served by the hub only; outside it only the browser dev build's mock answers them. */
export function canUseNeedsYou(): boolean {
  return isHubMode() || (import.meta.env.DEV && !isTauri());
}

/** Plain words for the factory's waiting labels (src/hub/needs-you.ts); anything else shows as-is. */
const REASON_TEXT: Record<string, string> = {
  'vanguard:needs-human-review': 'needs a human review',
  'vanguard:verify-failed': 'verify failed',
};

function ReplyBox({ project, item, onReplied }: { project: string; item: NeedsYouItem; onReplied: () => void }) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      await replyNeedsYou(project, item.id, item.kind, body.trim());
      setBody('');
      onReplied();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-2">
      <Textarea
        aria-label={`reply to ${item.id}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Answer the factory…"
        rows={3}
      />
      <div className="flex items-center gap-2">
        {/* Outlined: the screen has one Reply per item, so none of them is the screen's primary action. */}
        <Button variant="outlined" disabled={sending || body.trim() === ''} onClick={() => void send()}>
          {sending ? 'Sending…' : 'Reply'}
        </Button>
        {error && (
          <span role="alert" className="text-xs text-destructive-text">
            Reply not sent: {error}. Refresh — the item may no longer be waiting.
          </span>
        )}
      </div>
    </div>
  );
}

/** Merge a waiting PR into its real base branch; a refusal (not waiting, checks not green) shows inline. */
function MergeButton({ project, item, onMerged }: { project: string; item: NeedsYouItem; onMerged: () => void }) {
  const [merging, setMerging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merge = async (): Promise<void> => {
    setMerging(true);
    setConfirming(false);
    setError(null);
    try {
      await mergeNeedsYou(project, item.id);
      onMerged();
    } catch (e) {
      setError(String(e));
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Outlined, like Reply: the screen has one per item. A merge is irreversible, so it takes a second click. */}
      <Button variant="outlined" disabled={merging} onClick={() => (confirming ? void merge() : setConfirming(true))}>
        {merging ? 'Merging…' : `${confirming ? 'Confirm merge' : 'Merge'}${item.baseRef ? ` into ${item.baseRef}` : ''}`}
      </Button>
      {confirming && (
        <Button variant="text" color="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      )}
      {error && (
        <span role="alert" className="text-xs text-destructive-text">
          Not merged: {error}
        </span>
      )}
    </div>
  );
}

/** The hub "Needs you" screen: what the factory waits on for this project, with a reply per item. */
export function NeedsYou({ project, allRepos = false }: { project: string; allRepos?: boolean }) {
  const [items, setItems] = useState<(NeedsYouItem & Partial<RepoStamp>)[] | null>(null);
  const [failures, setFailures] = useState<RepoReadFailure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = (): void => setNonce((n) => n + 1);

  useEffect(() => {
    let alive = true;
    (allRepos ? listNeedsYouAll() : listNeedsYou(project).then((r) => ({ ...r, failures: [] })))
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setFailures(r.failures);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [project, allRepos, nonce]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 overflow-y-auto">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">Needs you</h2>
        {/* Announces the count when it changes, e.g. after a reply or a refresh finds new items. */}
        <span role="status" className="text-xs tabular-nums text-muted-foreground">
          {items === null ? '' : `${items.length} waiting`}
        </span>
        <Button className="ml-auto" variant="text" color="secondary" onClick={reload} startIcon={<RefreshCw className="size-4" />}>
          Refresh
        </Button>
      </div>
      {error && (
        <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load what the factory is waiting on: {error}. Check the hub's `gh` login, then Refresh.
        </div>
      )}
      <RepoFailures failures={failures} />
      {items === null && !error && <div className="text-sm text-muted-foreground">Loading…</div>}
      {items?.length === 0 && (
        <Empty.Root>
          <Empty.Media>
            <MessageCircleQuestionMark />
          </Empty.Media>
          <Empty.Title>Nothing needs you</Empty.Title>
          <Empty.Description>The factory is not waiting on an answer for any Task or PR in this project.</Empty.Description>
        </Empty.Root>
      )}
      {items?.map((item) => (
        // py-0: Card.Root's own vertical padding doubled Card.Content's p-4 into a gap above the chips.
        <Card.Root key={`${item.repoPath ?? ''}:${item.id}`} className="py-0">
          <Card.Content className="space-y-2 p-4">
            <div className="flex items-center gap-2">
              {allRepos && item.repoName !== undefined && <RepoLabel name={item.repoName} />}
              <Chip color="secondary" variant="outlined">
                {item.kind === 'pr' ? 'PR' : 'Task'} <span className="font-mono tabular-nums">#{item.number}</span>
              </Chip>
              {item.baseBranch && (
                <span className="font-mono text-xs text-muted-foreground" title="target branch">→ {item.baseBranch}</span>
              )}
              <Chip color="warning" variant="outlined" title={item.reason}>
                {REASON_TEXT[item.reason] ?? item.reason}
              </Chip>
              <a href={item.url || undefined} target="_blank" rel="noreferrer" className="min-w-0 truncate font-medium hover:underline">
                {item.title}
              </a>
              <ExternalLink href={item.url} className="ml-auto shrink-0">Open in GitHub</ExternalLink>
            </div>
            {item.lastComment && (
              // Untrusted GitHub text, rendered as a plain text node (React escapes it), never as HTML/Markdown.
              <div className="rounded bg-muted/40 px-3 py-2 text-sm">
                <div className="text-xs text-muted-foreground">{item.lastComment.author}</div>
                <div className="whitespace-pre-wrap break-words">{item.lastComment.body}</div>
              </div>
            )}
            {item.kind === 'pr' && <MergeButton project={item.repoPath ?? project} item={item} onMerged={reload} />}
            <ReplyBox project={item.repoPath ?? project} item={item} onReplied={reload} />
          </Card.Content>
        </Card.Root>
      ))}
    </div>
  );
}
