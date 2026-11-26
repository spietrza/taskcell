/**
 * The comment ledger: the factory's durable state on issues, PRs and MRs lives in hidden `<!-- name: payload -->`
 * comment markers. Each kind is declared once here: its spellings (current `taskcell-`, legacy `vanguard-`, and the
 * unbranded white-label one where it has one), its payload and who may author it. Everything else (write, read,
 * strip, the questions runners ask) is derived from the declarations, so a new kind is stripped from model-authored
 * text and subject to the same trust rule without touching any other module.
 *
 * Reading comments stays with the gh/glab readers: they classify each author (`AuthorClass`) and hand the ledger
 * `LedgerComment`s. A marker counts only when its declaration allows the author's class.
 */

import { z } from 'zod';

/** `self`: the identity the factory runs as (viewerDidAuthor, the glab user). `trusted`: any other author the host adapter trusts. */
export type AuthorClass = 'self' | 'trusted' | 'untrusted';

/** `self`: only the factory's own identity. `trusted`: self or any trusted author. `anyone`: no author rule (the payload is validated instead). */
export type MarkerAuthors = 'self' | 'trusted' | 'anyone';

export interface LedgerComment {
  body: string;
  author: AuthorClass;
  /** ISO time, for the questions that order comments. */
  createdAt?: string;
}

export interface MarkerDecl<P> {
  kind: string;
  /** The marker name as written (`taskcell-pr-review`). */
  current: string;
  /** Older spellings, still read (`vanguard-pr-review`). */
  legacy: readonly string[];
  /** The unbranded spelling written for a white-label repo; absent when the kind has none. */
  whiteLabel?: string;
  /** `line`: the marker must be alone on its line. `anywhere`: found anywhere in the body. */
  anchor: 'line' | 'anywhere';
  authors: MarkerAuthors;
  /** Regex source for what follows the name up to the closing ` -->`; its capture groups feed `parse`. */
  tail: string;
  /** Text after the name for a payload (leading separator included). */
  render(payload: P): string;
  /** The payload for one match's capture groups; undefined for a malformed one. */
  parse(groups: readonly string[]): P | undefined;
  /** Whether a bare opener (`<!-- name:`), well-formed or not, already counts as present (`hasOpener`). */
  opener?: boolean;
}

/** The brand tokens a spelling may carry: `taskcell` (current) and `vanguard` (legacy, pre-rename). */
const names = (name: string, sep: '-' | ':' = '-'): Pick<MarkerDecl<never>, 'current' | 'legacy'> => ({
  current: `taskcell${sep}${name}`,
  legacy: [`vanguard${sep}${name}`],
});

const SHA = '[a-fA-F0-9]+';
const ws = (d: Pick<MarkerDecl<unknown>, 'anchor'>): string => (d.anchor === 'line' ? '[ \\t]*' : '\\s*');
/** Whitespace `.trim()` or GitLab's rstrip could remove around a marker line; excludes line breaks (a `\s*` is quadratic on blank runs). */
const MARKER_PAD = String.raw`[^\S\n\r\u2028\u2029]*`;

const shaDecl = (kind: string, name: string, authors: MarkerAuthors, sep: '-' | ':' = '-'): MarkerDecl<string> => ({
  kind,
  ...names(name, sep),
  anchor: 'line',
  authors,
  tail: `:[ \\t]*(${SHA})`,
  render: (sha) => `: ${sha}`,
  parse: (g) => g[0],
});

const bareDecl = (kind: string, name: string, anchor: 'line' | 'anywhere', authors: MarkerAuthors): MarkerDecl<true> => ({
  kind,
  ...names(name),
  anchor,
  authors,
  tail: '',
  render: () => '',
  parse: () => true,
});

export interface RateLimitedPayload {
  until: Date;
  trigger: string;
}
export interface OverlapPayload {
  until: Date;
  refs: { kind: 'pr' | 'run'; number: number }[];
}
export interface RevisionPayload {
  head: string;
  /** A merge-only round: present for non-recursion, never a counted round. */
  mergeOnly: boolean;
}
export interface MergeOnlyPayload {
  from: string;
  to: string;
  files: string[];
}
export type WaitingKind = 'error' | 'error-repeat';

