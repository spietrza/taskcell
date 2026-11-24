import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const evaluated = vi.hoisted(() => [] as string[]);

vi.mock('./approve.js', () => (evaluated.push('approve'), { approveCommand: vi.fn(async () => undefined) }));
vi.mock('./lessons.js', () => (evaluated.push('lessons'), { lessonsCommand: vi.fn(async () => undefined) }));
vi.mock('./skills.js', () => (evaluated.push('skills'), { skillsCommand: vi.fn(async () => 0) }));
vi.mock('./audit.js', () => (evaluated.push('audit'), { auditCommand: vi.fn(async () => 0) }));
vi.mock('./history.js', () => (evaluated.push('history'), { historyCommand: vi.fn(async () => undefined) }));

describe('taskcell --help', () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    evaluated.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('does not evaluate the approve, lessons, skills, audit and history modules', async () => {
    process.argv = ['node', 'taskcell', '--help'];
    vi.resetModules();
    await import('./index.js');
    await vi.waitFor(() => expect(console.log).toHaveBeenCalled());
    expect(evaluated).toEqual([]);
  });
});
