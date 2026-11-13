# Audit trail

One audit record module (`src/core/audit.ts`) sits behind every append-only record Taskcell writes. It gives
each record an actor and a subject, chains the records with sha256, and lets you verify and export them.

## What is recorded

Separate streams, not one global log. Run records stay artifacts under `.taskcell/runs/` and are referenced by hash.

| Stream | Where | Class | Written by |
| --- | --- | --- | --- |
| `hub` | `<hub config dir>/audit.jsonl` | audit | the hub: every state-changing action (#621) |
| `decisions` | `decisions.jsonl` on the metrics branch | audit | the approver (actor: the factory bot) |
| `lessons` | `lessons.jsonl` on the metrics branch | audit | `taskcell lessons` |
| `run-events` | `.taskcell/runs/<task>/events-*.jsonl` | telemetry | the hub run event log (#830) |
| `metrics` | `.taskcell/runs/metrics.jsonl` | telemetry | run stage metrics |

**Audit** streams fsync and fail closed: if the line cannot be written, the write rejects with `AuditWriteError`
and the caller refuses or reports the action (a hub action that already happened is reported to the client as an
error; a run already admitted logs the failure to stderr). **Telemetry** streams are best-effort and never fail
the run. The class is a property of the stream (`STREAMS`).

## Who and what

Every record carries `actor` and, as available, `subject`:

- `actor`: `{ kind: 'user', id, name }` (Better Auth user id + display name), `{ kind: 'local', name }` (local
  owner), `{ kind: 'token' }` (the shared hub token) or `{ kind: 'bot' }` (the factory bot, also used in CI).
  The hub's RPC context carries the actor from sign-in.
- `subject`: `{ repo, issue, pr, runId }`. The hub run id (`run-N`) survives restarts: the next number is
  persisted in `<hub config dir>/run-counter`.

## The chain

A record is the payload plus `actor`, `subject`, a time (`ts`, unless the payload has one), `prev` and `hash`.
`hash` is the sha256 of the canonical (key-sorted) record without `hash`; `prev` is the previous record's `hash`.
Editing a line breaks its own hash; deleting or reordering a line breaks the next `prev`. Secrets are masked
(deep redaction) before hashing. Lines written before the chain existed are tolerated at the start of a stream.
An unparseable line (crash mid-write) is counted as `torn`, not a failure; the next append starts a fresh line, and a record lost to damage still breaks the next `prev`. Appends are serialised in-process and across processes with a `<file>.lock` file.

Local files rotate at 10 MB to `<file>.<timestamp>`; the new file's first record chains to the last record of the
previous one. On the metrics branch the chain is computed inside the push, so a retried push re-chains on the
fresh tip.

## Verify and export

```
taskcell audit verify [--stream hub|run-events|metrics|decisions|lessons] [--repo <path>] [--config-dir <dir>] [--branch <name>]
taskcell audit export [--stream <name>] [--since <date>] [--until <date>] [--format jsonl|csv]
```

`verify` exits 1 when any chain fails and names the file and line. `export` writes records verbatim (jsonl, so
the export can be re-verified) or as CSV (`ts,stream,actor,subject,record`; cells starting with `=+-@` are
neutralised).

## Issue history

```
taskcell history owner/repo#N [--json] [--offline] [--repo <path>] [--config-dir <dir>] [--branch <name>]
```

One history for an issue, oldest first: trigger label, spec, each run (start, stages, outcome), reviews and
verdicts, revise rounds, the approver decision, merge or close. Each entry has a time, an actor (person or
factory bot) and a source (stream or run record plus a ref such as `audit.jsonl:12`, and a link when one exists).
The hub shows the same list as the History section of a card (docs/hub.md).

It is a read model, not a new copy: it reads the streams and joins them by subject (`repo`, `issue`, `pr`,
`runId`). Run-event logs belong to the issue by their task directory; their run ids pull in hub audit lines
for those runs; PR numbers come from run records and Git host events and pull in `decisions` lines. Where no
stream has a record (a human applying a label, a comment, a merge) it asks the Git host (`gh api
.../timeline`; GitHub only, GitLab events are not read yet; `--offline` skips it).

Every chain it read is verified as `audit verify` does and listed (with its unchained pre-audit count); entries from a chain that fails are marked
`chain failed` and the command exits 1. Unchained legacy lines, run records and Git host events have no chain and are
marked `no chain`. Run records, run-event logs and `decisions` are this checkout's: when its origin is not `owner/repo`, they are skipped and listed under `unavailable`. Spec runs (`spec-<slug>-<N>`) and the review and revise runs of the issue's PRs (`pr-review-<slug>-<PR>`, `revise-pr-<slug>-<PR>`; the slug with every non-alphanumeric as `-`) are included; a cross-reference from a PR of another repo is not. A spec comment is a bot comment that opens with `Taskcell Tech Spec`. A revise round is a `revise-pr-` run, a run record whose PR an earlier run already opened, or whose task or
stage name says revise. A source that could not be read is listed under `unavailable`.

## Retention

Rotated local files older than the retention are deleted: default 90 days, `TASKCELL_AUDIT_RETENTION_DAYS` to
change it. At most 50 rotated files are kept per stream whatever their age. `metrics.jsonl` is never rotated (`stats` and `metrics push` read only the live file). Pruning happens when a file rotates and once per process on first append. The oldest retained record is
the anchor of the chain (its `prev` is not checked). The live file and the metrics-branch files are not pruned.

## Limits

- The chain proves records were not altered after writing. It does not prove a host admin could not rewrite the
  whole file plus chain; that needs an external anchor (e.g. periodically publishing the latest `hash` elsewhere).
- Deleting the newest records, or whole rotated files, leaves a shorter but valid chain.
- Concurrent writers to the same metrics-branch file can fork the chain; verify reports it.
- Sign-in lines are reported on stderr, not refused, when the log is unwritable; other hub actions are applied first and the caller is told the audit line failed.
