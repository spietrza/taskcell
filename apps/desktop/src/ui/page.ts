/** The one page width and padding rule: every screen sits in a centred 5xl column with the same
 * padding. (The Board and the task screen opt out of the cap only: the board's columns scroll
 * sideways and the task screen is a full-width canvas.) */
export const PAGE_CLASS = 'mx-auto w-full max-w-5xl p-6 max-md:p-3';

/** An ordinary link (out to GitHub, to another screen): ink with an underline, never the accent, which means "needs you". */
export const LINK_CLASS = 'text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground';
