# VELANCE Fleet Operations — local P2 runbook

This runbook uses a **temporary database** by default. All commands are run from the repository root and require **Node.js 24+** (`node:sqlite`, `node:worker_threads`). There is no npm install step for `tools/ops`. Never substitute `tools/ops/telemetry.db` in a test/fixture command.

## Startup and local checks

```bash
# Run from the VELANCE repository root. The directory is private and outside git.
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/velance-p2.XXXXXX")"
chmod 700 "$RUN_DIR"
printf 'Review directory: %s\n' "$RUN_DIR"

# Serves showroom, /ops/, telemetry, readiness and metrics on loopback.
node tools/ops/server.mjs --host 127.0.0.1 --port 8090 \
  --db "$RUN_DIR/review.db" --backup-dir "$RUN_DIR/backups" --backup-keep 24
```

In another terminal, use the printed review directory as `RUN_DIR` for maintenance commands (shell variables are not shared across terminals):

```bash
curl -i http://127.0.0.1:8090/health/live
curl -i http://127.0.0.1:8090/health/ready
curl -s http://127.0.0.1:8090/metrics
curl -s 'http://127.0.0.1:8090/api/summary?hours=1'
```

The dashboard is `http://127.0.0.1:8090/ops/` and the showroom is `/`. An empty database produces empty metrics/session cohorts, not synthetic telemetry. Visiting the showroom on this origin activates best-effort telemetry unless opted out. `Ctrl+C` triggers the SIGINT drain; SIGTERM uses the same shutdown path. The server stops admission, closes the listener and DB workers, aborts a running scheduled backup if necessary, and has a 10-second forced-shutdown fallback.

With no `--backup-dir`, no scheduled snapshots run. Providing it requires an owned private `0700` directory; the server will create it privately if missing. `--backup-keep` retains a count of backups (default **168**) rather than a number of days. The default schedule is one hour. The configured database must be stored on a local writable volume with sufficient space for SQLite WAL and snapshots.

## Local quality gate

```bash
node tools/ops/check.mjs
```

This gate uses Node `--check` on the backend, collector, dashboard and native tests, then `node --test` on `tools/ops/test/*.mjs` using Node's own test runner. It is intentionally CPU/local only, requires no browser or npm packages, and uses the temporary DB fixtures created by the test files. It does **not** run GPU suites, browser smoke, load benchmarks or CI. A nonzero exit means syntax or native tests failed; it does not indicate the running service or private real DB was modified.

### P2 local acceptance evidence (2026-11-17)

The latest local run passed **30/30 native tests**, with **12 syntax-checked files**, Node v24.21.0, and a separate raw TAP run also passing 30/30. Evidence is in [backend-p2-local.json](../tools/perf/results/backend-p2-local.json) and [backend-p2-local-passed.tap](../tools/perf/results/backend-p2-local-passed.tap). A previous passing run (29/29) is retained as [backend-p2-local-pre-readonly.tap](../tools/perf/results/backend-p2-local-pre-readonly.tap). An earlier failure (26/27) is retained as [backend-p2-local-failed.tap](../tools/perf/results/backend-p2-local-failed.tap), where an oversized test client continued transmitting after the server rejected the request; the revised deterministic test requires a complete 413 response for fixed-length and chunked requests. These are local correctness results, not benchmarks or an availability SLO.

Fixture drills include killing the child process after acknowledged writes and verifying receipts on restart, concurrent HTTP ingestion with consistent backup/restore, reopened read API against the restored snapshot, a simulated SQLite write lock followed by recovery, read-only storage failing startup with a storage error, private-directory/manifest corruption checks, worker failure/readiness and rate-limiter overload. No project telemetry DB, production listener, source assets or previous Fleet Ops evidence was modified by these tests.

## Back up, verify and restore an isolated database

Run commands from the repository root with `RUN_DIR` from setup (or specify another temp location):

```bash
node tools/ops/operations.mjs backup --db "$RUN_DIR/review.db" --dir "$RUN_DIR/backups"

# Replace with an exact `file` path printed by the preceding command.
BACKUP_FILE="$RUN_DIR/backups/velance-YYYYMMDDTHHMMSSZ-xxxxxxxx.db"
node tools/ops/operations.mjs verify --file "$BACKUP_FILE"

# Restore creates a new database path; it refuses to overwrite a file or sidecar.
node tools/ops/operations.mjs restore --file "$BACKUP_FILE" --to "$RUN_DIR/restored.db"
```

The `backup` result contains a snapshot path and manifest, including SHA-256, file size, table row counts and schema version. Its paired `${BACKUP_FILE}.manifest.json` must be preserved with the `.db` file. `verify` compares the manifest, computes SHA-256 and runs `PRAGMA integrity_check`. A successful verification shows that the snapshot is readable and matches that manifest; it does not prove that any later restore has been exercised in an application. `restore` revalidates and copies to a **new** destination, then checks the copy. It will reject an existing `.db`, `-wal`, `-shm` or `-journal` at the destination. Start another instance with `--db "$RUN_DIR/restored.db"` only after confirming no conflicting server is listening on the chosen port.

If a private backup directory already exists with excessive group/other access or has another owner, `backup`/scheduled startup fails with `BACKUP_DIR_NOT_PRIVATE`. Fix filesystem ownership/mode outside the service; backup files and manifests are local, unencrypted and require protected storage. On startup, the scheduler verifies recent snapshot candidates until one passes checksum, schema and SQLite integrity; an invalid manifest alone never clears the stale-backup alert. Scheduled rotation deletes the oldest listed snapshot/manifest pairs beyond `--backup-keep`; it is **not** off-host replication. Interrupted worker operations may leave `.tmp-velance-*` files that require manual review; shutdown does not sweep other processes' temporary artifacts.

