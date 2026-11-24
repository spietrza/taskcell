import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('audit command', () => {
  it('parses verify and export', () => {
    expect(parseCli(['audit', 'verify', '--stream', 'hub'], '/w')).toMatchObject({ kind: 'audit', action: 'verify', stream: 'hub', format: 'jsonl' });
    expect(parseCli(['audit', 'export', '--since', '2026-01-01', '--until', '2026-02-01', '--format', 'csv'], '/w')).toMatchObject({ kind: 'audit', action: 'export', since: '2026-01-01', until: '2026-02-01', format: 'csv' });
  });
  it('rejects a bad subcommand, format or date', () => {
    for (const argv of [['audit'], ['audit', 'verify', '--format', 'xml'], ['audit', 'export', '--since', 'nope']]) {
      expect(parseCli(argv, '/w')).toMatchObject({ kind: 'error' });
    }
  });
});
