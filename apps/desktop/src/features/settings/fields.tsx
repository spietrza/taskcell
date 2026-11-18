import type { ReactNode } from 'react';
import { Tooltip } from '@/ui';
import { Info } from 'lucide-react';

/** `help`: what the setting does, behind an info icon next to the label (hover or focus). */
export function Field({ label, hint, help, error, children }: { label: string; hint?: string; help?: string; error?: string | undefined; children: ReactNode }) {
  const field = (
    <label className="block space-y-1">
      <span className="text-sm">
        {label}
        {help && <Help text={help} />}
        {hint && <span className="ml-1 text-xs text-muted-foreground">{hint}</span>}
      </span>
      {children}
      {error !== undefined && <span role="alert" className="block text-xs text-destructive-text">{error}</span>}
    </label>
  );
  if (!help) return field;
  // Screen readers get the help as text after the field: inside the <label> it would join the field's name.
  return (
    <div>
      {field}
      <span className="sr-only">{help}</span>
    </div>
  );
}

/** The hover popup for sighted users; Field repeats the text for screen readers. */
function Help({ text }: { text: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          // Inside the field's <label>: a click must not move focus to the input.
          <span aria-hidden data-testid="field-help" onClick={(e) => e.preventDefault()} className="ml-1 inline-flex size-4 translate-y-0.5 cursor-help items-center justify-center text-muted-foreground hover:text-foreground" />
        }
      >
        <Info className="size-3.5" aria-hidden />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6}>
          <Tooltip.Popup className="z-50 max-w-xs rounded-md border border-border bg-background px-2.5 py-1.5 text-xs leading-relaxed text-foreground shadow-md">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const SELECT_CLASS = 'h-9 w-full rounded border border-border bg-background px-2 text-sm';

export function Select({
  value,
  onChange,
  options,
  danglingLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  /** Render a stored value missing from options as a flagged entry so display matches storage. */
  danglingLabel?: (v: string) => string;
}) {
  const dangling = value !== '' && !options.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">—</option>
      {dangling && (
        <option value={value}>{danglingLabel ? danglingLabel(value) : value}</option>
      )}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
