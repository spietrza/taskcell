import { describe, expect, it } from 'vitest';
import { builtinFlowDoc, capabilities } from '../api/capabilities.js';
import { emitFlowDoc } from './emit-doc.js';
import { parseFlowHcl } from './parse.js';

describe('builtinFlowDoc', () => {
  it('returns an editable doc for flow-b that round-trips through HCL', async () => {
    const doc = builtinFlowDoc('flow-b');
    expect(doc?.stages.map((s) => s.name)).toEqual(['planner', 'implementer', 'adversary', 'repairer']);
    expect(await parseFlowHcl(emitFlowDoc(doc!))).toEqual(doc);
  });

  it('refuses a built-in it cannot copy faithfully, and an unknown name', () => {
    expect(builtinFlowDoc('default')).toBeUndefined();
    expect(builtinFlowDoc('nope')).toBeUndefined();
  });

  it('capabilities lists every built-in with its stages and the doc only where it exists', () => {
    const flows = capabilities().flows;
    expect(flows.map((f) => f.name)).toEqual(['default', 'plan', 'flow-b']);
    expect(flows.every((f) => (f.stages?.length ?? 0) > 0)).toBe(true);
    expect(flows.filter((f) => f.doc !== undefined).map((f) => f.name)).toEqual(['flow-b']);
  });
});
