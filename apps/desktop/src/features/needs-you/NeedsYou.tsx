import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Button, Card, Chip, Textarea } from '@/ui';
import { RefreshCw } from 'lucide-react';
import { listNeedsYou, replyNeedsYou, type NeedsYouItem } from '../../ipc';
import { isHubMode } from '../../transport';

/** `list_needs_you`/`reply_needs_you` are HUB_ONLY (no Tauri command); the browser dev build serves them from the mock. */
export function canUseNeedsYou(): boolean {
  return isHubMode() || !isTauri();
}

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
        <Button disabled={sending || body.trim() === ''} onClick={() => void send()}>
          {sending ? 'Sending…' : 'Reply'}
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}

/** The hub "Needs you" screen: what the factory waits on for this project, with a reply per item. */
export function NeedsYou({ project }: { project: string }) {
  const [items, setItems] = useState<NeedsYouItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = (): void => setNonce((n) => n + 1);

  useEffect(() => {
    let alive = true;
    listNeedsYou(project)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [project, nonce]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 overflow-y-auto">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Needs you</h2>
        <Button className="ml-auto" variant="text" color="secondary" onClick={reload} startIcon={<RefreshCw className="size-4" />}>
          Refresh
        </Button>
      </div>
      {error && (
        <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">{error}</div>
      )}
      {items === null && !error && <div className="text-sm text-muted-foreground">Loading…</div>}
      {items?.length === 0 && <div className="text-sm text-muted-foreground">Nothing is waiting on you.</div>}
      {items?.map((item) => (
        <Card.Root key={item.id}>
          <Card.Content className="space-y-2 p-4">
            <div className="flex items-center gap-2">
              <Chip color="secondary" variant="outlined">
                {item.kind === 'pr' ? 'PR' : 'Issue'} #{item.number}
              </Chip>
              <Chip color="warning" variant="outlined">
                {item.reason}
              </Chip>
              <a href={item.url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-medium hover:underline">
                {item.title}
              </a>
            </div>
            {item.lastComment && (
              // Untrusted GitHub text, rendered as a plain text node (React escapes it), never as HTML/Markdown.
              <div className="rounded bg-muted/40 px-3 py-2 text-sm">
                <div className="text-xs text-muted-foreground">{item.lastComment.author}</div>
                <div className="whitespace-pre-wrap break-words">{item.lastComment.body}</div>
              </div>
            )}
            <ReplyBox project={project} item={item} onReplied={reload} />
          </Card.Content>
        </Card.Root>
      ))}
    </div>
  );
}
