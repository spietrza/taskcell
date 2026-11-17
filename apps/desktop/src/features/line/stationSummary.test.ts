import { describe, expect, it } from 'vitest';
import { stationSummary } from './stationSummary';
import { STATIONS } from '../../stations';

describe('stationSummary', () => {
  it('says what an unset value means, for every station', () => {
    expect(stationSummary('card', {})).toEqual(['label ready for agent', 'no task source']);
    expect(stationSummary('spec', {})).toEqual(['source default flow']);
    expect(stationSummary('cell', { taskSource: 'github' })).toEqual(['engine default', 'no budget cap', 'runner GitHub Actions']);
    expect(stationSummary('gates', {})).toEqual(['default verify', 'secret scan']);
    expect(stationSummary('review', {})).toEqual(['same engine']);
    expect(stationSummary('pr', {})).toEqual(['target main']);
  });

  it('shows the saved values', () => {
    expect(stationSummary('card', { taskSource: 'github', label: 'go' })[0]).toBe('label go');
    expect(stationSummary('spec', { flow: 'plan' })).toEqual(['flow plan']);
    expect(stationSummary('cell', { provider: 'codex', budgetUsd: 4 }).slice(0, 2)).toEqual(['engine codex', 'budget $4']);
    expect(stationSummary('gates', { verifyCmd: 'pnpm verify' })[0]).toBe('pnpm verify');
    expect(stationSummary('review', { reviewProvider: 'codex' })).toEqual(['engine codex']);
    expect(stationSummary('pr', { baseBranch: 'dev' })).toEqual(['target dev']);
    expect(STATIONS.every((s) => stationSummary(s, {}).length > 0)).toBe(true);
  });
});
