/** A skill's `<id>/SKILL.md` under `.vanguard/skills/`: how Codex and Cursor read an injected skill. */
const SKILL_FILE_RE = /^(?:.*\/)?\.vanguard\/skills\/([A-Za-z0-9][\w.-]{0,63})\/SKILL\.md$/;
/** Bounded, printable ids only: the value lands in metrics.jsonl and on a terminal. */
const SKILL_ID_RE = /^[A-Za-z0-9][\w.:-]{0,63}$/;
/** Shell commands that just read a file; anything with a pipe, redirect or substitution is not a read. */
const READERS: ReadonlySet<string> = new Set(['cat', 'sed', 'head', 'tail', 'less', 'bat', 'nl']);

/**
 * Skill ids an agent used in one stage, from its raw transcript. Only structured tool events count,
 * never free text that merely mentions a path: Claude `Skill` tool calls, Cursor `readToolCall`s and
 * Codex `command_execution`s that read `.vanguard/skills/<id>/SKILL.md`. Telemetry only: an unknown
 * or unparseable transcript yields `[]`, never a throw.
 */
export function parseSkillsUsed(transcript: string | undefined): string[] {
  const found = new Set<string>();
  for (const line of (transcript ?? '').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      collect(JSON.parse(line) as unknown, found);
    } catch {
      // not a JSON event line
    }
  }
  return [...found].sort();
}

function codexReadSkill(command: string): string | undefined {
  const cmd = command.replace(/^\S*sh\s+-lc\s+/, '').replace(/^(['"])(.*)\1$/, '$2').trim();
  if (/[|;&<>`$()]/.test(cmd)) return undefined;
  const [bin, ...args] = cmd.split(/\s+/);
  if (bin === undefined || !READERS.has(bin)) return undefined;
  const ids = args.flatMap((a) => SKILL_FILE_RE.exec(a.replace(/^['"]|['"]$/g, ''))?.[1] ?? []);
  return ids.length === 1 ? ids[0] : undefined;
}

function collect(node: unknown, found: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, found);
    return;
  }
  const obj = node as Record<string, unknown>;
  const input = obj.input;
  if (obj.type === 'tool_use' && obj.name === 'Skill' && typeof input === 'object' && input !== null) {
    const id = (input as Record<string, unknown>).skill;
    if (typeof id === 'string' && SKILL_ID_RE.test(id)) found.add(id);
    return;
  }
  if (obj.type === 'command_execution' && typeof obj.command === 'string') {
    const id = codexReadSkill(obj.command);
    if (id !== undefined) found.add(id);
    return;
  }
  const read = obj.readToolCall;
  if (typeof read === 'object' && read !== null) {
    const path = ((read as Record<string, unknown>).args as Record<string, unknown> | undefined)?.path;
    const id = typeof path === 'string' ? SKILL_FILE_RE.exec(path)?.[1] : undefined;
    if (id !== undefined) found.add(id);
    return;
  }
  for (const value of Object.values(obj)) collect(value, found);
}
