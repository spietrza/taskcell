/** A failed load, in human terms: what happened and a next step, with the raw error behind a
 * disclosure — never the bare error string. */
export function ErrorNote({ title, next, error }: { title: string; next: string; error: string }) {
  return (
    <div role="alert" className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{title}</p>
      <p>{next}</p>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer">Details</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{error}</pre>
      </details>
    </div>
  );
}