const mergeOnlySchema = z.object({ from: z.string(), to: z.string(), files: z.array(z.string()) });

const DECLARATIONS: MarkerDecl<never>[] = [];
const registry = new Map<string, MarkerDecl<never>>();
let compiled: { lines: RegExp; openers: RegExp } | undefined;
const matchers = new WeakMap<MarkerDecl<never>, RegExp>();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
const spellings = (d: MarkerDecl<unknown>): string[] => [d.current, ...d.legacy, ...(d.whiteLabel !== undefined ? [d.whiteLabel] : [])];
const alt = (d: MarkerDecl<unknown>): string => spellings(d).map(escapeRe).join('|');

/** Declare a marker kind. Built-ins below use it; a later declaration is stripped and trust-checked like them. */
export function declareMarker<P>(decl: MarkerDecl<P>): MarkerDecl<P> {
  if (registry.has(decl.kind)) throw new Error(`comment ledger: marker kind "${decl.kind}" is already declared`);
  registry.set(decl.kind, decl as MarkerDecl<never>);
  DECLARATIONS.push(decl as MarkerDecl<never>);
  compiled = undefined;
  return decl;
}

/** The body regexes: `kind` markers, all spellings, global (and multiline for line-anchored ones). */
function matcher(decl: MarkerDecl<never>): RegExp {
  let re = matchers.get(decl);
  if (re === undefined) {
    const inner = `<!--${ws(decl)}(?:${alt(decl)})${decl.tail}${ws(decl)}-->`;
    re = decl.anchor === 'line' ? new RegExp(`^${MARKER_PAD}${inner}${MARKER_PAD}$`, 'gm') : new RegExp(inner, 'g');
    matchers.set(decl, re);
  }
  return re;
}

/** Every declared marker, in the two shapes a strip needs: whole lines, and bare openers of free-position kinds. */
function stripPatterns(): { lines: RegExp; openers: RegExp } {
  if (compiled !== undefined) return compiled;
  const lines = DECLARATIONS.filter((d) => d.anchor === 'line').map((d) => `<!--${ws(d)}(?:${alt(d)})${d.tail}${ws(d)}-->`);
  // An opener is dropped with the rest of its marker when well-formed, closed or not: a half marker may still count (`hasOpener`).
  const openers = DECLARATIONS.filter((d) => d.anchor === 'anywhere').map((d) => `<!--\\s*(?:${alt(d)})(?!\\w|-(?!->))(?:[^>]*-->)?`);
  compiled = {
    lines: new RegExp(`^${MARKER_PAD}(?:${lines.join('|') || '(?!)'})${MARKER_PAD}$`, 'gm'),
    openers: new RegExp(openers.join('|') || '(?!)', 'g'),
  };
  return compiled;
}

function decl<P>(kind: string): MarkerDecl<P> {
  const d = registry.get(kind);
  if (d === undefined) throw new Error(`comment ledger: unknown marker kind "${kind}"`);
  return d as unknown as MarkerDecl<P>;
}

/** The marker text for a payload. `whiteLabel` picks the unbranded spelling when the kind has one. */
export function writeMarker<P>(kind: string, payload: P, opts: { whiteLabel?: boolean } = {}): string {
  const d = decl<P>(kind);
  const name = opts.whiteLabel === true && d.whiteLabel !== undefined ? d.whiteLabel : d.current;
  return `<!-- ${name}${d.render(payload)} -->`;
}

/**
 * Every well-formed marker of `kind` in one body, in order, under any declared spelling. No author rule is applied:
 * use it only on a body whose author was already vetted (or for `anyone` kinds); otherwise `readTrusted`.
 */
export function parseMarkers<P>(kind: string, body: string): P[] {
  const d = decl<P>(kind);
  const found: P[] = [];
  for (const match of body.matchAll(matcher(d as MarkerDecl<never>))) {
    const payload = d.parse(match.slice(1).map((g) => g ?? ''));
    if (payload !== undefined) found.push(payload);
  }
  return found;
}

/** How many times a body mentions any spelling of the kind's name, well-formed or not (a second mention of a once-only stamp is a planted one). */
export function mentionCount(kind: string, body: string): number {
  const d = decl<unknown>(kind);
  return spellings(d).reduce(
    (n, name) => n + (body.match(new RegExp(`${escapeRe(name)}(?![\\w-])`, 'g'))?.length ?? 0),
    0,
  );
}

