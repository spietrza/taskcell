import { expect, test } from 'vitest';
import type { RunEvent } from '../pipeline/events.js';
import { withSandboxStage } from './sandbox-stage.js';

test('run-start lists the sandbox first and stage events shift to match', () => {
  const seen: RunEvent[] = [];
  const emit = withSandboxStage((e) => seen.push(e));
  emit({ type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['implementer', 'reviewer'] });
  emit({ type: 'stage-start', name: 'implementer', index: 0, of: 2 });
  emit({ type: 'stage-end', name: 'implementer', index: 0, of: 2, outcome: 'completed' });
  emit({ type: 'run-end' });
  expect(seen).toEqual([
    { type: 'run-start', taskId: 't', flow: 'f', provider: 'p', stages: ['sandbox', 'implementer', 'reviewer'] },
    { type: 'stage-start', name: 'implementer', index: 1, of: 3 },
    { type: 'stage-end', name: 'implementer', index: 1, of: 3, outcome: 'completed' },
    { type: 'run-end' },
  ]);
});
