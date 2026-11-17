# VELANCE Fleet Operations — P2 backend system design

Status: **local-only implementation**. This document describes the interfaces and behavior in `tools/ops/` as implemented, not a deployment certification or a future-service specification. For commands and incident handling see [backend operations](backend-operations.md).

## Scope and data path

```text
Showroom (src/telemetry/collector.js)
  HEAD /index.html  → X-Velance-Ops: 1 feature probe
  POST /api/telemetry (best effort; opt-out available)
              │
              ▼
Node 24 HTTP server (tools/ops/server.mjs) ── GET /ops/ (static dashboard)
  host/origin checks, exact body cap, schema validation, admission control
  GET /health/live, /health/ready, /metrics
              │
          DB worker RPC (tools/ops/db-worker.mjs)
           ┌──┴──────────────────────┐
           ▼                         ▼
     writer worker              reader worker
      ingests + manual          summary, sessions,
      retention deletes         detail + retention preview
           └──────────┬──────────────┘
                      ▼
            SQLite WAL (tools/ops/store.mjs)
       sessions / samples / events / batches

Backup scheduler and CLI (tools/ops/operations.mjs)
  separate worker → native SQLite snapshot → SHA-256 manifest
  verify / restore-to-new-path / retention-after-backup
```

The server serves a small public-file allowlist, the showroom, `/ops/`, and its own APIs. Direct static serving with `python3 -m http.server` does not provide telemetry, the dashboard API, health, or metrics. `ops/ops.js` fetches summary and paginated session data from the same origin. Runtime dependencies are Node built-ins; the server uses `node:sqlite` and worker threads.

The default listening interface is `127.0.0.1:8090`; only `127.0.0.1`, `localhost`, and `::1` may be specified as hosts. The server verifies that the request Host matches its listening port; foreign/null Origin and cross-site Fetch Metadata are rejected. These checks do **not** authenticate another process or tab on the same machine. There is no account authentication, TLS termination, proxy trust policy or remote exposure design.

## HTTP contract

All error responses use `{ "error": "CODE", "code": "CODE" }` unless the connection has already closed. `429` and `503` errors include `Retry-After: 1`; `405` includes `Allow`. Successful JSON responses use `Cache-Control: no-store` and `X-Request-Id` is attached to responses. `/metrics` uses Prometheus text exposition format `0.0.4`.

| Method / route | Current behavior |
| --- | --- |
| `POST /api/telemetry` | `application/json` (optional UTF-8 charset), no compressed bodies; exact **262,144-byte** limit, UTF-8 JSON, strict batch validation, transactional insert and receipt dedupe. Returns `{ "ok": true }` for new and duplicate receipts. |
| `GET /api/summary?hours=24` | Cohort by session start time; accepts `hours=1`, `6`, `24` (default 24) **or** integer Unix-millisecond `from` and `to`, `from < to`, at most 31 days. Returns totals, backend/device split, load percentiles, phases, errors, trend, window. |
| `GET /api/sessions?limit=50&cursor=...` | `limit` integer 1–200, default 50; newest receipt first; returns a JSON array, with an opaque next page in `X-Next-Cursor` when present. |
| `GET /api/sessions/:id?samples=...&events=...` | Session detail plus ascending presentation of up to 2,000 samples and 500 events; opaque older-page cursors and totals under `page`. |
| `GET /health/live` | HTTP 200 `{ "status": "live" }` if the HTTP handler responds, irrespective of worker readiness. |
| `GET /health/ready` | HTTP 200 `{ "status": "ready" }` only when not draining and both DB workers are healthy; otherwise HTTP 503 `{ "status": "unavailable" }`. |
| `GET /metrics` | Process-local counters, gauges, histograms and alert conditions, refreshed on scrape; no remote push. |
| `GET` or `HEAD` static paths | Canonical, in-root allowlist for the showroom, dashboard, vendored runtime, selected assets and render harness. Denies dotfiles, DB/sidecars/backups, symlink escapes and unknown types. |

Request JSON is validated as a whole. Required batch fields include `id` (8–64 allowed alphanumeric/hyphen characters), safe nonnegative integer `seq`, `startedAt`, `milestones` object, and the `samples`/`events` arrays. Allowed backends are `webgpu`, `webgl2`, `images`. Milestones are `gateShown`, `enter`, `firstFrame`, `firstCar`, `allLoaded`; an unknown time is `null`. There are caps of 2,000 samples, 500 events, 64 `loadTimes` and at most 512 UA / 300 error-message characters. Numbers must be finite and nonnegative; defined counters and times are safe integers. The collector emits smaller approximately 48 KiB batches, but the server cap is larger to handle bounded requests. Failed validation does not partially import a batch.

## Persistence and ordering