/**
 * The payload of a once-only stamp: the body carries exactly one marker of the kind, as its last line, and mentions the
 * kind nowhere else. Undefined for none, for one anywhere else and for any second mention. No author rule.
 */
export function soleTrailingMarker<P>(kind: string, body: string): P | undefined {
  const d = decl<P>(kind);
  const matches = Array.from(body.matchAll(matcher(d as MarkerDecl<never>)));
  if (matches.length !== 1 || mentionCount(kind, body) !== 1) return undefined;
  return body.trimEnd().endsWith(`\n${matches[0]![0]}`) ? d.parse(matches[0]!.slice(1).map((g) => g ?? '')) : undefined;
}

/** Whether a body carries a marker of `kind`: a well-formed one, or for an `opener` kind a bare opener. No author rule. */
export function hasMarker(kind: string, body: string): boolean {
  const d = decl<unknown>(kind);
  if (parseMarkers(kind, body).length > 0) return true;
  return d.opener === true && new RegExp(`<!--\\s*(?:${alt(d)}):`).test(body);
}

const allows = (authors: MarkerAuthors, author: AuthorClass): boolean =>
  authors === 'anyone' ? true : authors === 'self' ? author === 'self' : author !== 'untrusted';

/** Payloads of `kind` from comments whose author the declaration allows, in comment order. A forged marker is ignored. */
export function readTrusted<P>(kind: string, comments: readonly LedgerComment[]): P[] {
  const { authors } = decl<P>(kind);
  return comments.flatMap((c) => (allows(authors, c.author) ? parseMarkers<P>(kind, c.body) : []));
}

/** The comments (allowed authors only) that carry a marker of `kind`. */
export function trustedCommentsWith(kind: string, comments: readonly LedgerComment[]): LedgerComment[] {
  const { authors } = decl<unknown>(kind);
  return comments.filter((c) => allows(authors, c.author) && hasMarker(kind, c.body));
}

/** Whether an allowed author already wrote exactly this marker (any spelling of it): the dedupe behind `commentOnce`. */
export function containsTrustedMarker(markerText: string, comments: readonly LedgerComment[]): boolean {
  return DECLARATIONS.some((d) => {
    const kind = d.kind;
    const wanted = parseMarkers<unknown>(kind, markerText).map((p) => (d as MarkerDecl<unknown>).render(p));
    return wanted.length > 0 && readTrusted<unknown>(kind, comments).some((p) => wanted.includes((d as MarkerDecl<unknown>).render(p)));
  });
}

