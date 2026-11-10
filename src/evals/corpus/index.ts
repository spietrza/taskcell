import { controlCases } from './control.js';
import { edgeCases } from './edge.js';
import { refusalCases } from './refusal.js';
import { corpusHash } from '../corpus-hash.js';
import type { EvalCase } from '../types.js';

export { controlCases, edgeCases, refusalCases };

/**
 * Pinned judge model: fixed cheap Haiku-class, never the model under test.
 * Using the full dated model id (not the alias 'haiku') so a judge-model change is an explicit,
 * reviewable diff rather than a silent float across Haiku releases.
 */
export const JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/** Default model under test (the factory's implementer generation). Override via --produce-model when running vanguard eval. */
export const DEFAULT_PRODUCE_MODEL = 'claude-sonnet-5-5';

/** The full eval corpus: control, edge, and refusal cases. */
export const corpus: EvalCase[] = [...controlCases, ...edgeCases, ...refusalCases];

/** Hash of the committed corpus's content, carried on every EvalRunReport so a baseline comparison can tell a corpus edit from a model/prompt regression. */
export const CORPUS_HASH = corpusHash(corpus);
