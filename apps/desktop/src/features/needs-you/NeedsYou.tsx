import { useState, type ReactNode } from 'react';
import { Button, Textarea } from '@/ui';
import { errorClause } from '../../errors';
import { RefreshCw } from 'lucide-react';
import type { NeedsYouItem, RepoReadFailure, RepoStamp } from '../../ipc';
import { AgentQuestion } from '../../components/AgentQuestion';
import { gateProps, useCallerCapabilities } from '../../hooks';
import { RepoFailures } from '../../RepoViews';
import { needsYouAlert, needsYouCaption } from '../../../../../packages/hub-client/src/needs-you-caption';
import { hub, isDemoLink } from '../../transport';

/** The Board id of a question's card: a hub card is its own id, a tracker issue is `gh-N` / `gl-N` (see `mintBoardId`). */
export function boardCardId(item: Pick<NeedsYouItem, 'kind' | 'id' | 'number' | 'url'>): string | undefined {
  if (item.kind === 'card') return item.id;
  if (item.kind !== 'issue') return undefined;
  return `${item.url.includes('/-/issues/') ? 'gl' : 'gh'}-${item.number}`;
}

/** `placeholder` / `action` reword the box for a PR sent back ("Ask for changes"); the hub call is the same reply. */
export function ReplyBox({ project, item, onReplied, placeholder = 'Answer the factory…', action = 'Reply' }: { project: string; item: NeedsYouItem; onReplied: () => void; placeholder?: string; action?: string }) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useCallerCapabilities(project)?.project?.canReply;

  const send = async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      await hub().call('reply_needs_you', { repoPath: project, id: item.id, kind: item.kind, body: body.trim() });
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
        placeholder={placeholder}
        rows={3}
      />
      <div className="flex items-center gap-2">
        {/* Orange: answering moves the factory on, and must read stronger than spending (Start run is ink). */}
        <Button variant="contained" color="primary" {...gateProps(gate)} disabled={sending || body.trim() === '' || gate?.allowed === false} onClick={() => void send()}>
          {sending ? 'Sending…' : action}
        </Button>
        {gate?.allowed === false && gate.reason && <span className="text-xs text-muted-foreground">{gate.reason}</span>}
        {error && (
          <span role="alert" className="text-xs text-destructive-text">
            Reply not sent: {errorClause(error)}. Refresh — the item may no longer be waiting.
          </span>
        )}
      </div>
    </div>
  );
}

