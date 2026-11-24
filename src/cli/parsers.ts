/**
 * Each command's parse step (flags -> its own command shape), by command word. Imports only the
 * `*.parse.ts` modules, never a runner, so the parser (and the hub's local worker that uses it) stays
 * off the runner graph; the runners are in registry.ts, which only the CLI entry imports.
 */
import type { Command } from './args.js';
import type { CommandName } from './commands.js';
import type { ParseCtx } from './flags.js';
import { parseStatsCommand } from './stats.parse.js';
import { parseApproveCommand } from './approve.parse.js';
import { parseMetricsCommand } from './metrics.parse.js';
import { parseLessonsCommand } from './lessons.parse.js';
import { parseSkillsCommand } from './skills.parse.js';
import { parseAuditCommand } from './audit.parse.js';
import { parseHistoryCommand } from './history.parse.js';
import { parseMemoryCommand } from './memory.parse.js';
import { parseEvalCommand } from './eval.parse.js';
import { parseMigrateLabelsCommand } from './migrate-labels.parse.js';
import { parseResumeRateLimitedCommand } from './resume-rate-limited.parse.js';
import { parseGcCommand } from './gc.parse.js';
import { parseHubCommand } from './hub.parse.js';
import { parseReviewPrCommand } from './review-pr.parse.js';
import { parseResearchCommand } from './research.parse.js';
import { parseSpecCommand } from './spec.parse.js';
import { parseRevisePrCommand } from './revise-pr.parse.js';
import { parseWatchPrsCommand } from './watch-prs.parse.js';
import { parseDoctorPrsCommand } from './doctor-prs.parse.js';
import { parseReviewMrCommand } from './review-mr.parse.js';
import { parseWatchMrsCommand } from './watch-mrs.parse.js';
import { parseRunCommand } from './run.parse.js';
import { parseWatchCommand } from './watch.parse.js';

export interface Parser {
  /** False for commands that never pick a provider: they skip the provider-pair validation. */
  providerChoice: boolean;
  parse(ctx: ParseCtx): Command;
}

const parser = (providerChoice: boolean, parse: (ctx: ParseCtx) => Command): Parser => ({ providerChoice, parse });

/** By command word: a command declared in commands.ts without a parser here is a type error. */
export const PARSERS: Record<CommandName, Parser> = {
  stats: parser(false, parseStatsCommand),
  approve: parser(false, parseApproveCommand),
  metrics: parser(false, parseMetricsCommand),
  lessons: parser(false, parseLessonsCommand),
  skills: parser(false, parseSkillsCommand),
  audit: parser(false, parseAuditCommand),
  history: parser(false, parseHistoryCommand),
  memory: parser(false, parseMemoryCommand),
  eval: parser(false, parseEvalCommand),
  'migrate-labels': parser(false, parseMigrateLabelsCommand),
  'resume-rate-limited': parser(false, parseResumeRateLimitedCommand),
  gc: parser(false, parseGcCommand),
  hub: parser(false, parseHubCommand),
  'review-pr': parser(true, parseReviewPrCommand),
  research: parser(true, parseResearchCommand),
  spec: parser(true, parseSpecCommand),
  'revise-pr': parser(true, parseRevisePrCommand),
  'watch-prs': parser(true, parseWatchPrsCommand),
  'doctor-prs': parser(true, parseDoctorPrsCommand),
  'review-mr': parser(true, parseReviewMrCommand),
  'watch-mrs': parser(true, parseWatchMrsCommand),
  'doctor-mrs': parser(true, parseWatchMrsCommand),
  run: parser(true, parseRunCommand),
  watch: parser(true, parseWatchCommand),
  doctor: parser(true, parseWatchCommand),
};

const isCommandName = (name: string): name is CommandName => Object.hasOwn(PARSERS, name);

/** The parser for a command word, or undefined for a word that is not a declared command. */
export function parserFor(name: string): Parser | undefined {
  return isCommandName(name) ? PARSERS[name] : undefined;
}