SQLite schema `PRAGMA user_version=2` has four tables: `sessions` keyed by session ID; `samples` keyed by `(session_id,t)`; `events` keyed by `(session_id,t,type)`; and `batches` keyed by `(session_id,seq)` for persistent receipt deduplication. Ingestion inserts session, unique samples/events and receipt together in a single transaction (`BEGIN IMMEDIATE` / commit or rollback). A duplicate receipt is acknowledged without rewriting stored data. Previously observed session start/context are immutable, new out-of-order receipts can add samples/events, and an older `seq` cannot regress newer metadata. Null stats cannot erase known load times. New first receipts with a start more than 30 days old or more than five minutes ahead are rejected.

The writer worker handles ingestion; the read-only worker handles summary/session reads. Work is serialized inside each worker, with a per-worker reservation and a 10-second job deadline. Current caps are **128 jobs / 8 MiB** for writer, **16 jobs / 64 KiB** for reader; overfull queues return `429 DB_QUEUE_FULL`. An expired request remains reserved until that worker finishes or exits. Telemetry has an additional 100-token burst, approximately 50 requests/second refill, and a global **16 MiB** in-flight upload reservation (larger bodies rejected before JSON parsing). Failure of either worker makes readiness false; there is no automatic worker restart.

Summary windows are cached in memory for 15 seconds with up to eight keys and coalescing of in-flight identical requests. A summary containing more than **1,000,000** samples fails with `422 WINDOW_TOO_LARGE`. Percentiles select the sorted value at `min(n-1, floor(q*n))` without interpolation; unknown observations are excluded from known-value counts. The dashboard treats absent values as missing, not zero.

## Observability and maintenance

`tools/ops/operations.mjs` supplies allowlisted JSON-line process/request logging, Prometheus metrics, and isolated maintenance tasks. Request logs cover errors/aborts or latency at least 300 ms; the rate limiter prevents unlimited logging. The logger does not serialize telemetry payloads, session IDs, request headers or browser URLs. Counters and histograms are in-process and reset on service restart; logs are not a durable audit trail.

Metric families include `velance_http_requests_total`, `velance_http_request_duration_seconds`, `velance_http_rejections_total`, `velance_ingest_batches_total`, `velance_db_operations_total`, `velance_db_operation_duration_seconds`, `velance_summary_cache_total`, `velance_backups_total`, `velance_db_queue_jobs`, `velance_db_queue_bytes`, `velance_db_worker_up`, `velance_ready`, `velance_draining`, `velance_upload_reserved_bytes`, `velance_process_resident_memory_bytes`, `velance_event_loop_delay_p99_seconds`, disk/DB/WAL size, backup age, and `velance_alert{alert="..."}`. Label cardinality is capped at 2,000 distinct series; rejected series increment `velance_metrics_series_dropped_total`.

Built-in alert flags are only gauges, **not notifications**: `queue_saturation` fires at 80% of upload reservation or any worker queue cap; `backup_stale` when scheduling is enabled and the newest **verified** local backup timestamp is more than two hours old (or absent); `disk_pressure` when observed volume use is over 80%; `worker_down` if a database worker fails while the server is not draining. No metrics scraper or alert dispatcher is included. At startup, a separate operations worker checks existing snapshots, newest first, against the manifest, checksum, schema and SQLite integrity before treating a backup as recent. This does not verify every historical snapshot or establish off-host recoverability.

Scheduled backups are **opt-in** with `--backup-dir`: approximately hourly by default; native SQLite snapshot written to a private (`0700`) directory with file permissions `0600`, a SHA-256 + table-count + schema-version manifest, and default retention of the 168 newest snapshots. Initial backup is scheduled shortly after start if none is recent. `verify` checks digest, SQLite integrity and manifest metadata; `restore` writes an independently checked copy **only at a destination that does not already exist**. The migration from older schema versions automatically writes a local `.pre-v2-...bak` before schema changes. Retention of telemetry rows is **manual only**: preview is read-only; apply requires backup directory, creates/verifies a snapshot, and deletes sessions older than approximately 30 days in bounded transactions with their dependents.

## Explicit gaps and limits

- Data collection remains automatic only when served by the ops origin; users can opt out via `?notelemetry` or localStorage. It is best-effort; it can drop samples on queue overflow, tab close or network failures. Privacy filters are not complete anonymization; persistent device/UA and truncated errors can identify a person.
- The source repository has no configured off-host backups, automated telemetry retention schedule, alert delivery, multi-process coordination or production access controls. Backup manifests are integrity evidence, not cryptographic signatures or a disaster-recovery service-level guarantee.
- Native tests and syntax checks establish local code behavior only. Real-browser GPU journeys, load/performance measurements, and deployment/CI gates are distinct tasks; none are implied by the P2 local check.
- This file describes current P2 behavior as inspected in source. Changes to limits, schema, API or maintenance commands require a corresponding update to these docs and their native test coverage.
