// The Hub preview's animator. The markup is the app's own (built from apps/desktop at build time, see hub/render.mjs);
// this only moves it: the open card steps through the stage line the app draws, crosses the board's columns, and the
// counts follow. Every name and number comes from the markup, so nothing here can drift from the app.

/** Column the card stands in at each step: Queued, Claimed, Running (three steps), Review (two). */
export const COLUMN_AT = [0, 1, 2, 2, 2, 4, 4];
export const STEPS = COLUMN_AT.length;
/** The stage the card's "stage:" line names while it runs (Running's three steps), and the tracker state its last line shows at each step. */
const STAGE_AT = { 2: 'implement', 3: 'verify', 4: 'review' };
const STATE_AT = ['Ready for agent', 'Claimed', 'In Progress', 'In Progress', 'In Progress', 'In Review', 'In Review'];
/** The step its pull request is open: Home's Needs you count goes up by one. */
const PR_STEP = 5;
/** The Runs badge counts finished runs and the one in flight: not yet while the card is queued or claimed. */
const IN_FLIGHT_STEP = 2;

const gone = (el, hide) => el?.classList.toggle('hub-gone', hide);

/** Sets up the animator on the section; returns paint(step) and the steps' count. Null when the markup is not there. */
export function hubAnimator(root) {
  const q = (name, scope = root) => scope.querySelector(`[data-hub-${name}]`);
  const drawer = q('drawer');
  const list = q('stages');
  const cols = [...root.querySelectorAll('[data-hub-col]')];
  const mine = q('open');
  if (!drawer || !list || cols.length < 5 || !mine) return null;
  const stageLine = q('stage', mine);
  const stateLine = q('state', mine);
  const empty = q('empty');
  const emptyHtml = empty?.cloneNode(true);
  const header = q('counts');
  const feed = [...root.querySelectorAll('[data-hub-at]')];
  const frames = [...root.querySelectorAll('template[data-hub-step]')].map((t) => t.innerHTML);
  const badges = Object.fromEntries([...root.querySelectorAll('[data-hub-badge]')].map((b) => [b.dataset.hubBadge, b]));
  const running = q('running');
  const runBase = Number(badges.Runs?.textContent ?? 0);
  const needBase = Number(badges.Home?.textContent ?? 0);
  const from = Number(drawer.dataset.hubStep);
  const waiting = header ? Number(/Waiting (\d+)/.exec(header.textContent)?.[1] ?? 0) : 0;

  const paint = (step) => {
    list.innerHTML = frames[step];
    const target = cols[COLUMN_AT[step]];
    const body = q('body', target);
    if (!body.contains(mine)) body.prepend(mine);
    if (stageLine) stageLine.textContent = `stage: ${STAGE_AT[step] ?? ''}`;
    gone(stageLine, !STAGE_AT[step]);
    if (stateLine) stateLine.textContent = STATE_AT[step];
    for (const col of cols) {
      const b = q('body', col);
      const n = b.querySelectorAll('[data-hub-card]').length;
      const hole = b.querySelector('[data-hub-empty]');
      if (n === 0 && !hole && emptyHtml) b.append(emptyHtml.cloneNode(true));
      if (n > 0 && hole) hole.remove();
      q('count', col).textContent = String(n);
    }
    if (header) {
      const taken = [1, 2].reduce((sum, i) => sum + q('body', cols[i]).querySelectorAll('[data-hub-card]').length, 0);
      header.textContent = `Running ${taken} · Waiting ${waiting}`;
    }
    for (const f of feed) gone(f, Number(f.dataset.hubAt) > step);
    gone(q('feed'), !feed.some((f) => Number(f.dataset.hubAt) <= step));
    gone(running?.firstElementChild, !(step >= IN_FLIGHT_STEP && step < PR_STEP));
    if (badges.Runs) badges.Runs.textContent = String(step < IN_FLIGHT_STEP ? runBase - 1 : runBase);
    if (badges.Home) badges.Home.textContent = String(step >= PR_STEP ? needBase + 1 : needBase);
  };
  return { paint, from };
}
