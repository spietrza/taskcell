import { cn } from '@/ui';
import { NEEDS_YOU_CHIP } from '../../runLabels';

/** The factory's lifecycle labels, by their current spelling, with what each one means on a card. Anything else on a
 * card (the team's own labels) is not shown on the tile: the panel's Details list carries every label. */
const FACTORY_LABELS: Record<string, { text: string; needsYou?: true }> = {
  'ready for agent': { text: 'Waiting for the factory: the next sweep (or the hub worker) picks it up.' },
  'ready for spec': { text: 'Waiting for the factory to write a tech spec first.' },
  'taskcell:speccing': { text: 'The factory is writing the tech spec.' },
  'taskcell:running': { text: 'The factory is working on this card.' },
  'taskcell:verify-failed': { text: "The repo's tests failed on the agent's change." },
  'ready for taskcell review': { text: "The pull request waits for the factory's review." },
  'taskcell:reviewing': { text: 'The factory is reviewing the pull request.' },
  'needs revision': { text: 'Review asked for changes: the factory revises the pull request on its next sweep.' },
  'taskcell:revising': { text: 'The factory is applying review feedback.' },
  'needs info': { text: 'The agent asked a question. Answer it on the issue, then label it ready for agent again.', needsYou: true },
};

/** `vanguard:running` (the old name) and GitLab's scoped `taskcell::verify-failed` read as `taskcell:…`. */
const canonical = (label: string): string => label.trim().toLowerCase().replace(/^vanguard:/, 'taskcell:').replace(/^taskcell::/, 'taskcell:');

/** True for a label the tile already shows as a chip (the state line must not repeat it). */
export const isFactoryLabel = (label: string): boolean => Object.hasOwn(FACTORY_LABELS, canonical(label));

/** The card's factory labels in lifecycle order, each once, as the tracker spells them (`taskcell::running` on GitLab). */
export function factoryLabels(labels: readonly string[] | undefined): string[] {
  const spelled = new Map((labels ?? []).map((l) => [canonical(l), l.trim()] as const));
  return Object.keys(FACTORY_LABELS).flatMap((k) => (spelled.has(k) ? [spelled.get(k)!] : []));
}

/** Small chips for the factory labels a card carries; the title says what each one means. Orange only for needs-you. */
export function FactoryLabelChips({ labels }: { labels: readonly string[] | undefined }) {
  const shown = factoryLabels(labels);
  if (shown.length === 0) return null;
  return (
    <ul aria-label="Factory labels" className="flex flex-wrap gap-1">
      {shown.map((l) => {
        const { text, needsYou } = FACTORY_LABELS[canonical(l)]!;
        return (
          <li key={l} title={text} aria-label={`${l}: ${text}`} className={cn('text-[11px]', needsYou ? NEEDS_YOU_CHIP : 'rounded border border-border px-1.5 py-px text-muted-foreground')}>
            {l}
          </li>
        );
      })}
    </ul>
  );
}
