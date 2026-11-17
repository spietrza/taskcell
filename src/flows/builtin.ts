import type { PipelineStage } from '../pipeline/pipeline.js';
import { toDecl } from './emit.js';
import { STAGE_LIBRARY } from './library.js';
import type { FlowDoc } from './types.js';

/**
 * A built-in flow's stages as an editable FlowDoc, or undefined when that cannot be done faithfully: a stage with a field
 * HCL cannot carry (`toDecl` throws), a name the library does not know, or prompts that differ from the library record's
 * (a copy would silently run different prompts). The copy therefore always lowers back to the same pipeline.
 */
export function flowDocFromStages(name: string, label: string, stages: PipelineStage[]): FlowDoc | undefined {
  try {
    const decls = stages.map((stage) => {
      const base = STAGE_LIBRARY[stage.name];
      if (base === undefined || base.promptTemplate !== stage.promptTemplate || base.systemPrompt !== stage.systemPrompt) {
        throw new Error(`stage "${stage.name}" differs from the library`);
      }
      return toDecl(stage);
    });
    return { name, label, stages: decls, loops: [] };
  } catch {
    return undefined;
  }
}
