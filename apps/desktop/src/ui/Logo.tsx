/** Taskcell Doorway mark (as on taskcell.dev): the wall takes `currentColor`, the card is the accent. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path fill="currentColor" d="M2 2h28v16h-4V6H6v20h20v-4h4v8H2z" />
      <rect className="fill-primary" x="12" y="12" width="8" height="8" />
    </svg>
  );
}
