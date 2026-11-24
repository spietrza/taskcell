import { useEffect, useState } from 'react';
import type { NeedsYouItem } from '../../ipc';
import { hub } from '../../transport';
import { taskRefKey } from '../board/taskref';
import { AgentQuestion } from '../../components/AgentQuestion';
import { ReplyBox } from './NeedsYou';

/** What an answer does, said where it is sent: the next step is not on screen. */
export function answerEffect(item: Pick<NeedsYouItem, 'id'>): string {
  return /^gh-\d+$/.test(item.id)
    ? 'Your answer is posted on the issue, which goes back to the factory (ready for agent).'
    : 'Your answer is added to the card, which goes back to To do: it runs again when you start it, or on its own with auto-run on.';
}

/**
 * The reply box for a card whose agent stopped to ask, wherever that question is shown (a run, the card's page), so
 * the answer never needs a trip back to Home. Renders nothing while the card does not wait on an answer.
 */
export function CardAnswer({ project, taskId, onReplied, showQuestion = false }: { project: string; taskId: string; onReplied?: () => void; showQuestion?: boolean }) {
  const [item, setItem] = useState<NeedsYouItem | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setItem(null);
    const key = taskRefKey(taskId);
    hub().call('list_needs_you', { repoPath: project })
      .then((r) => alive && setItem(r.items.find((i) => i.kind === 'card' && i.id === key) ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project, taskId, nonce]);

  if (sent !== null) return <p role="status" className="text-sm text-muted-foreground">Answer sent. {sent}</p>;
  if (item === null) return null;
  return (
    <div className="space-y-1.5">
      {showQuestion && item.lastComment && (
        <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <div className="font-medium text-warning-text">The agent stopped to ask you</div>
          <div className="break-words"><AgentQuestion>{item.lastComment.body}</AgentQuestion></div>
        </div>
      )}
      <ReplyBox
        project={project}
        item={item}
        onReplied={() => {
          setSent(answerEffect(item));
          setNonce((n) => n + 1);
          onReplied?.();
        }}
      />
      <p className="text-xs text-muted-foreground">{answerEffect(item)}</p>
    </div>
  );
}
