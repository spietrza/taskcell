// What ⌘K can find besides commands: the cards and runs the Board and Runs last loaded. They publish their own
// lists here, so the palette searches data the app already holds and adds no read of its own.
import type { RepoStamp, RunSummary } from './wire';

export interface PaletteCard {
  id: string;
  title: string;
  repoPath?: string;
}
export type PaletteRun = RunSummary & Partial<RepoStamp>;

let cards: readonly PaletteCard[] = [];
let runs: readonly PaletteRun[] = [];

export const publishCards = (list: readonly PaletteCard[]): void => void (cards = list);
export const publishRuns = (list: readonly PaletteRun[]): void => void (runs = list);
export const paletteItems = (): { cards: readonly PaletteCard[]; runs: readonly PaletteRun[] } => ({ cards, runs });
