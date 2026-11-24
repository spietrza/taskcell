import { useState } from 'react';
import { Button, Input } from '@/ui';
import { hub } from '../../transport';
import { errorClause, errorMessage } from '../../errors';
import { CHAT_MODELS } from '../../wire';
import { Field, SELECT_CLASS } from './fields';

/**
 * Settings → Doc chat model: pick from the known models, or type any model id. "Fetch models" lists what the saved
 * endpoint or provider offers; the hub reads it, so a provider key never reaches the browser.
 */
export function ChatModelField({ project, value, onChange }: { project: string; value: string; onChange: (v: string | undefined) => void }) {
  const [models, setModels] = useState<readonly string[]>(CHAT_MODELS);
  const [fetching, setFetching] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  const fetchModels = (): void => {
    setFetching(true);
    setNote(null);
    hub().call('list_chat_models', { repoPath: project })
      .then(
        (r) => {
          if (r.error !== undefined) return setNote({ text: `Models could not be listed: ${errorClause(r.error)}.`, error: true });
          setModels(r.models);
          setNote({ text: r.source === 'static' ? 'No saved endpoint or provider lists its models: these are the built-in ones.' : `${r.models.length} models from ${r.origin ?? r.source}.`, error: false });
        },
        (e: unknown) => setNote({ text: `Models could not be listed: ${errorClause(errorMessage(e))}.`, error: true }),
      )
      .finally(() => setFetching(false));
  };

  return (
    <div className="space-y-2">
      <Field label="Doc chat model" hint="— the chat beside a new card (uses your Claude auth from the environment); pick one or type any model id">
        <Input value={value} onChange={(e) => onChange(e.target.value || undefined)} className="w-full font-mono text-xs" placeholder="claude-sonnet-5" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Known models"
          value={models.includes(value) ? value : ''}
          onChange={(e) => e.target.value !== '' && onChange(e.target.value)}
          className={`${SELECT_CLASS} min-w-0 flex-1 basis-56 font-mono text-xs`}
        >
          <option value="">Pick a model ({models.length})…</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <Button variant="outlined" color="secondary" className="h-9 shrink-0" onClick={fetchModels} disabled={fetching}>
          {fetching ? 'Fetching…' : 'Fetch models'}
        </Button>
      </div>
      {note !== null ? (
        <p role={note.error ? 'alert' : 'status'} className={`text-xs ${note.error ? 'text-destructive-text' : 'text-muted-foreground'}`}>
          {note.text}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Fetch models asks the saved chat endpoint or provider (save a new one first).</p>
      )}
    </div>
  );
}
