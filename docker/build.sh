#!/usr/bin/env bash
set -euo pipefail
VERSION="${CLAUDE_CLI_VERSION:-2.1.322}"
# Opt-in: empty skips the Cursor CLI (~550 MB); set e.g. CURSOR_CLI_VERSION=2026.10.16-e3cb207 for --provider cursor.
CURSOR_VERSION="${CURSOR_CLI_VERSION:-}"
# Alias tag on the same image, kept for hosts/scripts still looking for the pre-rename name. Only
# defaulted when TAG is too: `TAG=experiment:1 docker/build.sh` must not move the pre-rename tag onto
# a one-off build. An explicit ALIAS_TAG always applies, empty included (skips the alias).
if [ -z "${TAG:-}" ]; then ALIAS_TAG="${ALIAS_TAG-vanguard-sandbox:latest}"; fi
TAG="${TAG:-taskcell-sandbox:latest}"
# Tags the image carries locally, whether pulled or built: the primary one plus the optional alias.
TAGS=("${TAG}")
if [ -n "${ALIAS_TAG:-}" ]; then TAGS+=("${ALIAS_TAG}"); fi
TAG_ARGS=()
for t in "${TAGS[@]}"; do TAG_ARGS+=(-t "${t}"); done
HERE="$(cd "$(dirname "$0")" && pwd)"
# A non-default Cursor version needs its per-arch checksums; forward them only when set so the
# Dockerfile defaults apply otherwise.
CURSOR_SHA_ARGS=()
if [ -n "${CURSOR_CLI_SHA256_X64:-}" ]; then CURSOR_SHA_ARGS+=(--build-arg "CURSOR_CLI_SHA256_X64=${CURSOR_CLI_SHA256_X64}"); fi
if [ -n "${CURSOR_CLI_SHA256_ARM64:-}" ]; then CURSOR_SHA_ARGS+=(--build-arg "CURSOR_CLI_SHA256_ARM64=${CURSOR_CLI_SHA256_ARM64}"); fi
# Set LINEAR_RETRY=1 to rebuild the linear-cli layer after a build that skipped it (see Dockerfile).
LINEAR_RETRY="${LINEAR_RETRY:+$(date +%s)}"
# Pull-first: when the image for this `docker/` tree is published to GHCR, a factory run must not pay
# a from-scratch npm + GitHub Releases build. Nothing in this repo publishes that tag yet (no CI job
# does, and this run may not add one) — push it by hand or point GHCR_SANDBOX_IMAGE at your own
# registry; until then the pull just fails and the build below runs as before.
# The tag is the git tree hash of `docker/`, so it is only valid for a committed, clean tree; any
# build-arg override (CLAUDE_CLI_VERSION, Cursor, LINEAR_RETRY) asks for something other than the
# published default, so those build. Every failure path — no tag, no registry access, no git, a `git`
# that errors — leaves the chain and builds.
GHCR_IMAGE="${GHCR_SANDBOX_IMAGE:-ghcr.io/spietrza/taskcell-sandbox}"
# A registry tag can be overwritten, so a pulled image is used only when GitHub's build provenance ties
# that exact digest to the publish workflow on the Taskcell repo. No `gh`, no token or no attestation
# means the build below runs instead: the check fails closed to building from source.
ATTEST_REPO="${SANDBOX_ATTEST_REPO:-spietrza/taskcell}"
verify_provenance() {
  command -v gh >/dev/null 2>&1 || return 1
  gh attestation verify "oci://$1" --repo "${ATTEST_REPO}" \
    --signer-workflow "${ATTEST_REPO}/.github/workflows/sandbox-image.yml" >/dev/null 2>&1 \
    || { echo "WARNING: no verifiable provenance for $1; building instead" >&2; return 1; }
}
if [ -z "${CLAUDE_CLI_VERSION:-}${CURSOR_VERSION}${CURSOR_CLI_SHA256_X64:-}${CURSOR_CLI_SHA256_ARM64:-}${LINEAR_RETRY}" ] \
  && DOCKER_TREE="$(git -C "${HERE}" rev-parse HEAD:docker 2>/dev/null)" \
  && DOCKER_DIRTY="$(git -C "${HERE}" status --porcelain -- "${HERE}")" \
  && [ -z "${DOCKER_DIRTY}" ] \
  && docker pull "${GHCR_IMAGE}:${DOCKER_TREE}" \
  && PULLED="$(docker inspect --format '{{index .RepoDigests 0}}' "${GHCR_IMAGE}:${DOCKER_TREE}")" \
  && verify_provenance "${PULLED}"; then
  for t in "${TAGS[@]}"; do docker tag "${PULLED}" "${t}"; done
  echo "Pobrano ${PULLED} -> ${TAG}${ALIAS_TAG:+ (alias ${ALIAS_TAG})}; pomijam build"
else
  # Captured (not just streamed) so a build failure can be told apart below: docker/retry.sh tags its
  # own giving-up line with RETRY_EXHAUSTED_NETWORK when every retried download (npm installs, the
  # Cursor curl) failed on what looks like a transient network error — a GitHub Releases/npm 5xx or a
  # timeout (#657) — rather than a real break (bad pin, checksum mismatch, ...). `tee` plus `pipefail`
  # (set above) keep `$?` below the real `docker build` exit code, not tee's.
  BUILD_LOG="$(mktemp)"
  trap 'rm -f "${BUILD_LOG}"' EXIT
  docker build --build-arg "CLAUDE_CLI_VERSION=${VERSION}" --build-arg "LINEAR_RETRY=${LINEAR_RETRY}" --build-arg "CURSOR_CLI_VERSION=${CURSOR_VERSION}" \
    ${CURSOR_SHA_ARGS[@]+"${CURSOR_SHA_ARGS[@]}"} "${TAG_ARGS[@]}" "${HERE}" 2>&1 | tee "${BUILD_LOG}" && BUILD_STATUS=0 || BUILD_STATUS=$?
  if [ "${BUILD_STATUS}" -ne 0 ]; then
    if grep -q 'RETRY_EXHAUSTED_NETWORK' "${BUILD_LOG}"; then
      echo "::error::Infrastructure failure: sandbox image build failed after retries on a network error (GitHub Releases or the npm registry is likely down) — not a code or task problem; re-run the job." >&2
      exit 1
    fi
    exit "${BUILD_STATUS}"
  fi
  echo "Zbudowano ${TAG}${ALIAS_TAG:+ (alias ${ALIAS_TAG})} (claude ${VERSION}${CURSOR_VERSION:+, cursor ${CURSOR_VERSION}})"
fi
# Weryfikacja kontraktu CLI (R4): obecność narzędzi i flag.
docker run --rm "${TAG}" sh -lc 'claude --version && git --version && bun --version'
docker run --rm "${TAG}" sh -lc 'linear --version' \
  || echo "WARNING: ${TAG} has no linear CLI (GitHub Releases was down); --linear runs need LINEAR_RETRY=1 docker/build.sh" >&2
if [ -n "${CURSOR_VERSION}" ]; then docker run --rm "${TAG}" sh -lc 'agent --version'; fi

# The per-CLI layer split only pays off if no npm cache is committed into the image (see Dockerfile).
docker run --rm --user root "${TAG}" sh -lc 'test ! -d /root/.npm && test ! -d /home/agent/.npm'
