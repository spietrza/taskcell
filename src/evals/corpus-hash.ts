import { createHash } from 'node:crypto';
import type { EvalCase } from './types.js';

/**
 * Stable hash of the corpus's content (id, kind, input, expectation, variables), order-independent
 * (sorted by id) so reordering the corpus files never looks like a corpus change, but editing any
 * case's text does. Used to detect a corpus change between a baseline and the run comparing against it.
 */
export function corpusHash(cases: EvalCase[]): string {
  const normalized = cases
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      input: c.input,
      expectation: c.expectation ?? '',
      variables: c.variables ?? {},
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}