/** Merge a waiting PR into its real base branch; a refusal (not waiting, checks not green) shows inline. */
export function MergeButton({ project, item, onMerged }: { project: string; item: NeedsYouItem; onMerged: () => void }) {
  const [merging, setMerging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useCallerCapabilities(project)?.project?.canMerge;
  // The hub decides: `canMerge` for the caller, `mergeBlocked` for this PR (it refuses a merge on a verify-failed one).
  const blocked = gate?.allowed === false ? gate.reason : item.mergeBlocked;
  const refused = gate?.allowed === false || item.mergeBlocked !== undefined;

  const merge = async (): Promise<void> => {
    setMerging(true);
    setConfirming(false);
    setError(null);
    try {
      await hub().call('merge_needs_you', { repoPath: project, id: item.id });
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
      <Button variant="outlined" color="primary" disabled={merging || refused} title={blocked} onClick={() => (confirming ? void merge() : setConfirming(true))}>
        {merging ? 'Merging…' : `${confirming ? 'Confirm merge' : 'Merge'}${item.baseRef ? ` into ${item.baseRef}` : ''}`}
      </Button>
      {confirming && (
        <Button variant="text" color="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      )}
      {refused && blocked && <span className="text-xs text-muted-foreground">{blocked}</span>}
      {error && (
        <span role="alert" className="text-xs text-destructive-text">
          Not merged: {error}
        </span>
      )}
    </div>
  );
}

/** "Review again" on a PR: the hub puts it back through review as its own `gh` identity. Hidden without `canStartTask`; shows "Review requested" until the next list refresh. */
export function ReReviewButton({ project, item }: { project: string; item: NeedsYouItem }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const gate = useCallerCapabilities(project)?.project?.canStartTask;
  if (gate?.allowed === false) return null;
  if (state === 'done') return <span className="text-xs text-muted-foreground">Review requested</span>;

  const request = async (): Promise<void> => {
    setState('busy');
    setError(null);
    try {
      await hub().call('rereview_pr', { repoPath: project, id: item.id });
      setState('done');
    } catch (e) {
      setError(String(e));
      setState('idle');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="outlined" color="primary" disabled={state === 'busy'} onClick={() => void request()}>
        {state === 'busy' ? 'Requesting…' : 'Review again'}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive-text">
          Review not requested: {errorClause(error)}
        </span>
      )}
    </div>
  );
}

/**
 * Home's "Waiting for you" inbox: what the factory waits on, one row per item (caption, title, repository and
 * PR, actions). Review / Answer opens the row to its last factory comment, Merge and a reply. The owner of the
 * data (the app's poll) passes `items` (null = not loaded) and `onReload` after a reply or merge.
 */
export function NeedsYou({
  project,
  items,
  failures,
  error,
  repoCount,
  onReload,
  onOpenBoard,
  onOpenCard,
  context,
}: {
  /** Where an item without its own repository is replied to. */
  project: string;
  items: (NeedsYouItem & Partial<RepoStamp>)[] | null;
  failures: RepoReadFailure[];
  error: string | null;
  repoCount: number;
  onReload: () => void;
  /** Where the empty state sends the user to start work. */
  onOpenBoard?: () => void;
  /** Opens a question's card on the Board (its title block is the link). */
  onOpenCard?: (c: { id: string; title: string; repoPath?: string }) => void;
  /** Links shown above an opened item's question: where its context lives (the card, the run that asked). */
  context?: (item: NeedsYouItem & Partial<RepoStamp>) => ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section id="needs-you" aria-label="Waiting for you" className="w-full space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold">Waiting for you</h2>
        {/* Announces the count when it changes, e.g. after a reply or a refresh finds new items. */}
        <span role="status" className="text-xs tabular-nums text-muted-foreground">
          {items === null ? '' : `${items.length} waiting`}
        </span>
        <span className="caption max-md:hidden">across {repoCount} {repoCount === 1 ? 'project' : 'projects'}</span>
        <Button className="ml-auto" variant="text" color="secondary" onClick={onReload} startIcon={<RefreshCw className="size-4" />}>
          Refresh
        </Button>
      </div>
      {error && (
        <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load what the factory is waiting on: {errorClause(error)}. Check the hub's `gh` login, then Refresh.
        </div>
      )}
      <RepoFailures failures={failures} total={repoCount} />
      {items === null && !error && <div className="text-sm text-muted-foreground">Loading…</div>}
      {items?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing needs you — the factory is not waiting on an answer for any card or PR. To start something, create a card
          {onOpenBoard && (
            <>
              {' '}
              on the{' '}
              <button type="button" className="underline" onClick={onOpenBoard}>
                Board
              </button>
            </>
          )}
          .
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((item) => {
            const key = `${item.repoPath ?? ''}:${item.id}`;
            const broken = needsYouAlert(item);
            const action = item.kind === 'pr' ? 'Review' : 'Answer';
            const expanded = open === key;
            return (
              <li key={key} className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className={`caption w-36 shrink-0 max-md:w-full ${broken ? 'text-destructive-text' : 'text-warning-text'}`}>{needsYouCaption(item)}</span>
                  {(() => {
                    const body = (
                      <>
                        <span className="block break-words font-medium group-hover:underline">{item.title}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          {item.repoName !== undefined && <span className="font-mono">{item.repoName}</span>}
                          <span>
                            {item.kind === 'card' ? (
                              <span className="font-mono">{item.id}</span>
                            ) : (
                              <>
                                {item.kind === 'pr' ? 'PR' : 'Card'} <span className="font-mono tabular-nums">#{item.number}</span>
                              </>
                            )}
                          </span>
                          {item.baseBranch && <span className="font-mono" title="target branch">→ {item.baseBranch}</span>}
                        </span>
                      </>
                    );
                    const box = 'group min-w-0 flex-1 rounded text-left max-md:basis-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
                    // A pull request is reviewed where it lives; a question opens its card here.
                    if (item.kind === 'pr' && /^https?:\/\//i.test(item.url) && !isDemoLink(item.url)) {
                      return <a href={item.url} target="_blank" rel="noreferrer" className={`${box} cursor-pointer`}>{body}</a>;
                    }
                    const cardId = boardCardId(item);
                    if (item.kind !== 'pr' && onOpenCard && cardId !== undefined) {
                      return (
                        <button type="button" className={`${box} cursor-pointer`} onClick={() => onOpenCard({ id: cardId, title: item.title, ...(item.repoPath !== undefined ? { repoPath: item.repoPath } : {}) })}>
                          {body}
                        </button>
                      );
                    }
                    return <div className={box}>{body}</div>;
                  })()}
                  <div className="flex items-center gap-2 max-md:w-full">
                    <Button
                      variant={broken ? 'outlined' : 'contained'}
                      color={broken ? 'secondary' : 'primary'}
                      aria-expanded={expanded}
                      aria-label={`${action} ${item.title}`}
                      onClick={() => setOpen(expanded ? null : key)}
                    >
                      {action}
                    </Button>
                  </div>
                </div>
                {context?.(item)}
                {expanded && (
                  <div className="space-y-2">
                    {item.lastComment && (
                      // Untrusted GitHub text, rendered as a plain text node (React escapes it), never as HTML/Markdown.
                      <div className="rounded bg-muted/40 px-3 py-2 text-sm">
                        <div className="text-xs text-muted-foreground">{item.lastComment.author}</div>
                        {/* A card's question is our run's own agent text; a tracker comment is anyone's and stays plain text. */}
                        {item.kind === 'card' ? <div className="break-words"><AgentQuestion>{item.lastComment.body}</AgentQuestion></div> : <div className="whitespace-pre-wrap break-words">{item.lastComment.body}</div>}
                      </div>
                    )}
                    {item.kind === 'pr' && <MergeButton project={item.repoPath ?? project} item={item} onMerged={onReload} />}
                    {item.kind === 'pr' && <ReReviewButton project={item.repoPath ?? project} item={item} />}
                    <ReplyBox project={item.repoPath ?? project} item={item} onReplied={onReload} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
