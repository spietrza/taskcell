import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { parse } from 'yaml';

// The shared caller templates (docs/onboarding-another-repo.md, enable-factory.ts's `apply` step):
// thin `@v1` callers for implement, pr-review, revise, doctor and resume, living OUTSIDE `.github/`
// so the hub can copy them into a target repo without this repo's own CI config ever being at risk.
const TEMPLATES_DIR = new URL('../../templates/github/', import.meta.url);

const EXPECTED_FILES = ['implement.yml', 'doctor.yml', 'pr-review.yml', 'revise.yml', 'resume.yml'];

const read = async (f: string): Promise<string> => readFile(new URL(f, TEMPLATES_DIR), 'utf8');

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

  it.each(EXPECTED_FILES)('%s parses as YAML, has permissions:, no head-defined pull_request trigger, no ${{ in run:', async (file) => {
    const raw = await readFile(new URL(file, TEMPLATES_DIR), 'utf8');
    const doc = parse(raw) as Record<string, unknown>;

    expect(doc).toBeTypeOf('object');
    expect(doc).not.toBeNull();

    // No plain `pull_request` trigger: it reads the workflow from the PR's head, so a branch could
    // edit the `if:` gate and the `secrets:` block. PR-triggered callers use `pull_request_target`
    // (base-branch definition), as docs/onboarding-another-repo.md prescribes.
    const on = doc.on as Record<string, unknown> | string[] | undefined;
    const triggers = Array.isArray(on) ? on : Object.keys(on ?? {});
    expect(triggers).not.toContain('pull_request');
    // Every `pull_request_target` caller only admits same-repo PRs.
    if (triggers.includes('pull_request_target')) {
      expect(raw).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    }

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
      const doc = parse(await readFile(new URL(file, TEMPLATES_DIR), 'utf8')) as { jobs?: Record<string, { if?: unknown }> };
      const jobs = Object.values(doc.jobs ?? {});
      expect(jobs.length).toBeGreaterThan(0);
      // YOUR_LOGIN is the placeholder enableFactory's apply step replaces with the signed-in gh login;
      // it must sit in each job's parsed `if:` against the actor, not merely somewhere in the text.
      for (const job of jobs) {
        expect(job.if).toBeTypeOf('string');
        expect(job.if as string).toMatch(/(github\.actor|github\.event\.sender\.login) == 'YOUR_LOGIN'/);
      }
    }
  });

  it('admits the optional App bot only as a revise PR author, never as a sender or in allowed-actors', async () => {
    const BOT = 'YOUR_APP_SLUG[bot]';
    for (const file of EXPECTED_FILES) {
      const doc = parse(await readFile(new URL(file, TEMPLATES_DIR), 'utf8')) as {
        jobs?: Record<string, { if?: unknown; with?: Record<string, unknown> }>;
      };
      for (const job of Object.values(doc.jobs ?? {})) {
        expect(String(job.with?.['allowed-actors'] ?? '')).not.toContain(BOT);
        // Every clause that mentions the bot must be the PR-author check.
        for (const clause of String(job.if).split(/&&|\|\|/).filter((c) => c.includes(BOT))) {
          expect(clause).toContain('pull_request.user.login');
          expect(clause).not.toContain('sender.login');
        }
      }
    }
    const revise = parse(await readFile(new URL('revise.yml', TEMPLATES_DIR), 'utf8')) as { jobs: Record<string, { if: string }> };
    expect(revise.jobs.revise?.if).toContain(BOT);
    // No reusable workflow declares the App secret yet, so no caller may map it.
    for (const file of EXPECTED_FILES) {
      expect(await readFile(new URL(file, TEMPLATES_DIR), 'utf8')).not.toContain('TASKCELL_APP_PRIVATE_KEY:');
    }
  });
});
