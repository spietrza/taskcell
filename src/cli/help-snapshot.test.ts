import { describe, it, expect } from 'vitest';
import { USAGE } from './args.js';
import { COMMANDS, commandUsage } from './commands.js';
import { PARSERS } from './registry.js';

describe('--help output', () => {
  it('top-level usage is unchanged', () => {
    expect(USAGE).toMatchSnapshot();
  });

  it.each(COMMANDS.map((c) => [c.name, c] as const))('%s help is unchanged', (_name, decl) => {
    expect(commandUsage(decl)).toMatchSnapshot();
  });

  it('every declared command has a parser', () => {
    expect(COMMANDS.filter((c) => PARSERS[c.name] === undefined).map((c) => c.name)).toEqual([]);
  });
});
