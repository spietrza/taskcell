// taskcell.dev page script: entrance reveals, and the factory scene loaded after first paint.
// Phones get the poster and a button; reduced motion gets one still frame; no WebGL keeps the poster.
import { evaluate } from './quiz.js';

const root = document.documentElement;
const phone = matchMedia('(max-width: 640px)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- entrance reveals (site.css hides [data-reveal] only while this runs) ----------
root.classList.add('js');
const items = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  items.forEach((el) => io.observe(el));
} else {
  items.forEach((el) => el.classList.add('in'));
}

// ---------- the scene: palette a (Sodium) of proposal D2, locked ----------
const SCENE = {
  fit: 9.8, target: [-1.2, 0.4], transparent: true, grid: true, bloom: true, edgeLabels: true, modules: true,
  monoFont: '"IBM Plex Mono", ui-monospace, monospace',
  ground: 0x0d1013, floor: 0x141a1f, body: 0x232b32, bodyLight: 0x2e3841, glass: 0xa9c6c9, card: 0xe6eaed, idle: 0x33404a,
  conduit: 0x1b2228, dark: 0x161b20, sky: 0xc9d6e2, accent: 0xf99a2c, accent2: 0x79a9ad, fail: 0xff4a3d,
};

let scene = null;
/** The floor captions are drawn into canvases in the mono face, so it must be loaded first. */
const loadScene = async () => {
  scene ??= import('./scene/factory-scene.js');
  await document.fonts.load('500 40px "IBM Plex Mono"').catch(() => null);
  return scene;
};

const afterPaint = (fn) =>
  requestAnimationFrame(() =>
    requestAnimationFrame(() => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 1200 }) : setTimeout(fn, 200))),
  );

function webgl() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** WCAG 2.2.2: motion that runs past five seconds gets a pause control. */
function pauseButton(host, floor) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pause';
  b.textContent = 'Pause';
  b.addEventListener('click', () => {
    const on = floor.running;
    if (on) floor.stop();
    else floor.start();
    b.textContent = on ? 'Play' : 'Pause';
    if (host === heroHost) root.classList.toggle('factory-on', !on);
  });
  host.append(b);
}

/** Builds the scene into a .floor host; `run` animates it, otherwise it renders one still frame. */
async function mount(host, options, run) {
  if (!webgl()) return null;
  try {
    const { createFactoryScene } = await loadScene();
    let lost = false;
    const onLost = () => {
      lost = true;
      host.classList.remove('live');
      host.querySelector('.pause')?.remove();
    };
    const floor = createFactoryScene(host.querySelector('.stage'), { ...SCENE, onLost, ...options });
    if (lost) {
      floor.destroy();
      return null;
    }
    if (run && !reduced) {
      floor.start();
      pauseButton(host, floor);
    } else floor.still();
    requestAnimationFrame(() => !lost && host.classList.add('live'));
    return floor;
  } catch (err) {
    console.warn('factory scene unavailable', err);
    return null;
  }
}

// ---------- hero ----------
const heroHost = document.getElementById('floor-hero');
const chip = document.getElementById('follow');
const chipText = chip.querySelector('span');
let hero = null;
const onFollow = (info) => {
  chip.hidden = !info;
  if (info) chipText.textContent = 'Following ' + info;
};
const mountHero = async () => {
  hero = await mount(heroHost, { mode: 'hero', onFollow }, true);
  // The card in the logo breathes while the hero factory runs (site.css turns it off for reduced motion).
  if (hero && !reduced) root.classList.add('factory-on');
};
chip.querySelector('button').addEventListener('click', () => hero && hero.follow(null));

const play = document.getElementById('play');
if (phone) {
  play.hidden = false;
  play.addEventListener('click', async () => {
    play.disabled = true;
    await mountHero();
    play.hidden = true;
  });
} else {
  afterPaint(mountHero);
}

// ---------- copy buttons on the command blocks (clipboard needs a secure context) ----------
if (navigator.clipboard) {
  for (const pre of document.querySelectorAll('pre.cmd')) {
    const box = document.createElement('div');
    box.className = 'cmd-box';
    pre.replaceWith(box);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy';
    b.textContent = 'Copy';
    b.addEventListener('click', async () => {
      const done = await navigator.clipboard.writeText(pre.textContent.trim()).then(() => true, () => false);
      b.textContent = done ? 'Copied' : 'Failed';
      setTimeout(() => (b.textContent = 'Copy'), 1600);
    });
    box.append(b, pre);
  }
}

