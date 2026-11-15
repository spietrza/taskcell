import { describe, expect, it } from 'vitest';
import { assertSkillsInstalled, MAX_NAMED_SKILLS, parseSkillsLine, providerSupportsSkills, setSkillsLine, SKILLS_LINE_IGNORED, withNamedSkills } from './named-skills.js';
import { parseCli } from '../cli/args.js';
import { toBoardTask } from '../tasks/board.js';
import { SkillRegistry } from './skill-registry.js';

describe('parseSkillsLine', () => {
  it('reads a Skills: line of comma-separated ids; the last line wins', () => {
    expect(parseSkillsLine('Fix it\n\nSkills: a, b ,a\r\nmore')).toEqual({ skills: ['a', 'b'] });
    expect(parseSkillsLine('Skills: a\nSkills: b')).toEqual({ skills: ['b'] });
  });
  it('is empty without a line', () => {
    expect(parseSkillsLine('no skills here')).toEqual({ skills: [] });
    expect(parseSkillsLine('Skills:')).toEqual({ skills: [] });
  });
  it.each([
    ['prose', 'Skills: good communication, patience'],
    ['space-separated words', 'Skills: a b'],
    ['a path', 'Skills: ../x'],
    ['too many', `Skills: ${Array.from({ length: MAX_NAMED_SKILLS + 1 }, (_, i) => `s${i}`).join(', ')}`],
  ])('ignores %s with a note that echoes nothing from the body', (_n, body) => {
    expect(parseSkillsLine(body)).toEqual({ skills: [], note: SKILLS_LINE_IGNORED });
  });
  it.each([
    ['a code fence', '```\nSkills: a\n```'],
    ['a tilde fence', '~~~md\nSkills: a\n~~~'],
    ['a quote', '> Skills: a'],
    ['an indented or list line', '  Skills: a\n- Skills: a'],
    ['another case', 'skills: a\nSKILLS: a'],
    ['mid-line', 'Required Skills: a'],
  ])('does not read a line in %s', (_n, body) => {
    expect(parseSkillsLine(body)).toEqual({ skills: [] });
  });
});

describe('setSkillsLine', () => {
  it('appends, replaces and removes the line, leaving the rest of the body alone', () => {
    expect(setSkillsLine('Fix it', ['a', 'b'])).toBe('Fix it\n\nSkills: a, b\n');
    expect(setSkillsLine('', ['a'])).toBe('Skills: a\n');
    expect(setSkillsLine('x\nSkills: a\ny', ['b'])).toBe('x\nSkills: b\ny');
    expect(setSkillsLine('x\nSkills: a\ny', [])).toBe('x\ny');
    expect(setSkillsLine('x', [])).toBe('x');
  });
  it('keeps prose and fenced lines, and what it writes is what the run reads', () => {
    const body = 'Skills: good communication\n```\nSkills: z\n```';
    const out = setSkillsLine(body, ['a']);
    expect(out.startsWith(body)).toBe(true);
    expect(parseSkillsLine(out)).toEqual({ skills: ['a'] });
    expect(setSkillsLine('Skills: a\nSkills: b', [])).toBe('');
  });
});

describe('withNamedSkills', () => {
  const stages = [{ name: 'planner', promptTemplate: 'P' }, { name: 'implementer', promptTemplate: 'I' }];
  it('tells the implementer of any flow, and the first stage of a flow without one', () => {
    expect(withNamedSkills(stages, ['a', 'b']).map((s) => s.promptTemplate)).toEqual(['P', expect.stringMatching(/^I\n\n.*MUST load.*: a, b\.$/)]);
    expect(withNamedSkills([{ name: 'generator', promptTemplate: 'G' }], ['a'])[0]?.promptTemplate).toContain('MUST load');
  });
  it('changes nothing without named skills', () => {
    expect(withNamedSkills(stages, [])).toEqual(stages);
  });
});

describe('assertSkillsInstalled', () => {
  it('lists the installed skills for an unknown name', () => {
    expect(() => assertSkillsInstalled(['x'], ['b', 'a'])).toThrow('Unknown skill: x. Installed skills: a, b.');
    expect(() => assertSkillsInstalled(['a'], ['a'])).not.toThrow();
  });
  it('a registry reports its ids', () => {
    expect(new SkillRegistry({ a: '/x' }).ids()).toEqual(['a']);
  });
});

it('pi does not support skills', () => {
  expect(providerSupportsSkills('pi')).toBe(false);
  expect(providerSupportsSkills('codex')).toBe(true);
});

describe('--skill', () => {
  it('is repeatable on run', () => {
    expect(parseCli(['run', '--github', 'o/r#1', '--skill', 'a', '--skill', 'b'], '/w')).toMatchObject({ kind: 'run', namedSkills: ['a', 'b'] });
  });
  it('is refused past the cap and with --parent / --project', () => {
    const many = Array.from({ length: MAX_NAMED_SKILLS + 1 }, (_, i) => ['--skill', `s${i}`]).flat();
    expect(parseCli(['run', '--github', 'o/r#1', ...many], '/w')).toMatchObject({ kind: 'error', message: expect.stringContaining('at most') });
    expect(parseCli(['run', '--linear', 'DEV-1', '--parent', '--skill', 'a'], '/w')).toMatchObject({ kind: 'error', message: expect.stringContaining('single-issue') });
    expect(parseCli(['run', '--project', '7', '--github-repo', 'o/r', '--skill', 'a'], '/w')).toMatchObject({ kind: 'error', message: expect.stringContaining('single-issue') });
  });
  it('is refused on watch and for a bad id', () => {
    expect(parseCli(['watch', '--github', 'o/r', '--skill', 'a'], '/w')).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--github', 'o/r#1', '--skill', '../x'], '/w')).toMatchObject({ kind: 'error' });
  });
});

it('a board card carries the skills its body names', () => {
  const card = toBoardTask('github', { id: 'o/r#1', ref: '1', title: 't', description: 'Skills: a, b', labels: [], children: [], comments: [] });
  expect(card.skills).toEqual(['a', 'b']);
});
