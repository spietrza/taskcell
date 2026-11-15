/** A skill's `<id>/SKILL.md` under `.vanguard/skills/`: how Codex and Cursor read an injected skill. */
const SKILL_FILE_RE = /^(?:.*\/)?\.vanguard\/skills\/([A-Za-z0-9][\w.:-]{0,63})\/SKILL\.md$/;
/** Bounded, printable ids only: the value lands in metrics.jsonl and on a terminal. */
const SKILL_ID_RE = /^[A-Za-z0-9][\w.:-]{0,63}$/;
/** A transcript or metric record cannot expand into an unbounded list. */
export const MAX_SKILLS_USED = 64;
/** Shell commands that read a file. */
const READERS: ReadonlySet<string> = new Set(['cat', 'sed', 'head', 'tail', 'less', 'bat', 'nl']);

/** Validate, de-duplicate and cap skill ids, optionally intersecting them with the run's registry. */
export function sanitizeSkillIds(ids: readonly unknown[], allowedIds?: readonly string[]): string[] {
  const allowed = allowedIds === undefined ? undefined : new Set(allowedIds.filter((id) => SKILL_ID_RE.test(id)));
  const valid = ids.filter((id): id is string => typeof id === 'string' && SKILL_ID_RE.test(id) && (allowed === undefined || allowed.has(id)));
  return [...new Set(valid)].sort().slice(0, MAX_SKILLS_USED);
}

/**
 * Skill ids an agent used in one stage, from its raw transcript. Only known structured tool events
 * count, never free text or tool results that merely mention a path: Claude `Skill` tool calls,
 * Cursor `readToolCall`s and Codex `command_execution`s that read
 * `.vanguard/skills/<id>/SKILL.md`. Telemetry only: an unknown or unparseable transcript yields
 * `[]`, never a throw.
 */
export function parseSkillsUsed(transcript: string | undefined, allowedIds?: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of (transcript ?? '').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      collectEvent(JSON.parse(line) as unknown, found);
    } catch {
      // not a JSON event line
    }
  }
  return sanitizeSkillIds(found, allowedIds);
}

function stripShellWrapper(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|da|z)?sh\s+-lc\s+([\s\S]+)$/.exec(command.trim())?.[1];
  const cmd = wrapped ?? command.trim();
  const quote = cmd[0];
  return quote !== undefined && (quote === '"' || quote === "'") && cmd.at(-1) === quote ? cmd.slice(1, -1) : cmd;
}

function codexReadSkills(command: string): string[] {
  const cmd = stripShellWrapper(command);
  if (/[<>`$()]/.test(cmd)) return [];
  const ids: string[] = [];
  for (const part of cmd.split(/&&|\|\||[;|]/)) {
    const [rawBin, ...args] = part.trim().split(/\s+/);
    const bin = rawBin?.split('/').at(-1);
    if (bin === undefined || !READERS.has(bin)) continue;
    for (const arg of args) {
      const id = SKILL_FILE_RE.exec(arg.replace(/^["']|["']$/g, ''))?.[1];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

function collectEvent(node: unknown, found: string[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const event = node as Record<string, unknown>;

  if (event.type === 'assistant') {
    const message = event.message;
    const content = typeof message === 'object' && message !== null ? (message as Record<string, unknown>).content : undefined;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const tool = item as Record<string, unknown>;
      const input = tool.input;
      if (tool.type !== 'tool_use' || tool.name !== 'Skill' || input === null || typeof input !== 'object' || Array.isArray(input)) continue;
      const id = (input as Record<string, unknown>).skill;
      if (typeof id === 'string') found.push(id);
    }
    return;
  }

  if (event.type === 'item.completed') {
    const item = event.item;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return;
    const command = item as Record<string, unknown>;
    if (command.type === 'command_execution' && typeof command.command === 'string') found.push(...codexReadSkills(command.command));
    return;
  }

  if (event.type === 'tool_call') {
    const toolCall = event.tool_call;
    if (toolCall === null || typeof toolCall !== 'object' || Array.isArray(toolCall)) return;
    const read = (toolCall as Record<string, unknown>).readToolCall;
    if (read === null || typeof read !== 'object' || Array.isArray(read)) return;
    const args = (read as Record<string, unknown>).args;
    const path = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>).path : undefined;
    const id = typeof path === 'string' ? SKILL_FILE_RE.exec(path)?.[1] : undefined;
    if (id !== undefined) found.push(id);
  }
}