// ---------- pricing: the yearly price is computed from the monthly one (20% off), never typed in ----------
const billing = document.getElementById('billing');
billing.hidden = false;
const paintPrices = () => {
  const yearly = billing.querySelector(':checked').value === 'yearly';
  for (const el of document.querySelectorAll('[data-price]')) {
    const n = Number(el.dataset.price) * (yearly ? 0.8 : 1);
    el.querySelector('span').textContent = '€' + (Number.isInteger(n) ? n : n.toFixed(2));
  }
  for (const el of document.querySelectorAll('[data-per]')) el.textContent = yearly ? 'Billed yearly' : 'Billed monthly';
};
billing.addEventListener('change', paintPrices);
paintPrices();

// ---------- readiness quiz: one question per screen; the answers never leave the page ----------
const quiz = document.getElementById('quiz');
const steps = [...quiz.querySelectorAll('fieldset')];
const byId = (id) => document.getElementById(id);
let at = 0;
const showStep = (focus) => {
  steps.forEach((s, i) => (s.hidden = i !== at));
  byId('quiz-result').hidden = true;
  byId('quiz-meter').hidden = false;
  byId('quiz-nav').hidden = false;
  byId('quiz-back').hidden = at === 0;
  byId('quiz-next').textContent = at === steps.length - 1 ? 'Show the result' : 'Next';
  byId('quiz-progress').textContent = `Question ${at + 1} of ${steps.length}`;
  byId('quiz-bar').value = at + 1;
  byId('quiz-error').textContent = '';
  if (focus) (steps[at].querySelector('input:checked') ?? steps[at].querySelector('input')).focus();
};
const fill = (ul, lines) => ul.replaceChildren(...lines.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
const showResult = () => {
  const d = new FormData(quiz);
  const models = d.getAll('models').filter((m) => m !== 'none');
  const r = evaluate({ host: d.get('host'), tests: d.get('tests'), criteria: d.get('criteria'), team: d.get('team'), models, review: d.get('review') });
  byId('r-level').textContent = r.level;
  byId('r-fix-block').hidden = r.fixes.length === 0;
  fill(byId('r-fix'), r.fixes);
  byId('r-plan').textContent = r.plan.name;
  byId('r-plan-note').textContent = r.plan.note;
  byId('r-alt').textContent = r.alt;
  byId('r-alt').hidden = !r.alt;
  byId('r-plan-link').textContent = r.plan.action;
  byId('r-plan-link').href = r.plan.id ? `/hosting.html?plan=${r.plan.id}` : 'https://github.com/spietrza/taskcell/issues';
  byId('r-planned').hidden = !r.plan.id;
  fill(byId('r-promises'), r.promises);
  steps.forEach((s) => (s.hidden = true));
  byId('quiz-meter').hidden = true;
  byId('quiz-nav').hidden = true;
  byId('quiz-error').textContent = '';
  byId('quiz-result').hidden = false;
  byId('quiz-result').focus();
};
quiz.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!steps[at].querySelector('input:checked')) {
    byId('quiz-error').textContent = 'Pick an answer to go on.';
    return;
  }
  if (at === steps.length - 1) return showResult();
  at += 1;
  showStep(true);
});
byId('quiz-back').addEventListener('click', () => {
  at -= 1;
  showStep(true);
});
byId('quiz-reset').addEventListener('click', () => {
  quiz.reset();
  at = 0;
  showStep(true);
});
quiz.addEventListener('change', (e) => {
  byId('quiz-error').textContent = '';
  // "None yet" and the real models exclude each other.
  if (e.target.name !== 'models' || !e.target.checked) return;
  for (const i of quiz.querySelectorAll('input[name="models"]')) if ((i.value === 'none') !== (e.target.value === 'none')) i.checked = false;
});
byId('quiz-nojs').hidden = true;
quiz.hidden = false;
showStep(false);

