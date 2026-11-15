// Static build for taskcell.dev: node build.mjs → dist/. No framework and no dependencies: src/ is the site (English),
// copied as is; i18n/pl.mjs turns its pages and scripts into the Polish copy under dist/pl/; then every local
// reference in the HTML and CSS is checked so a broken link fails the build.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PL } from './i18n/pl.mjs';
import { renderHub } from './hub/render.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const out = join(root, 'dist');

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

// Polish: each file named in i18n/pl.mjs is the English file with its strings swapped, written to dist/pl/<file>.
// A string that is no longer in its file fails the build, so a changed English text cannot silently stay English.
// Longer strings go first, so a short one never cuts into a longer one that contains it.
const byLength = (pairs) => [...pairs].sort((a, b) => b[0].length - a[0].length);
const sharedUnused = new Set(PL['*.html'].map(([en]) => en));
/** Page links and translated scripts point into /pl/; assets and the EN / PL switch (it carries hreflang) stay. */
const intoPolish = (html) =>
  html.replace(/\b(href|src)="\/([^"#?]*)([^"]*)"(?! hreflang)/g, (m, attr, path, rest) => {
    const file = path === '' || path.endsWith('/') ? `${path}index.html` : path;
    return file in PL ? `${attr}="/pl/${path}${rest}"` : m;
  });
for (const [file, pairs] of Object.entries(PL)) {
  if (file === '*.html') continue;
  let text = readFileSync(join(src, file), 'utf8');
  for (const [en, pl] of byLength(pairs)) {
    if (!text.includes(en)) throw new Error(`i18n/pl.mjs: "${en}" is not in src/${file}`);
    text = text.split(en).join(pl);
  }
  if (file.endsWith('.html')) {
    for (const [en, pl] of byLength(PL['*.html'])) {
      if (!text.includes(en)) continue;
      text = text.split(en).join(pl);
      sharedUnused.delete(en);
    }
    text = intoPolish(text);
  }
  const to = join(out, 'pl', file);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, text);
}
if (sharedUnused.size) throw new Error(`i18n/pl.mjs: shared strings found in no page: ${[...sharedUnused].join(' | ')}`);

// The Hub section: the app's own markup and CSS (rendered from apps/desktop), put where each page marks it.
// The markup is English in both languages, as the app is; the page's own words around it are translated.
const hub = await renderHub();
for (const page of ['index.html', 'pl/index.html']) {
  const file = join(out, page);
  const html = readFileSync(file, 'utf8');
  if (!html.includes('<!--hub-app-->')) throw new Error(`${page}: no <!--hub-app--> marker for the Hub section`);
  writeFileSync(file, html.replace('<!--hub-app-->', () => hub.html));
}
writeFileSync(join(out, 'hub-app.css'), hub.css);

/** All files under dir, as paths relative to dist/. */
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative(out, join(dir, e.name))],
  );
const files = walk(out);

// Local references: href/src/srcset in HTML, url() in CSS, import specifiers in JS. Absolute ones start at dist/.
const refs = [];
for (const f of files) {
  const text = /\.(html|css|js)$/.test(f) && !f.includes('three-') ? readFileSync(join(out, f), 'utf8') : '';
  const found = [
    ...[...text.matchAll(/\b(?:href|src)="([^"#?]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\bsrcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0])),
    ...[...text.matchAll(/url\(([^)'"]+)\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/(?:from|import\()\s*'(\.[^']+)'/g)].map((m) => m[1]),
  ];
  for (const r of found) if (!/^[a-z]+:/.test(r)) refs.push({ from: f, ref: r });
}
const missing = refs.filter(({ from, ref }) => !existsSync(ref.startsWith('/') ? join(out, ref) : join(out, dirname(from), ref)));
if (missing.length) {
  for (const m of missing) console.error(`missing: ${m.ref} (in ${m.from})`);
  process.exit(1);
}

// Agent Skills Discovery index (v0.2.0): name and description from each SKILL.md's front matter, digest from its bytes.
const skillsDir = join(out, '.well-known', 'agent-skills');
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map(({ name: dir }) => {
    const body = readFileSync(join(skillsDir, dir, 'SKILL.md'));
    const meta = Object.fromEntries(
      [...body.toString('utf8').matchAll(/^(name|description): (.+)$/gm)].map((m) => [m[1], m[2].trim()]),
    );
    if (meta.name !== dir || !meta.description) throw new Error(`${dir}/SKILL.md: front matter needs name: ${dir} and a description`);
    const digest = createHash('sha256').update(body).digest('hex');
    return { name: dir, type: 'skill-md', description: meta.description, url: `/.well-known/agent-skills/${dir}/SKILL.md`, digest: `sha256:${digest}` };
  });
const index = { $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', skills };
writeFileSync(join(skillsDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

console.log(`dist/ written: ${files.length} files, ${refs.length} local references checked`);
