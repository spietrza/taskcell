import { describe, it, assert } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli doctor-mrs', () => {
  it('parses doctor-mrs with required flags', () => {
    const cmd = parseCli(['doctor-mrs', '--gitlab-project', 'g/p', '--label', 'ready for review'], '/repo');
    assert(cmd.kind === 'doctor-mrs');
  });
});
