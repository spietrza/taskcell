import { describe, expect, it } from 'vitest';
import { parseSkillsUsed } from './skills-used.js';

const j = (o: object): string => JSON.stringify(o);
const claude = [
  j({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Skill', input: { skill: 'simplify' } }] } }),
  j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
].join('\n');
const codex = j({ type: 'item.completed', item: { type: 'command_execution', command: 'cat .vanguard/skills/code-review/SKILL.md' } });
const codexWrapped = j({ type: 'item.completed', item: { type: 'command_execution', command: `bash -lc "sed -n '1,80p' /workspace/.vanguard/skills/ponytail/SKILL.md"` } });
const cursor = j({ type: 'tool_call', tool_call: { readToolCall: { args: { path: '/workspace/.vanguard/skills/ponytail/SKILL.md' } } } });

describe('parseSkillsUsed', () => {
  it('finds Claude Skill calls', () => expect(parseSkillsUsed(claude)).toEqual(['simplify']));
  it('finds Codex and Cursor skill-file reads', () => {
    expect(parseSkillsUsed(codex)).toEqual(['code-review']);
    expect(parseSkillsUsed(codexWrapped)).toEqual(['ponytail']);
    expect(parseSkillsUsed(cursor)).toEqual(['ponytail']);
  });
  it('returns [] for unknown or garbage input', () => {
    expect(parseSkillsUsed(undefined)).toEqual([]);
    expect(parseSkillsUsed('')).toEqual([]);
    expect(parseSkillsUsed('{"a":1}\n[1,2\nnot json')).toEqual([]);
  });
  it('ignores text that only mentions a skill path', () => {
    const find = j({ type: 'item.completed', item: { type: 'command_execution', command: 'find .vanguard/skills -name SKILL.md', aggregated_output: '.vanguard/skills/a/SKILL.md\n.vanguard/skills/b/SKILL.md' } });
    const result = j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'cat .vanguard/skills/code-review/SKILL.md' }] } });
    const piped = j({ type: 'item.completed', item: { type: 'command_execution', command: 'cat .vanguard/skills/a/SKILL.md | grep x' } });
    expect(parseSkillsUsed([find, result, piped].join('\n'))).toEqual([]);
  });
  it('drops ids that are unbounded or carry control characters', () => {
    const bad = (skill: string): string => j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });
    expect(parseSkillsUsed([bad('x'.repeat(300)), bad('a\u001b[31m\nb'), bad('simplify foo bar')].join('\n'))).toEqual([]);
  });
});
