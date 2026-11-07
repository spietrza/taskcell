#!/usr/bin/env bash
set -euo pipefail
VERSION="${CLAUDE_CLI_VERSION:-2.1.260}"
# Opt-in: empty skips the Cursor CLI (~550 MB); set e.g. CURSOR_CLI_VERSION=2026.10.16-e3cb207 for --provider cursor.
CURSOR_VERSION="${CURSOR_CLI_VERSION:-}"
TAG="${TAG:-taskcell-sandbox:latest}"
# Alias tag on the same image, kept for hosts/scripts still looking for the pre-rename name.
ALIAS_TAG="${ALIAS_TAG:-vanguard-sandbox:latest}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# A non-default Cursor version needs its per-arch checksums; forward them only when set so the
# Dockerfile defaults apply otherwise.
CURSOR_SHA_ARGS=()
if [ -n "${CURSOR_CLI_SHA256_X64:-}" ]; then CURSOR_SHA_ARGS+=(--build-arg "CURSOR_CLI_SHA256_X64=${CURSOR_CLI_SHA256_X64}"); fi
if [ -n "${CURSOR_CLI_SHA256_ARM64:-}" ]; then CURSOR_SHA_ARGS+=(--build-arg "CURSOR_CLI_SHA256_ARM64=${CURSOR_CLI_SHA256_ARM64}"); fi
docker build --build-arg "CLAUDE_CLI_VERSION=${VERSION}" --build-arg "CURSOR_CLI_VERSION=${CURSOR_VERSION}" \
  ${CURSOR_SHA_ARGS[@]+"${CURSOR_SHA_ARGS[@]}"} -t "${TAG}" -t "${ALIAS_TAG}" "${HERE}"
echo "Zbudowano ${TAG} (alias ${ALIAS_TAG}; claude ${VERSION}${CURSOR_VERSION:+, cursor ${CURSOR_VERSION}})"
# Weryfikacja kontraktu CLI (R4): obecność narzędzi i flag.
docker run --rm "${TAG}" sh -lc 'claude --version && git --version && bun --version'
if [ -n "${CURSOR_VERSION}" ]; then docker run --rm "${TAG}" sh -lc 'agent --version'; fi
