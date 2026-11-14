# Skills

Taskcell supports Claude Code skills (the `SKILL.md`-per-directory format used by collections like [obra/superpowers](https://github.com/obra/superpowers), [mattpocock/skills](https://github.com/mattpocock/skills), and [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit/skills)). Point a registry at a directory of skills and Taskcell injects the whole set into the agent's `~/.claude/skills` inside the sandbox. The agent auto-discovers and selects the relevant ones at runtime, so there is no per-run list to maintain.

```ts
import { skillRegistryFromDirectory, run } from 'vanguard';

// Clone a skills collection into ./skills (each subdir with a SKILL.md is one skill).
const skills = await skillRegistryFromDirectory('./skills');
await run(opts, { skills });
```

For targeted injection instead of the whole set, construct `new SkillRegistry({ id: '/host/path' })` and call `inject(['id'], sandbox)`.

The repo bundles five skills in `skills/`: `code-review` and `simplify` (used by the loop's review pass), `tech-spec` (specs for under-specified tasks), `caveman` (cut tokens on long runs), and `ponytail` (avoid over-engineering: climb the laziness ladder, stop at the first rung that works). `tech-spec` reaches only the spec pass: the CLI's and the factory's implement, revise and review runs never load it, because it forbids editing source files. An SDK caller that points `skillRegistryFromDirectory` at the bundled dir loads it too and should drop it from non-spec runs itself.

## Custom skills (bring your own)

A skill is a directory with a `SKILL.md` (frontmatter `name` + `description`, then the body), the standard Claude Code format. `--skills <dir>` injects every subdirectory in that dir, and the agent picks the right one per task by matching each skill's `description`. A migration task pulls in `db-migrations`, a release task `release`, and `ponytail` fires on everything. You curate the set, the model chooses per task. There is no per-issue flag.

Keep your domain skills in the target repo under `.github/vanguard-skills/`:

```
.github/vanguard-skills/
  db-migrations/SKILL.md
  release/SKILL.md
```

That is the whole setup. Taskcell injects every skill in the `--skills` dir plus every skill in the target repo's `.github/vanguard-skills/` into `run` and `watch` on every source (GitHub, GitLab, Projects, Linear), the spec pass (`spec`, and `watch` loop-v1), `revise-pr`, and the reviewers (`review-pr`, `watch-prs`, `review-mr`, `watch-mrs`). `research` runs without skills. Reviewers take repo skills from the PR's base branch, so a PR cannot change the skills of its own review. The implement workflow passes the bundled `skills/`, so the agent keeps `ponytail`/`code-review`/`simplify` and gains yours. A thin `uses: spietrza/taskcell/.github/workflows/implement.yml@v1` caller needs no extra step or input. Leave the workflow's `skills` input at its default: pointing it at `.github/vanguard-skills` would drop the bundled skills the review and simplify stages use.

A repo skill with the same directory name as a bundled one replaces it, so a repo can ship its own `code-review`; the run log names every skill replaced this way. Skill directories that are symlinks are skipped, and so are `SKILL.md` files that are symlinks, with a warning in the run log. A `.github/vanguard-skills` that is not a directory, or that resolves outside the repo, fails the run.

Skills are injected per-provider in the format each CLI auto-discovers:

| Provider | Target | Format |
|---|---|---|
| `claude-code`, `zai`, `openrouter`, `meridian`, custom endpoints | `~/.claude/skills/<id>/` | Full skill directory |
| `codex` | `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md` by default) | Pointer index: name + description + path to `.vanguard/skills/<id>/SKILL.md` |
| `cursor` | `.cursor/rules/<id>.mdc` | One `.mdc` per skill with `description`/`globs` frontmatter + pointer |

Codex receives only a pointer index (not the full skill bodies) in its always-on `AGENTS.md` to avoid inflating every turn with N full skill texts; the model reads the body from `.vanguard/skills/<id>/SKILL.md` when the description matches the task. Cursor rules use `alwaysApply: false` so they are description-attached, not always-on, for the same reason. Neither `.cursor/rules/` nor `.vanguard/skills/` is copied back into the PR diff.

**Cross-provider runs:** skills are injected for every CLI family that may run in the sandbox: the implementer (`--provider`), the reviewer (`--review-provider`) and the implementer fallback (`--fallback-provider`). With `--provider claude --review-provider codex`, the Claude stages get `~/.claude/skills/` and the Codex reviewer gets the `AGENTS.md` pointer index.

Two checks before a skill goes in. It must be self-contained: `SKILL.md` plus plain text, no MCP or browser, since the sandbox has neither. It must allow model invocation: skip any with `disable-model-invocation: true`, because the agent never triggers those itself. Only the `description`s load up front, so curate about a dozen, not a whole collection.

## When a skill is worth adding

A skill is worth adding when it carries knowledge the model lacks: how to drive an unfamiliar CLI (the linear-cli skill below), a repo-specific procedure such as writing a migration or cutting a release, or long instructions that only some tasks need.

Generic expert skills such as `docker-expert` or `python-expert` add little, because the model already knows Docker and Python. Put your stack rules and conventions in the target repo's `CLAUDE.md` (Codex reads `AGENTS.md`), which the agent CLI loads on every stage.

An instruction that a stage must follow on every run belongs in the stage prompt, since the model decides whether to open a skill. Taskcell's review prompt says "If a code-review skill is available, use it.", and the simplify prompt says the same for `simplify`. Both prompts also state their core instructions directly, so a stage that skips the skill still follows them. The skills add the detailed checks, and `code-review` adds the severity rules for blocking a merge.

To see which skills a run used, search its transcripts in `.taskcell/runs/<taskId>/`. A Claude-family stage logs each Skill tool call as `"skill":"<id>"`. Codex and Cursor read the body from `.vanguard/skills/<id>/SKILL.md`, so search for that path instead.

## Example: the linear-cli skill

[schpet/linear-cli](https://github.com/schpet/linear-cli) ships a skill at `skills/linear-cli/` that teaches the agent to drive the `linear` CLI directly. The sandbox image already includes the `linear` CLI, so you only inject the skill and forward `LINEAR_API_KEY`:

```bash
git clone --depth 1 https://github.com/schpet/linear-cli /tmp/linear-cli
```

```ts
const skills = await skillRegistryFromDirectory('/tmp/linear-cli/skills'); // registers the linear-cli skill
const sandbox = new DockerSandboxProvider({ secrets: { ...authSecrets(auth), LINEAR_API_KEY: process.env.LINEAR_API_KEY! } });
await run({ ...opts, sandbox }, { skills });
```

The agent then auto-discovers the skill and can read or update Linear from inside the sandbox.

## Pinning skills: `skills.lock.json`

A skill steers an agent that has repo access, so a silent edit to a `SKILL.md` is a supply-chain risk. A `skills.lock.json` next to a skills directory (`skills/skills.lock.json` for the bundled skills, `.github/vanguard-skills/skills.lock.json` in a target repo) pins skills to an upstream commit and a content hash:

```json
{
  "skills": [
    {
      "name": "linear-cli",
      "source": "https://github.com/schpet/linear-cli",
      "path": "skills/linear-cli",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "sha256": "<sha256 of the skill's SKILL.md>",
      "updatedAt": "2026-01-01"
    }
  ]
}
```

- `source` must be an `https` git URL without credentials (`https://user:token@host/...` is refused). `commit` is a full 40-hex sha, never a tag or branch. `sha256` is the hash of the skill's `SKILL.md`. Each `name` appears once. A lock that breaks these rules fails to parse. The lock itself must be a regular file (not a symlink) of at most 1 MiB.
- `name` is the skill's directory name. A skill without an entry is `local`: it loads. When the lock pins at least one skill, a warning names the skills in that directory it leaves out; a lock with no entries and a directory without a lock file load silently.
- **Only `SKILL.md` is hashed.** Other files in the skill directory (scripts, references) are not pinned and can change without a mismatch.
- The hash is over the file's bytes, so a checkout that rewrites line endings to CRLF (`core.autocrlf`) fails a pinned skill. Keep `SKILL.md` on LF, e.g. `*.md text eol=lf` in `.gitattributes`.
- On load, every skill with an entry is verified, for bundled and repo skills alike. **A hash mismatch fails the run**, naming the skill: the `SKILL.md` is not the content that was pinned. Restore the pinned content, or, if the change is intended, update `sha256` (and `commit`) in the lock through a reviewed change.
- Today the five bundled skills have no upstream to pin to, so they stay `local`.

To pin a skill by hand, add an entry to the `skills` array:

```bash
git ls-remote https://github.com/schpet/linear-cli HEAD     # commit: the 40-hex sha (or `git rev-parse HEAD` in a clone)
sha256sum skills/linear-cli/SKILL.md                         # sha256: the first field (macOS: shasum -a 256)
```

Copy the skill directory from that commit, set `source` to the repo URL, `path` to the skill's path inside it, `updatedAt` to today's date, then run `taskcell skills list` and check the skill shows `pinned`.

### Commands

- `taskcell skills list [--dir <skills dir>]` prints each skill's name, source, short commit and status: `pinned` (hash matches), `local` (no entry) or `modified` (hash differs).
- `taskcell skills check [--dir <skills dir>] [--strict]` resolves each pinned source's default branch head with `git ls-remote` and reports `current`, `outdated` (with the upstream short sha) or `unknown` (the head could not be resolved). `--strict` exits 1 when any skill is outdated or modified; `unknown` does not fail it, so an unreachable upstream never breaks a build. It is read-only.

`--dir` defaults to `<repo>/skills` (`--repo`, else the current directory). Both commands list exactly the skills the registry loads: a subdirectory with no `SKILL.md`, or a symlinked one, is not a skill. Both commands run on the host; the network is never touched from the sandbox.

### Changing skills: `add`, `remove`, `update`

All three run on the host (the sandbox never touches the network) and keep `skills.lock.json` in step with the skill directories.

- `taskcell skills add <git-url>[#ref] [--path <dir-in-repo>] [--name <name>] [--dir <skills dir>]` resolves `ref` (a branch, tag or full sha; default the head of the default branch) to a commit sha, fetches that commit, copies the skill directory (`SKILL.md` and the other files in it, nothing else from the repo), writes the lock entry and prints what was added. `--path` defaults to the repo root; `--name` defaults to the last segment of `--path` (or the repo name). It refuses a non-https source or one with credentials, any symlink (the path, a parent, or a file in the skill), a path that escapes the repo, a directory without `SKILL.md`, a skill with more than 200 files or 5 MiB, and a name that is not a plain directory name (or is `skills.lock.json`), and a name that already exists. Symlinks are checked out as symlinks, never followed, so a source cannot smuggle one in as a text file.
- `taskcell skills remove <name> [--dir]` deletes the skill directory and its lock entry. It refuses a directory that is neither pinned nor holds a `SKILL.md`.
- `taskcell skills update [name] [--dir] [--dry-run] [--pr]` moves each pinned skill (or the named one) to the head of its source's default branch, rewrites the skill directory and the lock, and prints one line per skill, then the `SKILL.md` diff:
  - `<old> → <new> (+a −d lines)`: moved;
  - `current`: already at the head, nothing written;
  - `upstream gone → kept <sha>`: the head, the commit or the skill path could not be fetched; the pin stays;
  - `upstream refused → kept <sha>`: the new commit's skill is invalid (symlink, no `SKILL.md`, over the limits); the reason goes to stderr and the other skills still update;
  - `modified locally → skipped`: any file in the skill directory differs from the pinned commit (the whole directory is compared, not only `SKILL.md`), so update never overwrites a local edit; `missing locally → skipped` means the directory is gone or unreadable, and `cannot verify local files against the pinned commit → skipped` that the pinned commit could not be fetched to compare;
  - `invalid skill name → skipped`: the lock names something that is not a plain directory name.
  Each skill's directory and its lock entry are written together, so an interrupted update never leaves the lock disagreeing with the tree.
- `--dry-run` prints the same and writes nothing.
- `--pr` does the update in a throwaway worktree on a new branch and opens a PR through the normal delivery path (secret scan, commit, push, `gh pr create`). The skills directory must be inside the repo (`--repo`, default the current directory). The PR targets the repo's base branch (`--base`, else the repo's configured one); Taskcell never pushes to it and never merges. The body has each skill's `SKILL.md` diff and links to the old and new upstream commits; upstream text is escaped like other untrusted text (`<` becomes `&lt;`, `@mentions` are defused) fenced so it cannot break out of the block, and each diff is truncated to fit GitHub's body limit. Your checkout is not modified. Review the diff before merging: a skill steers an agent that has repo access.