// ---------- Hub preview: views filter the run list, a row opens that run's own stages, log and cost (sample data) ----------
const STAGES = ['Spec', 'Sealed cell', 'Gates', 'Review', 'Pull request'];
const CLEAN = 'gates: verify passed, secret scan clean';
// done: stages finished; now: what the next stage is doing (left out when nothing runs).
const RUNS = {
  'TC-47': { done: 1, now: 'running', log: ['spec posted on the issue: 4 acceptance criteria', 'cell started: non-root, no repository token', 'agent is editing src/webhooks/retry.ts'] },
  'TC-48': { done: 1, now: 'running', log: ['spec posted on the issue: 3 acceptance criteria', 'cell started: non-root, no repository token', 'agent changed src/invoices/pdf.ts', 'agent is writing src/invoices/pdf.test.ts'] },
  'TC-49': { done: 1, now: 'running', log: ['spec posted on the issue: 2 acceptance criteria', 'creating the git worktree and the cell'] },
  'TC-46': { done: 3, now: 'running', log: ['cell: 6 files changed', CLEAN, 'review (Codex): reading the diff in a fresh context'] },
  'IN-7': { done: 2, now: 'running', log: ['cell: 3 files changed', 'gates: running your verify script'] },
  'TC-50': { done: 0, now: 'for you to read', log: ['planner read the code', 'spec posted on the issue: 5 acceptance criteria', 'the build starts when the reading window ends'] },
  'TC-52': { done: 0, log: ['No run yet. The card is waiting for the factory.'] },
  'TC-53': { done: 0, log: ['No run yet. The card is waiting for the factory.'] },
  'TC-44': { done: 5, log: [CLEAN, 'review (Codex): 1 finding fixed', 'PR #212 opened, ready for review'] },
  'TC-45': { done: 5, log: [CLEAN, 'review (Codex): no findings', 'PR #213 opened, ready for review'] },
  'TC-43': { done: 5, log: ['gates: verify failed, 2 tests red', `repair 1: ${CLEAN.slice(7)}`, 'review (Claude): no findings', 'PR #211 opened, merged by a person'] },
  'TC-42': { done: 5, log: ['cell: built by Codex', CLEAN, 'review (Claude): 2 findings fixed', 'PR #210 opened, merged by a person'] },
  'TC-41': { done: 5, log: [CLEAN, 'review (Codex): 3 findings fixed', 'PR #209 opened, merged by a person'] },
};
const win = document.querySelector('.win');
const views = [...win.querySelectorAll('.views button')];
const runRows = [...win.querySelectorAll('.rows button')];
/** A view shows one board column, one repository, or (All runs) everything. */
const shows = (view, row) => (view.dataset.col ? row.dataset.col === view.dataset.col : !view.dataset.repo || row.dataset.repo === view.dataset.repo);
const pickView = (view) => {
  for (const v of views) v.setAttribute('aria-pressed', v === view);
  for (const row of runRows) row.parentElement.hidden = !shows(view, row);
  byId('win-empty').hidden = runRows.some((row) => shows(view, row));
};
const openRun = (row) => {
  const { run: id, col, repo, cost } = row.dataset;
  const r = RUNS[id];
  for (const other of runRows) other.setAttribute('aria-pressed', other === row);
  byId('run-where').textContent = `${repo} / ${id}`;
  byId('run-col').textContent = col;
  byId('run-title').textContent = row.querySelector('b').textContent;
  byId('run-stages').replaceChildren(
    ...STAGES.map((name, i) => {
      const li = document.createElement('li');
      const status = i < r.done ? 'done' : i === r.done && r.now ? r.now : r.now ? 'waiting' : 'not started';
      li.className = i < r.done ? 'done' : i === r.done && r.now ? 'now' : '';
      li.append(Object.assign(document.createElement('b'), { textContent: name }), Object.assign(document.createElement('span'), { textContent: status }));
      return li;
    }),
  );
  fill(byId('run-log'), r.log);
  byId('run-cost').textContent = cost ? `Cost ${cost}` : col === 'Queued' ? 'No run yet, so no cost.' : 'No cost record yet: the run is still going.';
};
for (const v of views) {
  v.querySelector('em').textContent = runRows.filter((row) => shows(v, row)).length; // counts come from the list itself
  v.addEventListener('click', () => pickView(v));
}
for (const row of runRows) row.addEventListener('click', () => openRun(row));
openRun(runRows[0]);
