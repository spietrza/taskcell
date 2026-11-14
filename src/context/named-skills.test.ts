import { describe, expect, it } from 'vitest';
import { assertSkillsInstalled, parseSkillsLine, providerSupportsSkills } from './named-skills.js';
import { parseCli } from '../cli/args.js';
import { toBoardTask } from '../tasks/board.js';
import { SkillRegistry } from './skill-registry.js';

describe('parseSkillsLine', () => {
  it('reads a Skills: line, splitting on commas and spaces', () => {
    expect(parseSkillsLine('Fix it\n\nSkills: a, b  c,a\nmore')).toEqual(['a', 'b', 'c']);
  });
  it('is empty without a line', () => {
    expect(parseSkillsLine('no skills here')).toEqual([]);
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
  it('is refused on watch and for a bad id', () => {
    expect(parseCli(['watch', '--github', 'o/r', '--skill', 'a'], '/w')).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--github', 'o/r#1', '--skill', '../x'], '/w')).toMatchObject({ kind: 'error' });
  });
});

it('a board card carries the skills its body names', () => {
  const card = toBoardTask('github', { id: 'o/r#1', ref: '1', title: 't', description: 'Skills: a, b', labels: [], children: [], comments: [] });
  expect(card.skills).toEqual(['a', 'b']);
});
