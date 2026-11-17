# P6 — Private staging vận hành, backup và sự cố

Các lệnh dưới đây **chỉ dùng dữ liệu fixture**; không chỉ định real `tools/ops/telemetry.db`. Xem [P5 operations](p5-operations.md), [P5 capacity](p5-capacity-cost.md) và [`tools/ops/operations.mjs`](../tools/ops/operations.mjs).

## Safe runbook local

Node ≥24 (`/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node` trên máy nghiệm thu); kiểm tra `node --version`.

```bash
node tools/p6/check.mjs --mode native
# Tạo file evidence chưa tồn tại; tuyệt đối không ghi đè report cũ.
node tools/p6/check.mjs --mode evidence --out tools/perf/results/p6-local-acceptance.json
node tools/p5/check.mjs --mode native
git diff --check
```

`tools/p6/check.mjs` xác minh cấu hình fail-closed, SHA của 96 asset, P6 negative HTTP tests và P4→P3→P2 native regression. **Không chạy server Ops từ repo mặc định** (vì CLI mặc định dùng real DB). Khi cần manual fixture, dùng đường dẫn tạm tự tạo bằng `mktemp -d`, đích DB ở trong temp, `--host 127.0.0.1 --db "$tmp/fixture.db" --backup-dir "$tmp/backups"`; backup dir cần `chmod 700`. Chỉ sử dụng ports loopback, shutdown `SIGTERM` sau smoke, không để các service mở qua máy khác. Các test P2 `tools/ops/test/recovery.mjs` đã có fixture backup/restore với checksum, counts, SIGKILL/replay, database integrity và không orphan.

## Private staging provider runbook (chưa triển khai)

1. **Prepare:** operator phê duyệt budget, fixture rights, private account/VPC, TLS, DNS, WAF, private CDN origin identity, IdP, private Ops. Runtime run as non-root, read-only root/release, write-only dedicated DB/backup volume, secrets manager, firewall localhost socket. `config/p6/private-staging.json` là contract kiểm tra, không có lệnh deploy.
2. **Release:** từ clean checkout có pinned deps: P2/P3/P4/P5/P6 checks, SBOM/vulnerability/license gates, sha manifest release, verify immutable object bytes. Chỉ upload synthetic/owned staging assets. Đặt release mới dưới SHA prefix; verify edge PoP GET/HEAD/ETag/304, query canonical, deny-origin; sau đó canary mới được đổi active pointer, 307 no-store. Rollback atomically tới release cũ, không rewrite bytes của SHA cũ. Capture timestamps, approved operator và release id.
3. **Backup:** SQLite local backup snapshots/manifest+SHA/integrity, encrypt trước off-host, store ngoài host/account (SSE-KMS riêng và TLS), upload bằng service account tối thiểu quyền và không cấp delete cho app. Bucket retention/immutability và backup key rotation: quản lý bởi SRE/Security. Local backup scheduler **không tự biến thành encrypted off-host backup**.
4. **Restore drill:** trên máy/môi trường cách ly, tải encrypted snapshot, decrypt qua IAM hợp lệ, xác minh SHA/manifest, SQLite `PRAGMA integrity_check` và row counts, hồi phục writer/reader, gửi POST fixture, kiểm tra no orphan. Ghi duration/RTO, mốc snapshot→recovery/RPO, xác nhận receipt consistency và backfill; chỉ đánh `PASS_PROVIDER` khi independent host + encryption/key separation và IAM denial đã được ghi nhận.
5. **Monitoring:** scrape `GET /health/ready`, `GET /metrics` **qua mạng nội bộ**, không expose public. Alerts đề xuất: `velance_ready == 0`, `velance_db_worker_up{role=...} == 0` trong 2 phút; `velance_alert{alert="queue_saturation"} == 1`, `{alert="backup_stale"} == 1`, `{alert="disk_pressure"} == 1`; 429/503 growth; RSS, event loop p99, WAL bytes, backup-age và CDN 5xx/cache byte hit ratio. Ngưỡng và on-call/pager chưa được ký/phát thử ⇒ `NOT_CONFIGURED`.

## Incident matrix

| Tình huống | Phát hiện | Hành động điều tra/giảm thiểu | Điều kiện trở lại |
| --- | --- | --- | --- |
| CDN origin 403/5xx | edge 5xx và negative direct-origin | khóa canary, kiểm tra identity ACL/TLS, rollback active SHA | provider logs + PoP smoke green |
| Telemetry 429 | rate/rejection metrics | giảm client rate, retry bounded; không mở rộng quota thiếu budget | p95 + error budget đạt ngưỡng |
| DB 503/worker down | ready/worker gauges | dừng telemetry ingress, không chuyển writer thiếu fencing; isolated restore nếu hỏng | integrity, ACK replay và snapshot pass |
| WAL/disk đầy | disk/WAL/queue gauges | dừng write có kiểm soát, tăng persistent volume theo change review; giữ backup | storage headroom verified |
| Backup stale/offsite unreachable | backup-age, deliverability | kiểm tra scheduler/key/bucket/network; không coi local backup đủ DR | offhost encrypted restore drill pass |
| Credential leaked/IdP bypass | IAM/edge audit | revoke token/rotate key, đóng admin ingress, mở incident security | deny/role tests và audit pass |
| Traffic surge/cost | edge rate, bandwidth, cost alert | WAF rate controls, suspend prefetch, pause rollout | quota/budget signed |
| License complaint | asset content audit | unpublish affected release/asset; legal triage và freeze rollout | Legal signoff |

Incident severity/contacts chưa có owner và số điện thoại xác nhận. Không sử dụng danh sách fictitious on-call. RPO/RTO chưa được owner chấp nhận; fixture local không đo RTO production. Thử alert delivery đến người chịu trách nhiệm trước G3.