/** Remove every declared marker from text the bot posts but did not write (a model reply, an error). `\r` goes first: GitLab drops it when it saves a note. */
export function stripAllMarkers(text: string): string {
  let out = text.replaceAll('\r', '');
  // Repeat until stable: removing one marker can join the pieces around it into a new one.
  for (let prev = ''; prev !== out; ) {
    prev = out;
    const { lines, openers } = stripPatterns();
    out = out.replace(lines, '').replace(openers, '');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------

declareMarker(shaDecl('pr-review', 'pr-review', 'trusted'));
declareMarker({
  kind: 'pr-review-run',
  ...names('pr-review-run'),
  anchor: 'line',
  authors: 'trusted',
  tail: `:[ \\t]*(${SHA}):(\\d+)`,
  render: (p: { sha: string; runId: string }) => `: ${p.sha}:${p.runId}`,
  parse: (g) => (g[0] !== undefined && g[1] !== undefined ? { sha: g[0], runId: g[1] } : undefined),
});
declareMarker(shaDecl('pr-review-incomplete', 'pr-review-incomplete', 'trusted'));
declareMarker(shaDecl('pr-review-incomplete-cap', 'pr-review-incomplete-cap', 'trusted'));
declareMarker(bareDecl('pr-review-incomplete-note', 'pr-review-incomplete', 'line', 'trusted'));
declareMarker(shaDecl('mr-review', 'mr-review', 'self'));
declareMarker(shaDecl('mr-review-incomplete', 'mr-review-incomplete', 'self'));
declareMarker(shaDecl('mr-review-incomplete-cap', 'mr-review-incomplete-cap', 'self'));

declareMarker({
  kind: 'revision',
  ...names('revision'),
  whiteLabel: 'revision',
  anchor: 'anywhere',
  authors: 'trusted',
  opener: true,
  tail: '(?::\\s*([^>\\s]+)(\\s+merge-only)?)',
  render: (p: RevisionPayload) => `: ${p.head}${p.mergeOnly ? ' merge-only' : ''}`,
  parse: (g) => (g[0] !== undefined && g[0] !== '' ? { head: g[0], mergeOnly: g[1] !== undefined && g[1] !== '' } : undefined),
});
declareMarker(bareDecl('revision-cap', 'revision-cap', 'anywhere', 'trusted'));
declareMarker({
  kind: 'ci-failed',
  ...names('ci-failed'),
  anchor: 'anywhere',
  authors: 'trusted',
  tail: `:\\s*(${SHA})`,
  render: (sha: string) => `: ${sha}`,
  parse: (g) => g[0],
});
declareMarker({
  kind: 'ci-watch-cap',
  ...names('ci-watch-cap'),
  anchor: 'anywhere',
  authors: 'trusted',
  tail: ':\\s*(ci|base)',
  /** Which cap the CI watch hit: `ci` (CI-failure comments) or `base` (base-merge comments). */
  render: (which: 'ci' | 'base') => `: ${which}`,
  parse: (g) => (g[0] === 'ci' || g[0] === 'base' ? g[0] : undefined),
});
declareMarker({
  kind: 'base-conflict',
  ...names('base-conflict'),
  anchor: 'anywhere',
  authors: 'trusted',
  tail: `:\\s*(${SHA})`,
  render: (sha: string) => `: ${sha}`,
  parse: (g) => g[0],
});
declareMarker({
  kind: 'approver',
  ...names('approver'),
  anchor: 'anywhere',
  authors: 'trusted',
  tail: ':[ \\t]*([^\\s>]+)',
  /** The head SHA the shadow-mode decision comment speaks for (`none` when unknown). */
  render: (head: string) => `: ${head}`,
  parse: (g) => g[0],
});
declareMarker({
  kind: 'approver-act',
  ...names('approver-act'),
  anchor: 'anywhere',
  authors: 'trusted',
  tail: ':[ \\t]*([^\\s>]+)',
  /** `<head>:<action>:<reason key>`: one act-mode note per head and reason. */
  render: (key: string) => `: ${key}`,
  parse: (g) => g[0],
});
declareMarker({
  kind: 'research',
  ...names('research'),
  whiteLabel: 'research-iter',
  anchor: 'anywhere',
  authors: 'trusted',
  tail: ':\\s*(\\d+)',
  render: (iteration: number) => `: ${iteration}`,
  parse: (g) => (g[0] !== undefined ? Number(g[0]) : undefined),
});
declareMarker(bareDecl('lesson', 'lesson', 'anywhere', 'trusted'));
declareMarker({
  kind: 'merge-only',
  current: 'merge-only',
  legacy: [],
  anchor: 'line',
  authors: 'trusted',
  tail: ':[ \\t]*(\\{.*\\})',
  render: (p: MergeOnlyPayload) => `: ${JSON.stringify({ from: p.from, to: p.to, files: p.files }).replace(/--(!?)>/g, '--$1\\u003e')}`,
  parse: (g) => {
    try {
      const parsed = mergeOnlySchema.safeParse(JSON.parse(g[0] ?? ''));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  },
});
declareMarker({
  kind: 'rate-limited',
  ...names('rate-limited'),
  anchor: 'anywhere',
  authors: 'trusted',
  tail: '\\s+until=(\\S+)\\s+trigger="([^"]*)"',
  render: (p: RateLimitedPayload) => ` until=${p.until.toISOString()} trigger="${p.trigger}"`,
  parse: (g) => {
    const until = new Date(g[0] ?? '');
    const trigger = (g[1] ?? '').trim();
    if (Number.isNaN(until.getTime()) || trigger === '' || trigger.length > 50 || /[\r\n]/.test(trigger)) return undefined;
    return { until, trigger };
  },
});
declareMarker({
  kind: 'waiting',
  ...names('waiting', ':'),
  anchor: 'anywhere',
  authors: 'trusted',
  tail: ' trigger="([^"]+)"(?: kind="(error|error-repeat)")?',
  render: (p: { trigger: string; kind?: WaitingKind }) => ` trigger="${p.trigger}"${p.kind !== undefined ? ` kind="${p.kind}"` : ''}`,
  parse: (g) => (g[0] !== undefined && g[0] !== '' ? { trigger: g[0], ...(g[1] !== undefined && g[1] !== '' ? { kind: g[1] as WaitingKind } : {}) } : undefined),
});
declareMarker({
  kind: 'overlap',
  ...names('overlap', ':'),
  anchor: 'anywhere',
  authors: 'trusted',
  tail: ' until="([^"]+)" refs="([^"]*)"',
  render: (p: OverlapPayload) => ` until="${p.until.toISOString()}" refs="${p.refs.map((r) => `${r.kind}:${r.number}`).join(',')}"`,
  parse: (g) => {
    const until = new Date(g[0] ?? '');
    if (Number.isNaN(until.getTime())) return undefined;
    const refs = (g[1] ?? '').split(',').flatMap((ref) => {
      const parsed = /^(pr|run):(\d+)$/.exec(ref);
      return parsed === null ? [] : [{ kind: parsed[1] as 'pr' | 'run', number: Number(parsed[2]) }];
    });
    return { until, refs };
  },
});
declareMarker({
  kind: 'skills',
  ...names('skills'),
  anchor: 'anywhere',
  // A skill-add PR body is written by whoever opens the PR: the names are validated by the reader instead.
  authors: 'anyone',
  tail: ':[ \\t]([^>]*?)',
  render: (names: readonly string[]) => `: ${names.join(',')}`,
  parse: (g) => (g[0] ?? '').split(',').map((n) => n.trim()),
});

// Block delimiters in PR bodies and AGENTS.md, written inline by their owners (gate-config.ts, conformance-gate.ts,
// skill-registry.ts). Declared so a model-authored text cannot forge one: stripAllMarkers drops them.
for (const [kind, name] of [
  ['gate-config-start', 'vanguard:gate-config:start'],
  ['gate-config-end', 'vanguard:gate-config:end'],
  ['skills-block-start', 'vanguard-skills:start'],
  ['skills-block-end', 'vanguard-skills:end'],
  ['pr-body-items-start', 'vanguard:pr-body-items:start'],
  ['pr-body-items-end', 'vanguard:pr-body-items:end'],
] as const) {
  declareMarker({ kind, current: name, legacy: [], anchor: 'anywhere', authors: 'anyone', tail: '', render: () => '', parse: () => true });
}

// ---------------------------------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------------------------------

export type Forge = 'pr' | 'mr';

/** Whether a trusted author's review marker names this head. */
export const reviewedAtHead = (comments: readonly LedgerComment[], head: string, forge: Forge = 'pr'): boolean =>
  readTrusted<string>(`${forge}-review`, comments).includes(head);

/** Incomplete review attempts recorded for this head, and whether the retry-cap note was posted for it. */
export function incompleteAttempts(comments: readonly LedgerComment[], head: string, forge: Forge = 'pr'): { attempts: number; capPosted: boolean } {
  return {
    attempts: comments.filter((c) => readTrusted<string>(`${forge}-review-incomplete`, [c]).includes(head)).length,
    capPosted: readTrusted<string>(`${forge}-review-incomplete-cap`, comments).includes(head),
  };
}

/** The latest `createdAt` among allowed authors' comments carrying a marker of `kind`. */
export function lastMarkerAt(kind: string, comments: readonly LedgerComment[]): string | undefined {
  return trustedCommentsWith(kind, comments).reduce<string | undefined>((latest, c) => {
    const at = c.createdAt ?? '';
    return latest === undefined || at > latest ? at : latest;
  }, undefined);
}

/** Distinct revision rounds (heads) trusted authors recorded, counting only comments created after `since` when given. Merge-only rounds are not rounds. */
export function revisionRounds(comments: readonly LedgerComment[], since?: string): number {
  const eligible = since === undefined ? comments : comments.filter((c) => (c.createdAt ?? '') > since);
  return new Set(readTrusted<RevisionPayload>('revision', eligible).filter((r) => !r.mergeOnly).map((r) => r.head)).size;
}