## Preview and apply retention

```bash
# Dry run: returns cutoff, number of eligible sessions and dependent row counts.
node tools/ops/operations.mjs retention --db "$RUN_DIR/review.db"

# Applies only to this disposable test database; first makes and verifies a backup.
node tools/ops/operations.mjs retention --db "$RUN_DIR/review.db" \
  --apply --backup-dir "$RUN_DIR/backups"
```

Rows are eligible when `received_at` is older than 30 days plus a five-minute guard. Deletion occurs in batches of at most 100 sessions, transactionally including samples, events and receipt rows. Result JSON reports deleted session count, before/after counts, orphan count and saved backup. Retention has **no background schedule**. The CLI rejects apply to the repository's real `tools/ops/telemetry.db` unless `--allow-real-db` is explicitly present; do not use that override for tests or routine review. This CLI safeguard does not replace backup policy, access control or operational approval.

## Inspect health, load and incidents

| Observation | Meaning / immediate local check |
| --- | --- |
| `/health/live` 200, `/health/ready` 503 | HTTP event loop responds, but server is draining or DB worker is unavailable. Inspect JSON logs for `db_worker_failed` and `shutdown_start`, then inspect `velance_db_worker_up` / `velance_ready`. |
| `429 DB_QUEUE_FULL` or `429 UPLOAD_CAPACITY` | Queue/reservation admission limit; inspect `velance_db_queue_jobs`, `velance_db_queue_bytes` and `velance_upload_reserved_bytes` in `/metrics`. |
| `429 RATE_LIMIT` | Telemetry token bucket is exhausted; check request/ingest counters. The collector does not automatically retry failed fetches. |
| `503 DB_BUSY`, `DB_STORAGE_FAILURE`, `DB_UNAVAILABLE` or `DB_DEADLINE` | Contention, storage fault, dead worker or a query exceeding the 10-second deadline; inspect filesystem space, DB/WAL sizes, event-loop lag and worker gauges. |
| `velance_alert{alert="backup_stale"} 1` | With scheduling enabled, no recent backup under the two-hour threshold. Check `velance_backup_age_seconds`, `velance_backups_total`, `backup_failed` logs and private directory. |
| `velance_alert{alert="disk_pressure"} 1` | Observed filesystem usage exceeded 80%; inspect `velance_disk_free_bytes`, `velance_disk_size_bytes`, and ensure enough headroom for backup files. |
| `velance_alert{alert="queue_saturation"} 1` | Upload or worker queue usage reached 80% of a configured cap. Reduce local sender load and inspect worker responsiveness. |
| `velance_alert{alert="worker_down"} 1` | A DB worker is no longer healthy while not draining. Read logs; there is no automatic worker restart. |

The alert gauges only exist as scraped metrics; no built-in alert delivery is configured. Request logs are structured and have an allowlist, but are not persisted by a log service. Metrics counters reset at process restart. `GET /metrics` itself responds on the local interface only; protect the host since another local process may access it.

Proposed external Prometheus alert expressions (not installed or verified against a deployed scraper):

```promql
# Sustained unsuccessful telemetry responses including overload; target <=0.1% error budget.
sum(rate(velance_http_requests_total{route="/api/telemetry",status=~"429|5..|aborted"}[5m]))
  / clamp_min(sum(rate(velance_http_requests_total{route="/api/telemetry"}[5m])), 0.001) > 0.001

# Approximate latency quantiles from bounded server histograms; evaluate at 5-minute cadence.
histogram_quantile(0.95,
  sum by (le) (rate(velance_http_request_duration_seconds_bucket{route="/api/telemetry"}[5m]))) > 0.15
histogram_quantile(0.99,
  sum by (le) (rate(velance_http_request_duration_seconds_bucket{route="/api/telemetry"}[5m]))) > 0.30
histogram_quantile(0.95,
  sum by (le) (rate(velance_http_request_duration_seconds_bucket{route="/api/summary"}[5m]))) > 0.50

velance_event_loop_delay_p99_seconds > 0.050
velance_alert{alert="queue_saturation"} == 1
velance_alert{alert="backup_stale"} == 1
velance_alert{alert="disk_pressure"} == 1
velance_alert{alert="worker_down"} == 1
```

For service errors and latency, require sustained violation (for example, `for: 5m`) and a traffic-volume guard before paging in a future deployment. Histograms include rejected requests and use bucket approximations; these expressions cannot identify whether an overload-rejected body was valid, because admission occurs before payload parsing. A production SLO evaluator must track valid offered requests and failed/timeout responses from the load client or edge. No on-call, scrape target, rule evaluator or notification route is configured in P2.

HTTP status conventions: invalid JSON/shape/window/cursor is typically `400`, cross-origin `403`, unknown resource `404`, wrong method `405`, telemetry >262,144 bytes `413`, unsupported content/encoding `415`, overload `429`, DB problems `503`, and summary >1,000,000 samples `422`. Known method errors include `Allow`; retryable 429/503 include `Retry-After: 1`.

## Boundaries / unfinished work

This is a local proof of backend behavior. No external uptime monitor, metrics scrape/alert rule deployment, TLS/authentication, remote access, automated retention cadence, encrypted/off-host backups or disaster-recovery drill is included. Browser/GPU QA and production hardening must be separately tested before any publishing decision. The showroom's asset licensing also blocks public deployment. Source of truth for implementation: `tools/ops/server.mjs`, `db-worker.mjs`, `store.mjs` and `operations.mjs`.
