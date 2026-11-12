#!/usr/bin/env bash
# Moves the sandbox's agent CLI pins (claude, codex) to the newest npm release that is at least
# SOAK_DAYS old (default 3), so a bad or hijacked publish has time to be pulled before it reaches the
# image. docker/Dockerfile's ARG is the source of truth; every other copy of the old pin (build.sh,
# SANDBOX_CLAUDE_VERSION, SANDBOX_CODEX_VERSION, docs, test fixtures) is rewritten with it. Prints one "package old -> new" line
# per bump, nothing when current. Never touches .github/: eval.yml reads the pin from the Dockerfile,
# and the bot token cannot push workflows.
set -euo pipefail
cd "$(dirname "$0")/.."
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

# Newest stable version of <package> published at least SOAK_DAYS ago.
soaked() {
  npm view "$1" time --json | node -e '
    const t = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const cutoff = Date.now() - Number(process.env.SOAK_DAYS ?? 3) * 864e5;
    const key = (v) => v.split(".").map(Number);
    const ok = Object.keys(t)
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && Date.parse(t[v]) <= cutoff)
      .sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
    process.stdout.write(ok.at(-1) ?? "");'
}

bump() { # <ARG name> <npm package>
  local old new
  old=$(sed -n "s/^ARG $1=//p" docker/Dockerfile)
  [[ "$old" =~ $SEMVER ]] || { echo "::error::$1 in docker/Dockerfile must be x.y.z, got '$old'" >&2; exit 1; }
  new=$(soaked "$2")
  [[ "$new" =~ $SEMVER ]] || { echo "::error::$2: no soaked npm version, got '$new'" >&2; exit 1; }
  # Never move a pin backwards (e.g. a hand bump to a version still inside the soak window).
  [ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -1)" = "$new" ] && [ "$old" != "$new" ] || return 0
  # Only files that pin the CLI; CHANGELOG and research notes record history and keep the old number.
  # Whole-version match only, so 2.1.32 never rewrites 2.1.322.
  git grep -lF "$old" -- docker src/sandbox 'src/cli/*.test.ts' CONTRIBUTING.md docs/cli.md \
    | OLD="$old" NEW="$new" xargs perl -pi -e 's/(?<![0-9.])\Q$ENV{OLD}\E(?![0-9.])/$ENV{NEW}/g'
  echo "$2 $old -> $new"
}

bump CLAUDE_CLI_VERSION @anthropic-ai/claude-code
bump CODEX_CLI_VERSION @openai/codex
