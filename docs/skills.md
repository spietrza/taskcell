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

#### Step by step

Run these in the repo that holds the skills. The examples use `.github/vanguard-skills`, the directory Taskcell loads from a target repo; leave `--dir` out to use `<repo>/skills`.

1. **Add a skill.** Give the https URL of the repo that has it and the path of the skill directory inside that repo:

   ```bash
   taskcell skills add https://github.com/schpet/linear-cli --path skills/linear-cli --dir .github/vanguard-skills
   # added linear-cli   https://github.com/schpet/linear-cli   71b402d   1 file(s)
   ```

   This copies the skill to `.github/vanguard-skills/linear-cli/` and pins it in `.github/vanguard-skills/skills.lock.json`. Append `#<branch, tag or sha>` to the URL to pin something other than the head of the default branch. Read the `SKILL.md` you just added, then commit both the directory and the lock.

2. **See what you have, and whether upstream moved.**

   ```bash
   taskcell skills list --dir .github/vanguard-skills     # linear-cli … pinned
   taskcell skills check --dir .github/vanguard-skills    # linear-cli … current | outdated (upstream <sha>)
   ```

3. **Update as a PR.** Look first, then let Taskcell open the PR:

   ```bash
   taskcell skills update --dir .github/vanguard-skills --dry-run --pr   # prints what the PR would change, writes nothing
   taskcell skills update --dir .github/vanguard-skills --pr             # opened https://github.com/<owner>/<repo>/pull/<n>
   ```

   `--pr` needs an `origin` remote you can push to and a `gh` that is logged in (`gh auth status`). It works in a throwaway worktree, so your checkout and your current branch are untouched. Review the PR like any other: the body has each skill's `SKILL.md` diff, the names of the other files that changed, and links to the upstream commits. Merge it yourself; Taskcell never does. To update in your working tree instead, leave `--pr` out and commit the result.

4. **Remove a skill.**

   ```bash
   taskcell skills remove linear-cli --dir .github/vanguard-skills
   ```

   This deletes the directory and its lock entry; commit the change.

#### Reference

- `taskcell skills add <git-url>[#ref] [--path <dir-in-repo>] [--name <name>] [--dir <skills dir>]` resolves `ref` (a branch name, a tag name or a full sha; default the head of the default branch) to a commit sha, fetches that commit, copies the skill directory (`SKILL.md` and the other files in it, nothing else from the repo), writes the lock entry and prints what was added. `--path` defaults to the repo root; `--name` defaults to the last segment of `--path` (or the repo name). Executable files stay executable. It refuses:
  - a source that is not https or carries credentials, and a `ref` that is not a plain name (git reads ref arguments as patterns, so `*` and the like are rejected);
  - any symlink in the skill directory, and a path that escapes the repo. A symlink is refused from the commit's file listing, before anything is checked out, and none is ever created on the host;
  - a directory without `SKILL.md`, and a skill with more than 200 files or 5 MiB (the file count is checked before any file content is downloaded);
  - a name that is not a plain directory name, is `skills.lock.json`, or already exists.
- `taskcell skills remove <name> [--dir <skills dir>]` deletes the skill directory and its lock entry. It refuses a directory that is neither pinned nor holds a `SKILL.md`.
- `taskcell skills update [name] [--dir <skills dir>] [--dry-run] [--pr [--base <branch>]] [--force]` moves each pinned skill (or the named one) to the head of its source's default branch, rewrites the skill directory and the lock, and prints one line per skill, then for each moved skill the names of the files that changed besides `SKILL.md` (`A` added, `M` modified, including a mode change, `D` deleted) and the `SKILL.md` diff. Scripts in a skill are what an agent runs, so read that list, not only the diff. The per-skill line is one of:
  - `<old> → <new> (+a −d lines)`: moved;
  - `current`: already at the head, nothing written;
  - `upstream gone → kept <sha>`: the head, the commit or the skill path could not be fetched; the pin stays, and git's own error goes to stderr;
  - `upstream refused → kept <sha>`: the new commit's skill is invalid (symlink, no `SKILL.md`, over the limits); the reason goes to stderr and the other skills still update;
  - `modified locally → skipped`: a file in the skill directory differs from the pinned commit in content or in its executable bit (the whole directory is compared, not only `SKILL.md`), so update never overwrites a local edit; `missing locally → skipped` means the directory is gone or unreadable;
  - `pinned commit <sha> can no longer be fetched … → skipped`: the source no longer serves the pinned commit (it was force-pushed away, or the server refuses a fetch by sha), so the local files cannot be compared with it. Rerun with `--force` to update anyway: `SKILL.md` must still match the hash in the lock, and only the other files are replaced unchecked;
  - `invalid skill name → skipped`: the lock names something that is not a plain directory name.
- `--dry-run` prints the same and writes nothing.
- `--pr` does the update in a throwaway worktree on a new branch and opens a PR through the normal delivery path (secret scan, commit, push, `gh pr create`). The skills directory must be inside the repo (`--repo`, default the current directory). The PR targets the repo's base branch (`--base`, else the repo's configured one; `--base` without `--pr` is an error); Taskcell never pushes to it and never merges. The body has, per skill, the `SKILL.md` diff, the list of other changed files and the old and new upstream commits, linked for GitHub and GitLab sources. Upstream text is escaped like other untrusted text (`<` becomes `&lt;`, `@mentions` are defused) and fenced so it cannot break out of the block. The whole body is kept under GitHub's size limit: long diffs and lists are cut with a note that says so. Your checkout is not modified, and the worktree and its local branch are removed whether the PR was opened, nothing moved, or the run failed or was blocked by the secret scan. A lock on the base branch with an invalid skill name is refused before anything is pushed. Review the diff before merging: a skill steers an agent that has repo access.
- `--dry-run --pr` makes the plan against the base branch, as the PR would, prints it, and commits, pushes and opens nothing.

A relative `--dir` is taken under `--repo` by `add`, `remove` and `update`; `list` and `check` read it as given (relative to the current directory).

Installing is safe to fail: the new content is staged in a hidden directory next to the skill and swapped in with renames, and if the swap or the lock write fails the previous directory is put back. A kill between the swap and the lock write is the one gap: the directory is new and the lock entry old, so when `SKILL.md` changed `skills list` shows the skill as `modified` and a run refuses it until you run `skills remove` and `skills add` again (or restore the directory with git). A leftover `.<name>.tmp-*` directory from such a kill is never loaded as a skill and can be deleted.

#### Git on the host

`add` and `update` fetch a repo nobody has reviewed yet, so they run git with hooks, fsmonitor, symlink creation and the LFS filter off, and without the environment variables that point git at another repository (`GIT_DIR`, `GIT_WORK_TREE`, …) or inject config for one command (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, `GIT_CONFIG_PARAMETERS`). They fetch only the pinned commit (depth 1), without file contents where the server supports partial clone, and check out only the skill's path; skills that share a source and commit share one fetch.

The transports are https and ssh. ssh is there for one case: an operator's own `url."git@github.com:".insteadOf "https://github.com/"` rewrite, the usual way to reach a private repo. The source in the lock must still be https. For `add` and `update` that rewrite (and any credential helper) has to be in a git config file: `~/.gitconfig`, the system config, or the file `GIT_CONFIG_GLOBAL` names. Config passed through `GIT_CONFIG_COUNT` variables is honoured by `skills check` only, which makes no checkout and runs plain `git ls-remote`.
