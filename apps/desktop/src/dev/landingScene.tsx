// The Hub section of taskcell.dev, rendered from the app itself. landing/hub/render.mjs loads this module in
// jsdom at landing build time: it opens the real App on the demo project's Board with the running card's
// quick view and returns that markup, plus the stage line and transcript frames the page's animator steps
// through. Nothing here ships in the app; it only reads the components and the demo data. If a component
// or fixture changes so that a hook below no longer finds its element, this throws and the landing build fails.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../App';
import { QuickView } from '../features/board/QuickView';
import { stageLine } from '../features/board/stageLine';
import { StreamView } from '../features/inspector/StreamView';
import { parseAgentStream } from '../features/inspector/parseStream';
import type { BoardTask } from '../wire';
import { demoActiveRuns, demoBoardTasks, demoRunDetails, demoSession } from './demoData';

export interface HubScene {
  /** The app's root element: top bar, rail, Board and the open quick view, hooks for the animator as `data-hub-*`. */
  app: string;
  /** The running card the quick view follows, and the step of its stage line the app shows it at. */
  card: string;
  step: number;
  /** The board's columns, left to right, as the app names them. */
  columns: string[];
  /** The stage line as the quick view draws it, one entry per step of a run: the card waiting, each of the six stages current, all done. */
  stages: { step: string; html: string }[];
}

const REPO = '/demo/storefront';
const hook = (el: Element | null | undefined, name: string, value = ''): void => {
  if (!el) throw new Error(`landing scene: nothing to mark as ${name}; the app's markup changed`);
  el.setAttribute(`data-hub-${name}`, value);
};

/** The stage line for each step, from the real QuickView with the card placed where the factory would have it. */
async function stageFrames(base: BoardTask): Promise<HubScene['stages']> {
  const at: [BoardTask['column'], string | undefined][] = [
    ['queued', undefined],
    ['claimed', undefined],
    ['running', 'implement'],
    ['running', 'verify'],
    ['running', 'review'],
    ['review', undefined],
    ['done', undefined],
  ];
  const out: HubScene['stages'] = [];
  for (const [column, stage] of at) {
    // An open pull request is known from the run list, so that step borrows the demo card that has one (only its stage line is used).
    const from = column === 'review' ? (demoBoardTasks.find((t) => t.column === 'review') ?? base) : base;
    const task: BoardTask = { ...from, column, ...(stage ? { stage } : {}) };
    const { container, unmount } = render(<QuickView task={task} project={REPO} onClose={() => {}} onFullPage={() => {}} />);
    const ol = await waitFor(() => {
      // The pull request address arrives with the run list: wait for the receipt that comes with it.
      if (column === 'review' && !container.querySelector('section[aria-label="Receipt"]')) throw new Error('no receipt yet');
      const el = container.querySelector('ol[aria-label="Stage line"]');
      if (!el) throw new Error('no stage line');
      return el;
    });
    out.push({ step: [...ol.children].map((li) => li.getAttribute('data-status')).join(' '), html: ol.innerHTML });
    unmount();
  }
  return out;
}

/** The transcript lines the app shows for the card: its live session first, then what a finished run's stages say. */
function transcriptEntries(): { stage: number; role: string; text: string }[] {
  const finished = demoRunDetails['DEMO-101']!.stages;
  const stageEntries = (name: string): { role: string; text: string }[] =>
    finished.filter((s) => s.record.stage === name && s.transcript).flatMap((s) => parseAgentStream(s.transcript!));
  return [
    ...demoSession.entries.map((e, i) => ({ stage: i === 0 ? 1 : 2, ...e })),
    ...stageEntries('implement').slice(-1).map((e) => ({ stage: 3, ...e })),
    ...stageEntries('reviewer').map((e) => ({ stage: 4, ...e })),
  ];
}

