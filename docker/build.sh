#!/usr/bin/env bash
set -euo pipefail
VERSION="${CLAUDE_CLI_VERSION:-2.1.260}"
# Opt-in: empty skips the Cursor CLI (~550 MB); set e.g. CURSOR_CLI_VERSION=2026.10.16-e3cb207 for --provider cursor.
CURSOR_VERSION="${CURSOR_CLI_VERSION:-}"
# Alias tag on the same image, kept for hosts/scripts still looking for the pre-rename name. Only
# defaulted when TAG is too: `TAG=experiment:1 docker/build.sh` must not move the pre-rename tag onto
# a one-off build. An explicit ALIAS_TAG always applies, empty included (skips the alias).
if [ -z "${TAG:-}" ]; then ALIAS_TAG="${ALIAS_TAG-vanguard-sandbox:latest}"; fi
TAG="${TAG:-taskcell-sandbox:latest}"
ALIAS_ARGS=()
if [ -n "${ALIAS_TAG:-}" ]; then ALIAS_ARGS+=(-t "${ALIAS_TAG}"); fi
HERE="$(cd "$(dirname "$0")" && pwd)"
# A non-default Cursor version needs its per-arch checksums; forward them only when set so the
# Dockerfile defaults apply otherwise.
CURSOR_SHA_ARGS=()
if [ -n "${CURSOR_CLI_SHA256_X64:-}" ]; then CURSOR_SHA_ARGS+=(--build-arg "CURSOR_CLI_SHA256_X64=${CURSOR_CLI_SHA256_X64}"); fi
if [ -n "${CURSOR_CLI_SHA256_ARM64:-}" ]; then CURSOR_SHA_ARGS+=(--build-arg "CURSOR_CLI_SHA256_ARM64=${CURSOR_CLI_SHA256_ARM64}"); fi
# Set LINEAR_RETRY=1 to rebuild the linear-cli layer after a build that skipped it (see Dockerfile).
LINEAR_RETRY="${LINEAR_RETRY:+$(date +%s)}"
docker build --build-arg "CLAUDE_CLI_VERSION=${VERSION}" --build-arg "LINEAR_RETRY=${LINEAR_RETRY}" --build-arg "CURSOR_CLI_VERSION=${CURSOR_VERSION}" \
  ${CURSOR_SHA_ARGS[@]+"${CURSOR_SHA_ARGS[@]}"} -t "${TAG}" ${ALIAS_ARGS[@]+"${ALIAS_ARGS[@]}"} "${HERE}"
echo "Zbudowano ${TAG}${ALIAS_TAG:+ (alias ${ALIAS_TAG})} (claude ${VERSION}${CURSOR_VERSION:+, cursor ${CURSOR_VERSION}})"
# Weryfikacja kontraktu CLI (R4): obecność narzędzi i flag.
docker run --rm "${TAG}" sh -lc 'claude --version && git --version && bun --version'
docker run --rm "${TAG}" sh -lc 'linear --version' \
  || echo "WARNING: ${TAG} has no linear CLI (GitHub Releases was down); --linear runs need LINEAR_RETRY=1 docker/build.sh" >&2
if [ -n "${CURSOR_VERSION}" ]; then docker run --rm "${TAG}" sh -lc 'agent --version'; fi
