// taskcell.dev page script: entrance reveals, and the factory scene loaded after first paint.
// Phones get the poster and a button; reduced motion gets one still frame; no WebGL keeps the poster.
import { STEPS, hubAnimator } from './hub-data.js';
import { PRICES, YEARLY, localise, money } from './prices.js';
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

// ---------- the scene: palette a (Sodium) of proposal D2, locked; the light theme gets a light floor ----------
const SCENE = {
  fit: 9.8, target: [-1.2, 0.4], transparent: true, grid: true, bloom: true, edgeLabels: true, modules: true,
  monoFont: '"IBM Plex Mono", ui-monospace, monospace',
};
const PALETTES = {
  dark: {
    ground: 0x0d1013, floor: 0x141a1f, body: 0x232b32, bodyLight: 0x2e3841, glass: 0xa9c6c9, card: 0xe6eaed, idle: 0x33404a,
    conduit: 0x1b2228, dark: 0x161b20, sky: 0xc9d6e2, accent: 0xf99a2c, accent2: 0x79a9ad, fail: 0xff4a3d,
  },
  // Ground is --bg and accent2 is --accent-2 of the light theme in site.css; the amber accent stays. Without metalness and
  // with normal blending the lit faces land near the page's own cream, and the teal edges and glows still show on it.
  light: {
    ground: 0xf4f2ed, floor: 0xf2efe8, body: 0xd8dcde, bodyLight: 0xe9ebec, glass: 0x7fa3a7, card: 0xffffff, idle: 0xaab3b8,
    conduit: 0xd6d0c3, dark: 0x6b767e, plate: 0xf4f2ed, sky: 0xffffff, skyGround: 0xb9b2a4, accent: 0xf99a2c, accent2: 0x2c6e73,
    fail: 0xd93a2b, additive: false, metalness: 0,
  },
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
    const floor = createFactoryScene(host.querySelector('.stage'), { ...SCENE, ...PALETTES[root.dataset.theme === 'light' ? 'light' : 'dark'], onLost, ...options });
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
// The theme toggle (or the system, when nothing is stored) repaints the scene: it is built again in the other palette,
// paused if it was paused. Rebuilds run one after another, so a quick double toggle cannot leave two scenes.
let rebuild = Promise.resolve();
new MutationObserver(() => {
  rebuild = rebuild.then(async () => {
    if (!hero) return;
    const was = hero.running;
    hero.destroy();
    hero = null;
    heroHost.querySelector('.pause')?.remove();
    chip.hidden = true;
    await mountHero();
    if (!was && hero?.running) heroHost.querySelector('.pause').click();
  });
}).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

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
    el.querySelector('span').textContent = money(PRICES[el.dataset.plan] * (yearly ? YEARLY : 1));
  }
  // The Worker marks the page when a checkout is open (data-checkout); until then the buttons keep the request page.
  if (root.dataset.checkout) {
    for (const a of document.querySelectorAll('#pricing a[href*="/hosting/?plan="]')) a.dataset.buy = new URL(a.href).searchParams.get('plan');
    for (const a of document.querySelectorAll('#pricing a[data-buy]')) {
      a.href = `/checkout?plan=${a.dataset.buy}&period=${yearly ? 'yearly' : 'monthly'}&lang=${root.lang}${root.dataset.checkout === 'test' ? '&test=1' : ''}`;
    }
  }
  // Yearly złoty prices ("279,20 zł") are too wide for a card at the full size; every card shrinks together.
  const amounts = [...document.querySelectorAll('[data-price] span')];
  amounts[0].closest('.plans').classList.toggle('long', amounts.some((el) => el.textContent.length > 7));
  for (const el of document.querySelectorAll('[data-per]')) el.textContent = yearly ? 'Billed yearly' : 'Billed monthly';
};
billing.addEventListener('change', paintPrices);
paintPrices();
for (const el of document.querySelectorAll('#pricing .pass, .hero small a[href="#pricing"]')) localise(el);

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
  // With CHECKOUT=live (the Worker sets data-checkout) the plan link is its checkout, not the request page.
  const live = root.dataset.checkout === 'live' && r.plan.id;
  byId('r-plan-link').textContent = live ? r.plan.buy : r.plan.action;
  byId('r-plan-link').href = live ? `/checkout?plan=${r.plan.id}&period=monthly&lang=${root.lang}` : r.plan.id ? `/hosting/?plan=${r.plan.id}` : 'https://github.com/spietrza/taskcell/issues';
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
  // "What for" is optional: it does not change the result.
  if (!steps[at].querySelector('input:checked') && !steps[at].querySelector('[name="uses"]')) {
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
const playOnScreen = (host, button, play, labels = ['Play', 'Pause']) => {
  let wanted = !phone && !reduced;
  let playing = false;
  const set = (on) => {
    playing = on;
    button.textContent = on ? labels[1] : labels[0];
    play(on);
  };
  button.hidden = false;
  button.addEventListener('click', () => {
    wanted = !playing;
    set(wanted);
  });
  // Without the observer the preview stays paused, with its Play button.
  if ('IntersectionObserver' in window) new IntersectionObserver((entries) => set(wanted && entries.at(-1).isIntersecting)).observe(host);
  return () => {
    wanted = false;
    set(false);
  };
};

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
      i.style.setProperty('--dx', `${((n * 37) % 5) * -0.14}em`); // only leftwards: a letter pushed past the right edge would widen the page
      i.style.setProperty('--dy', `${(((n * 53) % 7) - 3) * 0.22}em`);
      i.style.setProperty('--r', `${(((n * 29) % 11) - 5) * 5}deg`);
      n += 1;
      span.append(i);
    }
    return span;
  });
  heading.replaceChildren(...words.flatMap((span, i) => (i ? [' ', span] : [span])));
}

// ---------- Hub preview: the app's own Board and card drawer (built from apps/desktop); the card steps through its stages ----------
const hub = hubAnimator(byId('hub-app'));
if (hub) {
  let step = hub.from;
  let timer = 0;
  playOnScreen(byId('hub-app'), byId('hub-pause'), (on) => {
    clearInterval(timer);
    timer = on
      ? setInterval(() => {
          step = (step + 1) % (STEPS + 1); // one beat of rest on the finished card, then it starts over
          hub.paint(Math.min(step, STEPS - 1));
        }, 2200)
      : 0;
  }, ['Play preview', 'Pause preview']);
} else byId('hub-pause').remove();
