#!/usr/bin/env bash
# Retries a command that can fail on a transient network error (a GitHub Releases/npm registry 5xx or
# timeout) with linear backoff, so an hour-long outage (#657) does not fail a whole sandbox image build.
# On final failure it tags its own stderr so docker/build.sh can tell a network failure — worth reporting
# as an infrastructure problem, not a code bug — from any other failure of the wrapped command.
#
# Usage: retry.sh <attempts> <base-delay-seconds> -- <command...>
set -uo pipefail

attempts="$1"
base_delay="$2"
shift 2
[ "${1:-}" = "--" ] && shift

# Shapes curl/npm use for a transient failure: curl's connect/resolve/timeout error text, a bare 5xx
# status line, or npm's "Error fetching release: Request failed with status code 5xx" (the linear-cli
# postinstall's wording, see Dockerfile).
NETWORK_PATTERN='Could not resolve host|Connection timed out|Failed to connect|Operation timed out|Connection reset by peer|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bECONNRESET\b|HTTP/[0-9.]+ 5[0-9]{2}\b|5[0-9]{2} (Gateway Time-?out|Service Unavailable|Bad Gateway|Internal Server Error)|status code 5[0-9]{2}'

attempt=1
while true; do
  output="$("$@" 2>&1)"
  status=$?
  printf '%s\n' "$output" >&2
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    if printf '%s' "$output" | grep -qE "$NETWORK_PATTERN"; then
      echo "RETRY_EXHAUSTED_NETWORK: giving up after $attempt attempts: $*" >&2
    else
      echo "RETRY_EXHAUSTED: giving up after $attempt attempts: $*" >&2
    fi
    exit "$status"
  fi
  delay=$((attempt * base_delay))
  echo "retry.sh: attempt $attempt/$attempts failed, retrying in ${delay}s: $*" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
