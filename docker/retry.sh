#!/bin/sh
# Retry a command on a transient network failure (5xx, 429, DNS/connect/timeout) with linear
# backoff. Anything else -- a bad version pin, a 404 for a typo'd URL, a real build bug -- fails on
# the first attempt instead of waiting through a full retry budget for a problem retrying can't fix.
#
# Usage: retry.sh <max-attempts> <base-delay-seconds> <command...>
#
# On final failure caused by a transient error, prints a `::error::` line marking it as
# infrastructure flakiness (not a task/code problem) so a human reading the run can re-trigger it
# without reading the rest of the build log.
set -u

max_attempts="$1"
base_delay="$2"
shift 2

# Debian's GNU grep -E, case-insensitive. Matches an HTTP 5xx/429 status, or the DNS/connect/timeout
# errors curl, npm and tar emit for an outage (e.g. the GitHub Releases 504s in #657).
TRANSIENT_RE='(^|[[:space:]])(HTTP(/[0-9.]+)?[[:space:]]+|E|status([[:space:]]+code)?[[:space:]:=]+|error:[[:space:]]*)(5[0-9][0-9]|429)([^0-9]|$)|^(5[0-9][0-9]|429)([^0-9]|$)|time(d)? ?out|could not resolve host|connection reset|connection refused|temporary failure in name resolution|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN'

attempt=1
out="$(mktemp)" || exit 1
trap 'rm -f "$out"' EXIT

while true; do
  "$@" >"$out" 2>&1
  status=$?
  if [ "$status" -eq 0 ]; then
    cat "$out"
    exit 0
  fi
  cat "$out" >&2

  if ! grep -qiE "$TRANSIENT_RE" "$out"; then
    echo "retry.sh: attempt $attempt failed with a non-transient error, not retrying" >&2
    exit "$status"
  fi

  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "::error::VANGUARD_INFRA_FAILURE: '$*' failed after $max_attempts attempts, each with a transient network error (5xx/429/timeout). This is infrastructure flakiness, not a task failure -- re-run the job." >&2
    exit "$status"
  fi

  delay=$((base_delay * attempt))
  echo "retry.sh: attempt $attempt/$max_attempts failed with a transient network error, retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