export async function renderHubScene(): Promise<HubScene> {
  window.__TASKCELL_DEMO__ = true;
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = () => {};

  const card = demoBoardTasks.find((t) => t.id === demoActiveRuns[0]!.taskId)!;
  const stages = await stageFrames(card);
  cleanup();

  const { container } = render(<App />);
  fireEvent.click(await screen.findByText('storefront (demo)', { selector: '*' }));
  // Home first: it mounts Needs you, whose count badges Home in the rail.
  fireEvent.click(await screen.findByRole('button', { name: /^Home/ }));
  await screen.findByRole('heading', { name: 'Projects' });
  await waitFor(() => {
    if (!/\d/.test(screen.getByRole('button', { name: /^Home/ }).textContent ?? '')) throw new Error('no Needs you count yet');
  });
  fireEvent.click(await screen.findByRole('button', { name: /^Board/ }));
  fireEvent.click((await screen.findByText(card.title)).closest('button')!);
  await screen.findByLabelText('Stage line');
  const app = container.firstElementChild as HTMLElement;

  // Hooks for the animator: where the columns, cards, counts, rail entries and the drawer are.
  const main = app.querySelector('main')!;
  const columns = [...main.querySelectorAll('section > div > div')];
  const names = columns.map((col) => {
    const head = col.firstElementChild!;
    hook(col, 'col', head.children[1]!.textContent ?? '');
    hook(head.children[2], 'count');
    hook(col.children[1], 'body');
    return head.children[1]!.textContent ?? '';
  });
  if (names.length !== 6) throw new Error(`landing scene: expected six board columns, found ${names.length}`);
  for (const btn of main.querySelectorAll('[data-board-card]')) {
    const wrap = btn.parentElement!;
    const id = btn.firstElementChild!.querySelector('.font-mono')?.firstChild?.textContent?.trim() ?? '';
    hook(wrap, 'card', id);
    if (id === card.id) hook(wrap, 'open');
  }
  hook(columns[0]?.closest('section')?.parentElement, 'lanes');
  hook(columns.flatMap((c) => [...c.querySelectorAll('div.border-dashed')])[0], 'empty');
  hook([...main.querySelectorAll('span')].find((s) => /^Running \d+ · Waiting \d+$/.test(s.textContent ?? '')), 'counts');
  const rail = app.querySelector('aside')!;
  for (const b of rail.querySelectorAll('nav button')) {
    const n = b.querySelector('span.ml-auto');
    if (n) hook(n, 'badge', b.textContent?.replace(/\d+$/, '').trim() ?? '');
  }
  hook([...rail.querySelectorAll('.caption')].find((c) => c.textContent === 'Running')?.nextElementSibling, 'running');
  const drawer = main.querySelector('aside[aria-label^="Quick view"]')!;
  hook(drawer, 'drawer');
  hook(drawer.querySelector('ol[aria-label="Stage line"]'), 'stages');
  hook(drawer.querySelector('h3'), 'title');

  // The activity feed under the stage line: the app's own stream renderer, one element per entry, shown as the run reaches its stage.
  const step = stageLine(card).findIndex((s) => s.status === 'current');
  hook(drawer, 'step', String(step));
  const feed = document.createElement('section');
  feed.setAttribute('aria-label', 'Transcript');
  feed.className = 'rounded border border-border bg-muted/30 p-4';
  hook(feed, 'feed');
  for (const { stage, ...entry } of transcriptEntries()) {
    const holder = document.createElement('div');
    holder.innerHTML = renderToStaticMarkup(<StreamView entries={[entry]} />);
    const el = holder.firstElementChild!.firstElementChild!;
    hook(el, 'at', String(stage));
    if (stage > step) el.classList.add('hub-gone'); // not yet said at the step the app shows
    feed.append(el);
  }
  drawer.querySelector('ol[aria-label="Stage line"]')!.after(feed);

  const html = app.outerHTML;
  cleanup(); // unmount: the app's poll timers must not keep the build alive
  return { app: html, card: card.id, step, columns: names, stages };
}
