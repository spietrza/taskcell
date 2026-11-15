// taskcell.dev page script: entrance reveals, and the factory scene loaded after first paint.
// Phones get the poster and a button; reduced motion gets one still frame; no WebGL keeps the poster.
import { STAGES, advance, clock, column, cost, elapsed, log, sample, share } from './hub-data.js';
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

/** Sets an element's text only when it changes, so live regions are not announced again on every repaint. */
const text = (el, t) => {
  if (el.textContent !== t) el.textContent = t;
};
/** Plays a preview while it is on screen and the visitor has not paused it. Phones and reduced motion start paused. */
const playOnScreen = (host, button, play) => {
  let wanted = !phone && !reduced;
  let playing = false;
  const set = (on) => {
    playing = on;
    button.textContent = on ? 'Pause' : 'Play';
    play(on);
  };
  button.hidden = false;
  button.addEventListener('click', () => {
    wanted = !playing;
    set(wanted);
  });
  new IntersectionObserver(([e]) => set(wanted && e.isIntersecting)).observe(host);
  return () => {
    wanted = false;
    set(false);
  };
};

// ---------- theme: theme.js set it before first paint; the button flips and stores it ----------
const themeButton = byId('theme');
const paintTheme = () => themeButton.setAttribute('aria-pressed', root.dataset.theme === 'light');
themeButton.hidden = false;
themeButton.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  try {
    localStorage.setItem('theme', root.dataset.theme);
  } catch {
    // storage is blocked: the choice lasts for this page
  }
  paintTheme();
});
paintTheme();

// ---------- how it works: five steps as tabs; the sample run beside them fills in up to the open step ----------
const flow = byId('flow');
const tabs = [...flow.querySelectorAll('[role="tab"]')];
const openStep = (n) => {
  tabs.forEach((tab, i) => {
    tab.setAttribute('aria-selected', i === n);
    tab.tabIndex = i === n ? 0 : -1;
    tab.classList.toggle('past', i < n);
    byId(tab.getAttribute('aria-controls')).hidden = i !== n;
  });
  for (const part of flow.querySelectorAll('[data-at]')) part.classList.toggle('lit', Number(part.dataset.at) <= n + 1);
};
// Under reduced motion the track never plays: its timing is a CSS animation, which that setting cuts to nothing.
const stopFlow = reduced ? () => {} : playOnScreen(flow, byId('flow-pause'), (on) => flow.classList.toggle('playing', on));
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => {
    stopFlow();
    openStep(i);
  });
  tab.addEventListener('keydown', (e) => {
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    next.click();
    next.focus();
  });
});
// The open step's line has filled: the next step opens, and the first after the last.
flow.addEventListener('animationend', (e) => {
  if (e.animationName === 'flow-fill') openStep((tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true') + 1) % tabs.length);
});
openStep(0);

// ---------- the keys headline assembles from its letters; the heading keeps its text as its label ----------
for (const heading of document.querySelectorAll('[data-letters]')) {
  heading.setAttribute('aria-label', heading.textContent);
  let n = 0;
  const words = heading.textContent.split(' ').map((word) => {
    const span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    for (const letter of word) {
      const i = Object.assign(document.createElement('i'), { textContent: letter });
      i.style.setProperty('--n', n);
      i.style.setProperty('--dx', `${(((n * 37) % 9) - 4) * 0.14}em`);
      i.style.setProperty('--dy', `${(((n * 53) % 7) - 3) * 0.22}em`);
      i.style.setProperty('--r', `${(((n * 29) % 11) - 5) * 5}deg`);
      n += 1;
      span.append(i);
    }
    return span;
  });
  heading.replaceChildren(...words.flatMap((span, i) => (i ? [' ', span] : [span])));
}

// ---------- Hub preview: views filter the run list, a row opens that run's own stages, log and cost (sample data) ----------
const win = document.querySelector('.win');
const views = [...win.querySelectorAll('.views button')];
const runRows = [...win.querySelectorAll('.rows button')];
let runs = sample();
let view = views[0];
let openRow = runRows[0];
const runOf = (row) => runs.find((r) => r.id === row.dataset.run);
/** A view shows one board column, one repository, or (All runs) everything. */
const shows = (v, row) => (v.dataset.col ? row.dataset.col === v.dataset.col : !v.dataset.repo || row.dataset.repo === v.dataset.repo);

const paintOpen = () => {
  const { run: id, col, repo, cost: spent } = openRow.dataset;
  const r = runOf(openRow);
  const total = STAGES.reduce((sum, _, i) => sum + elapsed(r, i), 0);
  text(byId('run-where'), total ? `${repo} / ${id} · ${clock(total)}` : `${repo} / ${id}`);
  text(byId('run-col'), col);
  text(byId('run-title'), openRow.querySelector('b').textContent);
  byId('run-stages').replaceChildren(
    ...STAGES.map((name, i) => {
      const li = document.createElement('li');
      const done = share(r, i) === 1;
      const now = !done && r.p >= i;
      const status = done || (now && !r.hold) ? clock(elapsed(r, i)) : now ? 'for you to read' : r.p < 0 ? 'not started' : 'waiting';
      li.className = done ? 'done' : now ? 'now' : '';
      li.append(Object.assign(document.createElement('b'), { textContent: name }), Object.assign(document.createElement('span'), { textContent: status }));
      if (now && !r.hold) {
        const bar = document.createElement('i');
        bar.style.width = `${share(r, i) * 100}%`;
        li.append(bar);
      }
      return li;
    }),
  );
  fill(byId('run-log'), log(r));
  text(byId('run-cost'), spent ? `Cost ${spent}` : col === 'Queued' ? 'No run yet, so no cost.' : 'No cost record yet: the run is still going.');
};
/** Brings the rows, the counts and the open run in line with the sample's current state. */
const paintHub = () => {
  for (const row of runRows) {
    const r = runOf(row);
    const col = column(r);
    if (row.dataset.col === col) continue;
    row.dataset.col = col;
    row.querySelector('.st').textContent = col;
    row.querySelector('.cost').textContent = cost(r).split(' ')[0];
    if (cost(r)) row.dataset.cost = cost(r);
    else delete row.dataset.cost;
  }
  for (const v of views) text(v.querySelector('em'), String(runRows.filter((row) => shows(v, row)).length)); // counts come from the list itself
  for (const row of runRows) {
    const hide = !shows(view, row);
    if (hide && row === document.activeElement) view.focus(); // a run that left the view takes the focus with it otherwise
    row.parentElement.hidden = hide;
  }
  byId('win-empty').hidden = runRows.some((row) => shows(view, row));
  paintOpen();
};
for (const v of views) {
  v.addEventListener('click', () => {
    view = v;
    for (const other of views) other.setAttribute('aria-pressed', other === v);
    paintHub();
  });
}
for (const row of runRows) {
  row.addEventListener('click', () => {
    openRow = row;
    for (const other of runRows) other.setAttribute('aria-pressed', other === row);
    paintOpen();
  });
}
paintHub();

// Playback: four steps a second; the finished sample is held for four seconds, then starts over as written.
let timer = 0;
let rest = 0;
const tick = () => {
  if (rest > 0) {
    rest -= 1;
    if (rest === 0) runs = sample();
  } else if (!advance(runs, 0.25)) rest = 16;
  paintHub();
};
playOnScreen(win, byId('hub-pause'), (on) => {
  clearInterval(timer);
  timer = on ? setInterval(tick, 250) : 0;
});
