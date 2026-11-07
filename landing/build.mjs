// Static build for taskcell.dev: node build.mjs → dist/. No framework and no dependencies: src/ is the site,
// copied as is, then every local reference in the HTML and CSS is checked so a broken link fails the build.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const out = join(root, 'dist');

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

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
