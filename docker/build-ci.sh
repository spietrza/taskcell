#!/bin/sh
# CI entry point for the sandbox image build. Retries the whole `docker build` on a transient
# network failure (pulling the base image, or a release download inside the Dockerfile that
# exhausted retry.sh's own budget). Caching unchanged layers is left to Docker's own build cache
# rather than reimplemented here -- it needs a human-applied workflow change (see NOTE below) to
# actually persist between CI runs. Never talks to GitHub: a build failure must stay a build
# failure, not a task-level label or comment (see CLAUDE.md / #657).
#
# Usage: build-ci.sh <tag> [docker build args...]
#
# NOTE for CI wiring: this script is not called from .github/workflows yet (editing those is off
# limits for an agent run) -- a human needs to replace the `docker build -t vanguard-sandbox:latest
# .vanguard-src/docker/` line in implement.yml, revise.yml and pr-review.yml with
# `.vanguard-src/docker/build-ci.sh vanguard-sandbox:latest`. See the PR description.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="$1"
shift

# Overridable so tests don't have to wait through the real backoff.
attempts="${BUILD_CI_RETRY_ATTEMPTS:-5}"
delay="${BUILD_CI_RETRY_DELAY:-20}"
exec "$HERE/retry.sh" "$attempts" "$delay" docker build "$@" -t "$TAG" "$HERE"
