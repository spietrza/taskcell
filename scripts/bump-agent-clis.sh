#!/usr/bin/env bash
# Moves the sandbox's agent CLI pins (claude, codex) to the latest npm release. docker/Dockerfile's ARG is
# the source of truth; every other copy of the old pin (build.sh, SANDBOX_CLAUDE_VERSION, docs, test
# fixtures) is rewritten with it. Prints one "name old -> new" line per bump, nothing when current.
# Never touches .github/: eval.yml reads the pin from the Dockerfile, and the bot token cannot push workflows.
set -euo pipefail
cd "$(dirname "$0")/.."

bump() { # <ARG name> <npm package>
  local old new
  old=$(sed -n "s/^ARG $1=//p" docker/Dockerfile)
  new=$(npm view "$2" version)
  [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::$2: unexpected npm version '$new'" >&2; exit 1; }
  [ "$old" = "$new" ] && return 0
  # Only files that pin the CLI; CHANGELOG and research notes record history and keep the old number.
  git grep -lF "$old" -- docker src/sandbox 'src/cli/*.test.ts' CONTRIBUTING.md docs/cli.md \
    | xargs sed -i.bak "s/$(printf '%s' "$old" | sed 's/\./\\./g')/$new/g"
  find . -name '*.bak' -not -path './node_modules/*' -delete
  echo "$2 $old -> $new"
}

bump CLAUDE_CLI_VERSION @anthropic-ai/claude-code
bump CODEX_CLI_VERSION @openai/codex
