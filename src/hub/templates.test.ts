import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { parse } from 'yaml';

// The shared caller templates (docs/onboarding-another-repo.md, enable-factory.ts's `apply` step):
// thin `@v1` callers for implement, pr-review, revise, doctor and resume, living OUTSIDE `.github/`
// so the hub can copy them into a target repo without this repo's own CI config ever being at risk.
const TEMPLATES_DIR = new URL('../../templates/github/', import.meta.url);

const EXPECTED_FILES = ['implement.yml', 'doctor.yml', 'pr-review.yml', 'revise.yml', 'resume.yml'];

/** Depth-first search for any `run:` step value anywhere in a parsed workflow doc. */
function collectRunValues(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRunValues(item, out);
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'run' && typeof value === 'string') {
        out.push(value);
        continue;
      }
      collectRunValues(value, out);
    }
  }
}

describe('templates/github/ caller templates', () => {
  it('contains exactly the five expected callers', async () => {
    const entries = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.yml'));
    expect(entries.sort()).toEqual([...EXPECTED_FILES].sort());
  });

  it.each(EXPECTED_FILES)('%s parses as YAML, has permissions:, no pull_request_target, no ${{ in run:', async (file) => {
    const raw = await readFile(new URL(file, TEMPLATES_DIR), 'utf8');
    const doc = parse(raw) as Record<string, unknown>;

    expect(doc).toBeTypeOf('object');
    expect(doc).not.toBeNull();

    // no pull_request_target trigger — see pr-review.yml/revise.yml's header comment: a hub-managed
    // caller trades it for plain `pull_request`, which carries none of the base repo's secrets on a
    // fork PR instead of relying on an actor gate alone. (Checked against the parsed trigger keys,
    // not the raw text, since the rationale comments above mention the name by design.)
    const on = doc.on as Record<string, unknown> | string[] | undefined;
    const triggers = Array.isArray(on) ? on : Object.keys(on ?? {});
    expect(triggers).not.toContain('pull_request_target');

    // `permissions:` must be declared — a caller that omits it inherits the repo default, which can
    // be read-only and fails the run deep inside a step rather than at startup.
    expect(doc.permissions).toBeTypeOf('object');
    expect(doc.permissions).not.toBeNull();

    // Inputs never reach a shell as text: every `run:` step must build its command from `env:`-mapped
    // shell variables, never by splicing a `${{ }}` expression directly into the script.
    const runValues: string[] = [];
    collectRunValues(doc, runValues);
    for (const run of runValues) {
      expect(run).not.toContain('${{');
    }
  });

  it('every caller gates workflow_dispatch (and any label event) on an actor, not just the event type', async () => {
    for (const file of EXPECTED_FILES) {
      const raw = await readFile(new URL(file, TEMPLATES_DIR), 'utf8');
      // YOUR_LOGIN is the placeholder enableFactory's apply step replaces with the signed-in gh login.
      expect(raw).toContain('YOUR_LOGIN');
    }
  });
});
