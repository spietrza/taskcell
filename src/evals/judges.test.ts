import { describe, it, expect } from 'vitest';
import { programmaticJudge, llmJudge } from './judges.js';
import type { EvalCase } from './types.js';

const testCase: EvalCase = { id: 'c1', kind: 'control', input: 'do X' };

describe('programmaticJudge', () => {
  it('turns a true predicate into a passing verdict', async () => {
    const v = await programmaticJudge(() => true).judge({ testCase, output: 'X' });
    expect(v).toEqual({ passed: true, score: 1, reason: 'OK' });
  });

  it('turns a false predicate into a failing verdict', async () => {
    const v = await programmaticJudge(() => false).judge({ testCase, output: 'Y' });
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
  });

  it('passes a full verdict through unchanged', async () => {
    const verdict = { passed: true, score: 0.7, reason: 'partial' };
    const v = await programmaticJudge(() => verdict).judge({ testCase, output: 'Z' });
    expect(v).toEqual(verdict);
  });
});

describe('llmJudge', () => {
  it('parses a Zod-validated verdict from the model output', async () => {
    const complete = async (): Promise<string> => '<verdict>{"passed":true,"score":0.9,"reason":"ok"}</verdict>';
    const v = await llmJudge(complete).judge({ testCase, output: 'result' });
    expect(v).toEqual({ passed: true, score: 0.9, reason: 'ok' });
  });

  it('retries once on an invalid verdict and uses the second reply', async () => {
    const replies = ['<verdict>{"passed":true,"score":1,"reason":"say "hi""}</verdict>', '<verdict>{"passed":true,"score":1,"reason":"ok"}</verdict>'];
    const prompts: string[] = [];
    const complete = async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      return replies.shift() ?? '';
    };
    const v = await llmJudge(complete).judge({ testCase, output: 'result' });
    expect(v).toEqual({ passed: true, score: 1, reason: 'ok' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('not valid JSON');
  });

  it('counts the case as failed when both replies lack a valid verdict, instead of throwing', async () => {
    let calls = 0;
    const complete = async (): Promise<string> => {
      calls += 1;
      return 'no verdict here';
    };
    const v = await llmJudge(complete).judge({ testCase, output: 'result' });
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
    expect(v.reason).toContain('not a valid <verdict>');
    expect(calls).toBe(2);
  });
});
