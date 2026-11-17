# VELANCE P5 — Runbook local, QA, release và xử lý sự cố

**Mục đích:** bàn giao một quy trình **có thể lặp lại trên máy cá nhân**, kiểm chứng những cơ chế đã đạt P2/P3/P4 Extended mà **không đụng database thật, không public model, không deploy**. Đây **không** phải playbook đã nghiệm thu cho CDN/cloud provider. Ngày lập: **17/11/2026**; môi trường nghiệm thu được ghi trong [P4 Extended Acceptance](../tools/perf/results/p4-extended-acceptance.json), verdict **`PASS_LOCAL`**.

Xem [P5 kiến trúc](p5-system-design.md), [P2 vận hành](backend-operations.md), [P3 release runbook](delivery-operations.md), [P4 capacity plan](p4-capacity-plan.md), [P4 runbook](p4-operations.md), [P4 acceptance](p4-acceptance.md). Danh sách tài sản và tình trạng quyền: [P5 asset rights register](p5-asset-rights-register.json) (**16 GLB +80 WebP: UNVERIFIED**, public release **BLOCKED**).

## 0. Quy tắc an toàn trước mọi thao tác

- Chạy từ **repository root `VELANCE`**, macOS/Linux shell, **Node.js 24+**. Các ví dụ `curl`, `node`, `mktemp` chỉ chạy ở **`127.0.0.1`**; không sửa `README.md`, source, GLB/WebP, CI, P2/P3/P4 gates hoặc script QA.
- **KHÔNG dùng** `tools/ops/telemetry.db`, `tools/ops/telemetry.db-wal`, `-shm`, DB của công ty, cloud DB hoặc thư mục backup thật. Chỉ dùng thư mục riêng tạo bằng `mktemp` dưới `/tmp`. Không chạy dữ liệu thật để “thử nhanh”.
- **KHÔNG** mở port ra `0.0.0.0`, cấu hình tunneling, CDN DNS, reverse proxy public, bucket public hoặc upload snapshots/assets. Backup/manifest local vẫn chứa dữ liệu không mã hóa.
- Mọi file report `--out` tạo mới; không ghi đè `tools/perf/results/*` đã dùng làm evidence. Lượt test P4 có thể nặng CPU/GPU; không chạy đồng thời với browser GPU QA nếu cần so sánh frame time.
- Trước khi quảng bá public: legal provenance/license cho từng GLB/WebP, SSO Ops, private origin ACL, TLS/WAF, encrypted offsite backups, restore drill khác host, external monitoring và incident owner **đều chưa đạt**.

## 1. Kiểm tra môi trường và chất lượng native (không seed nặng)

~~~bash
# Terminal tại thư mục VELANCE:
node --version                   # >= v24
git status --short               # kiểm tra thay đổi hiện có, không tự reset

# Native gates; không tự chạy benchmark 60s/30 ngày hay Chrome.
node tools/ops/check.mjs
node tools/delivery/check.mjs
node tools/perf/p4_check.mjs

# Các test nhỏ P4 backend/mixed; đều dùng database fixture tạm:
node --test tools/perf/test/backend_load.mjs
node --test tools/perf/test/p4_mixed_soak.mjs
~~~

**Nguồn số liệu không cần chạy lại benchmark:** [P4 Extended Acceptance JSON](../tools/perf/results/p4-extended-acceptance.json) có `result=PASS_LOCAL`, [P4 raw native TAP](../tools/perf/results/p4-native-extended.tap) có **16/16 P4 native**; [P3 native](../tools/perf/results/delivery-p3-native.tap) **24/24**; [P2 native](../tools/perf/results/delivery-p3-p2-regression.tap) **30/30**. **Không** cộng 16+24+30 thành 70 “real-user tests”; đó là các bộ native khác nhau.

Nếu native gate fail: giữ stdout/stderr/TAP, ghi Node version, không chuyển qua bước publish. Không sửa code trong production chỉ để ép gate PASS.

## 2. Khởi tạo workspace tạm và snapshot public đúng allowlist

~~~bash
# Terminal A, ở repository root. Sao lưu lại giá trị P5_DIR được in ra.
P5_DIR="$(mktemp -d /tmp/velance-p5.XXXXXX)"
chmod 700 "$P5_DIR"
mkdir "$P5_DIR/store" "$P5_DIR/private-backups"
chmod 700 "$P5_DIR/store" "$P5_DIR/private-backups"
printf 'P5_DIR=%s\n' "$P5_DIR"

# Snapshot đọc source public trên ổ đĩa; ghi bản copy chỉ vào P5_DIR.
node tools/delivery/release.mjs snapshot \
  --source-root . --store-dir "$P5_DIR/store" > "$P5_DIR/snapshot.json"

# Lấy ID thật từ JSON; không tự đoán ID release.
RELEASE_ID="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).id" "$P5_DIR/snapshot.json")"
printf 'RELEASE_ID=%s\n' "$RELEASE_ID"

node tools/delivery/release.mjs verify \
  --store-dir "$P5_DIR/store" --id "$RELEASE_ID"
node tools/delivery/release.mjs activate \
  --store-dir "$P5_DIR/store" --id "$RELEASE_ID"
~~~

**Expected:** ID là 64 ký tự SHA-256 hex, `verify` thành công, `active.json` trỏ vào ID vừa kích hoạt. Snapshot local đã được kiểm tra file size/hash và path allowlist; **vẫn không được public** do rights register chưa xác minh. Không chỉnh một byte nào trong `$P5_DIR/store/releases/$RELEASE_ID/`. Nếu source thay đổi, snapshot mới phải nhận ID mới, không ghi đè bản cũ.

**Shell variables không tự đi qua terminal khác:** ở Terminal B/C, đặt lại `P5_DIR` bằng đường dẫn tuyệt đối thực tế Terminal A đã in; đừng copy dấu `<...>` hoặc đoán thư mục.

## 3. Chạy và dừng các dịch vụ local

### A. Preview public-surface **không có** telemetry (Terminal B)

~~~bash
# Terminal B — copy chính xác đường dẫn ở Terminal A:
P5_DIR='/tmp/velance-p5.REPLACE_WITH_ACTUAL_DIRECTORY'

node tools/delivery/server.mjs \
  --host 127.0.0.1 --port 8081 --store "$P5_DIR/store"
~~~

Truy cập `http://127.0.0.1:8081/` → **307 `no-store`** tới `/r/RELEASE_ID/index.html`. Asset immutable GET/HEAD được phục vụ, nhưng preview không có upstream: **không có telemetry collector capability**, `/api/telemetry` và `/ops/` không được xuất bản. Địa chỉ 8081 là mô phỏng **public surface**, không phải CDN/PoP thật.

### B. Private Ops backend trên DB fixture (Terminal C)

~~~bash
P5_DIR='/tmp/velance-p5.REPLACE_WITH_ACTUAL_DIRECTORY'

node tools/ops/server.mjs \
  --host 127.0.0.1 --port 8090 \
  --db "$P5_DIR/ops-fixture.db" \
  --backup-dir "$P5_DIR/private-backups" --backup-keep 24
~~~

Endpoint local private: `http://127.0.0.1:8090/ops/`, `/health/live`, `/health/ready`, `/metrics`, `/api/summary`, `/api/sessions`, `/api/sessions/:id`. Database chỉ là `$P5_DIR/ops-fixture.db`. `--backup-dir` bật scheduler backup định kỳ khoảng một giờ; `--backup-keep 24` là **24 bản snapshot**, không phải 24 giờ. Không có retention tự động.

### C. Preview có POST-only proxy telemetry (Terminal D)

~~~bash
P5_DIR='/tmp/velance-p5.REPLACE_WITH_ACTUAL_DIRECTORY'

node tools/delivery/server.mjs \
  --host 127.0.0.1 --port 8082 --store "$P5_DIR/store" \
  --upstream http://127.0.0.1:8090
~~~

Ở preview 8082, chỉ **`POST /api/telemetry`** được chuyển sang Node private 8090. Không expose `/ops/`, `/api/summary`, `/api/sessions`, `/metrics`. Header `X-Velance-Ops: 1` chỉ có trên **HTML document**, không trên GLB/JS và không khi upstream chưa được cấu hình. Không có proxy URL do browser cung cấp.

**Dừng:** nhấn **Ctrl+C** riêng ở Terminal B, C, D. Ops thực hiện drain và đóng DB workers; preview đóng listener. Khi chạy dạng background do người vận hành tự thiết lập, gửi `SIGTERM` vào **PID đúng** rồi kiểm tra process đã thoát; không dùng `pkill node` hoặc kill cả máy. Dừng preview trước, dừng Ops backend sau, giữ snapshot/backup cho tới khi đối chiếu xong.

## 4. HTTP release smoke — kiểm tra giao thức, cache và denial

~~~bash
# Terminal A vẫn có RELEASE_ID và P5_DIR.
BASE='http://127.0.0.1:8081'
V2='http://127.0.0.1:8082'
DOC="$BASE/r/$RELEASE_ID/index.html"
JS="$BASE/r/$RELEASE_ID/src/ui/app.js"

# Active alias: 307 + Location /r/ID/index.html + Cache-Control no-store.
curl -sSI "$BASE/"

# Immutable release document: 200, immutable, Vary, ETag identity.
curl -sSI -H 'Accept-Encoding: identity' "$DOC"

# JS encoded response: inspect Content-Encoding, Content-Length, ETag.
curl -sSI -H 'Accept-Encoding: br' "$JS"

# ETag identity từ chính resource đang thử, sau đó conditional HEAD = 304.
ETAG="$(curl -sSI -H 'Accept-Encoding: identity' "$JS" | awk 'tolower($1)=="etag:"{gsub("\r","",$2);print $2}')"
test -n "$ETAG"
curl -sSI -H 'Accept-Encoding: identity' -H "If-None-Match: W/$ETAG" "$JS"

# Không chấp nhận bất cứ encoding nào -> 406.
curl -sSI -H 'Accept-Encoding: identity;q=0,br;q=0,gzip;q=0' "$JS"

# Không được lộ private endpoints qua preview (không upstream).
curl -sS -o /dev/null -w 'ops=%{http_code}\n' "$BASE/ops/"
curl -sS -o /dev/null -w 'summary=%{http_code}\n' "$BASE/api/summary"
curl -sS -o /dev/null -w 'metrics=%{http_code}\n' "$BASE/metrics"

# Khi có upstream ở 8082, GET telemetry sai method phải là 405.
curl -sS -o /dev/null -w 'telemetry GET=%{http_code}\n' "$V2/api/telemetry"

# GLB/WebP kiểm tra qua HEAD, không dump binary ra terminal.
curl -sSI "$BASE/r/$RELEASE_ID/vendor/basis.wasm"
~~~

**Expected:** alias **307**, release GET/HEAD **200**, weak conditional matching ETag cùng representation **304** (body rỗng), tất cả encoding bị từ chối **406**, `ops/summary/metrics` trên 8081 **404**, GET telemetry trên 8082 **405**. JS `br` có ETag khác JS `identity`; không so chúng là cùng entity tag. URL versioned giữ `public, max-age=31536000, immutable`; GLB/WASM identity. Không kỳ vọng `206 Range` vì local preview chưa triển khai.

Đối với binary GLB mẫu, thay path bằng **đường dẫn thật có trong `$P5_DIR/snapshot.json`**. Đừng tự suy ra tên xe rồi chấp nhận 404 là PASS. Kiểm tra HTTP 200 đủ bytes/SHA của tài sản bằng native P3/P4 harness thay vì `curl | head`.

## 5. Mock/dev telemetry trên fixture — không tạo dữ liệu người dùng thật

~~~bash
# Trong Terminal A; đảm bảo backend 8090 + preview 8082 đều đang chạy.
curl -sS -i http://127.0.0.1:8090/health/live
curl -sS -i http://127.0.0.1:8090/health/ready

NOW_MS="$(node -p 'Date.now()')"
cat > "$P5_DIR/fixture-post.json" <<JSON
{
  "id": "p5-smoke-0001",
  "seq": 0,
  "startedAt": $NOW_MS,
  "backend": "webgl2",
  "milestones": {"gateShown": 0, "firstCar": 100, "allLoaded": 300},
  "samples": [
    {"t": 0, "phase": "browse", "fps": 60, "loaded": 16},
    {"t": 1000, "phase": "browse", "fps": 59, "loaded": 16},
    {"t": 2000, "phase": "overview", "fps": 58, "loaded": 16}
  ],
  "events": [{"t": 3000, "type": "overviewBtn"}]
}
JSON

# Browser-equivalent flow: POST qua preview, sau đó replay y nguyên payload.
curl -sS -i -H 'Content-Type: application/json' \
  --data-binary "@$P5_DIR/fixture-post.json" \
  http://127.0.0.1:8082/api/telemetry
curl -sS -i -H 'Content-Type: application/json' \
  --data-binary "@$P5_DIR/fixture-post.json" \
  http://127.0.0.1:8082/api/telemetry

# Đọc từ PRIVATE origin 8090, không từ 8081/8082.
curl -sS 'http://127.0.0.1:8090/api/summary?hours=24'
curl -sS 'http://127.0.0.1:8090/api/sessions?limit=50'
curl -sS 'http://127.0.0.1:8090/api/sessions/p5-smoke-0001'
~~~

**Expected:** hai POST trả **200 `{"ok":true}`**, nhưng `batches` chỉ có **một receipt `(p5-smoke-0001, 0)`**; session giữ đúng 3 samples, 1 event. `/api/sessions/:id` đọc từ Ops private origin; client public tuyệt đối không được gọi endpoint này.

Với fixture chưa ghi dữ liệu, Ops dashboard phải hiển thị cohort rỗng; **không tự gắn số đo P4 vào DB**. Dev/demo không được ngầm kết nối `tools/ops/telemetry.db`.

## 6. QA định lượng theo thứ tự, tránh trộn benchmark

| Nhóm | Lệnh / evidence | Điều gì chứng minh |
| --- | --- | --- |
| P2 API correctness | `node tools/ops/check.mjs` | Contract, SQLite, receipt, rollback, backup, guards, failure handling (30/30 native tại acceptance) |
| P3 static protocol | `node tools/delivery/check.mjs` | Snapshot allowlist, verify, immutable GET/HEAD, ETag 304, rollback, private route isolation (24/24 P3 native) |
| P4 native tổng hợp | `node tools/perf/p4_check.mjs` | Syntax/native P4 (16/16 ở raw extended) + P3/P2 regression; không tự chạy 60s/browser |
| Mixed smoke fixture | `node tools/perf/p4_mixed_soak.mjs --smoke --out "$P5_DIR/p4-mixed-smoke.json"` | 3s, 10 POST/s, reads, verified concurrent backup, isolated SIGKILL/replay sau ACK |
| Mixed sustained đã nghiệm thu | [P4 60s raw](../tools/perf/results/p4-mixed-soak-60s-3day.json) | 3-day 900k seed, 600/600 offered ACK, 270/270 reads, 451 receipts sau fault, SQLite ok/orphan 0 |
| Real assets / virtual | [Raw virtual 10/25/50/100](../tools/perf/results/p4-real-asset-virtual-10-25-50-100.json) | Real 16 GLB +5 WebP/visit, 304/bytes/hash; **không** phải 100 browsers |
| Chrome multi-tab | [WebGPU 4 tabs](../tools/perf/results/p4-multitab-webgpu-4.json), [WebGL2 4 tabs](../tools/perf/results/p4-multitab-webgl2-4.json) | Tổng cộng 8 tabs cùng GPU, 16 GLB/tab, không phải 8 thiết bị |
| Extended verdict | [P4 Extended Acceptance](../tools/perf/results/p4-extended-acceptance.json) | Verdict `PASS_LOCAL`, nguồn raw, danh sách production còn `NOT_VERIFIED` |

**Chỉ khi được phê duyệt một lượt đo tách khỏi GPU benchmarks**, mới chạy 60s trên fixture mới và report mới:

~~~bash
# Nặng hơn smoke: 3.000 seeded sessions / 900.000 samples, 60s 10 POST/s.
node tools/perf/p4_mixed_soak.mjs --duration 60 --rate 10 --days 3 \
  --out "$P5_DIR/p4-mixed-60s-new.json"

# Probe real asset virtual HTTP, 1 client smoke, không mở Chrome; chỉ local.
node tools/perf/p4_user_journeys.mjs --users 1 --images 0 \
  --concurrency 2 --out "$P5_DIR/p4-asset-one-client.json"
~~~

Lệnh P4 soak tạo DB temp, tự kiểm tra receipt/backup/restart rồi cleanup. Nó **cố ý SIGKILL child fixture sau khi toàn bộ steady requests settle**, không giết private Ops đang chạy ở 8090. Không bao giờ gửi SIGKILL vào PID đang phục vụ dữ liệu thật. Với profile 100 POST/s trước đó, HTTP **429 `RATE_LIMIT` là expected overload**, tỷ lệ thành công theo offered **không thể** được ghi là 99,9%; xem [P4 acceptance](p4-acceptance.md).

**Ngưỡng local giữ nguyên:** valid offered success ≥99,9%; arrival-to-ACK p95 ≤150ms, p99 ≤300ms; complete read p95 ≤500ms; RSS ≤512MiB; event-loop sampled p99 ≤50ms; SQLite integrity `ok`, orphan=0, 100% ACK receipts tồn tại. Không sử dụng profile 60s để cam kết 99,9% uptime/tháng.

## 7. Backup, retention và restore — luôn thao tác trên fixture

~~~bash
# DB fixture đang chạy trên 8090. Backup SQLite online hợp lệ khi còn writes.
node tools/ops/operations.mjs backup \
  --db "$P5_DIR/ops-fixture.db" --dir "$P5_DIR/private-backups" \
  > "$P5_DIR/manual-backup.json"

BACKUP_FILE="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).file" "$P5_DIR/manual-backup.json")"

node tools/ops/operations.mjs verify --file "$BACKUP_FILE"

# Restore sang đường dẫn MỚI; từ chối file/sidecar đã tồn tại.
node tools/ops/operations.mjs restore \
  --file "$BACKUP_FILE" --to "$P5_DIR/restored-fixture.db"

# Retention preview chỉ đọc, hiển thị eligible; không apply trong QA smoke.
node tools/ops/operations.mjs retention --db "$P5_DIR/ops-fixture.db"
~~~

Snapshot backup phải đi cùng `.manifest.json`, private directory `0700`/file `0600`; checksum/SQLite integrity là bằng chứng snapshot được kiểm chứng, **không phải off-host recoverability**. Không restore ghi đè `ops-fixture.db` khi server đang chạy. Khi cần test retention apply, chỉ trên fixture đã backup và verify; lệnh chi tiết tại [P2 backup/retention runbook](backend-operations.md).

Trước production cần định nghĩa và thử **RPO/RTO đo được** trên máy khác, snapshot retention phù hợp dữ liệu, mã hóa ở rest/transit, key management, replication/DR và quyền truy cập backup. P2 chỉ có backup local tự chọn, không có auto retention sessions.

## 8. Release activation / rollback — phân biệt với rollback database

~~~bash
# Đã có RELEASE_ID là active trong store local.
node tools/delivery/release.mjs verify \
  --store-dir "$P5_DIR/store" --id "$RELEASE_ID"

# CHỈ khi tồn tại second snapshot khác ID đã verify, có thể activate:
# RELEASE_NEXT='<64-hex-id-from-another-verified-local-snapshot>'
# node tools/delivery/release.mjs activate \
#   --store-dir "$P5_DIR/store" --id "$RELEASE_NEXT"

# CHỈ sau khi active đã chuyển và có previous hợp lệ:
# node tools/delivery/release.mjs rollback --store-dir "$P5_DIR/store"
# curl -sSI http://127.0.0.1:8081/
~~~

Lặp lại `snapshot` từ **source không đổi** tạo cùng ID; không tạo “version mới” giả chỉ để thử rollback. Muốn QA switch/rollback hoàn toàn tự động trên **synthetic fixture**, dùng:

~~~bash
node tools/perf/release_switch.mjs
~~~

**Expected:** `/` redirect sang active ID (sau rollback quay về previous); `/r/OLD/...` và `/r/NEW/...` vẫn tồn tại; không purge/overwrite các snapshot đang có tab sử dụng. Nếu `rollback` không có previous, đó là **điều kiện không thỏa**, không ghi PASS. Rollback **chỉ đổi static release pointer**; lỗi dữ liệu hay writer không được “khắc phục” bằng rollback HTML/GLB.

Khi có CDN thật cần xác nhận redirect/no-store ở edge, object origin private, versioned retention, propagation, stale cache và rollback kiểm thử từ nhiều PoP. Chưa đủ điều kiện công bố cloud release.

## 9. Theo dõi, cảnh báo và phân loại incident

~~~bash
# Local private origin; không đặt /metrics lên preview public.
curl -sS -i http://127.0.0.1:8090/health/live
curl -sS -i http://127.0.0.1:8090/health/ready
curl -sS http://127.0.0.1:8090/metrics \
  | grep -E '^velance_(ready|db_worker_up|db_queue_jobs|process_resident_memory_bytes|backup_age_seconds|alert)'
~~~

Các metric/alert hiện chỉ xuất ra text trên localhost, **không tự gửi mail, Slack, pager, webhook**. Doanh nghiệp cần scrape target, retention metrics, alert rules, notification, bảo mật và owner trước production.

### Incident matrix — triệu chứng → xác minh → hành động giới hạn

| Hiện tượng / HTTP | Chẩn đoán bằng chứng | Xử lý an toàn / không được làm |
| --- | --- | --- |
| `/` 503 `RELEASE_NOT_ACTIVE` | Store không có active pointer | Verify snapshot đã tạo, activate ID có manifest hợp lệ; không sửa trực tiếp `active.json` |
| `/r/ID/...` 404 | URL sai, không có file allowlist hoặc release bị dọn | Đối chiếu ID/path với manifest; không nới allowlist để trả source/private file |
| `/r/ID/...` 503 `RELEASE_MISMATCH` | Byte size/hash sai sau snapshot | Ngừng publish, xác minh manifest/source; tạo snapshot **mới** hoặc rollback active, không sửa file trong immutable release |
| 304 trả sai ETag / encoding | Key khác nhau theo identity/br/gzip; Vary sai | Kiểm tra ETag, `Vary: Accept-Encoding`, body length, conditional GET/HEAD; không xóa cache toàn cục tùy tiện |
| 406 `NOT_ACCEPTABLE` | Client đặt q=0 cho mọi representation | Kiểm tra header `Accept-Encoding`; không thay response giả 200 |
| POST 413 `PAYLOAD_TOO_LARGE` | Body vượt **256KiB** | Client chia batch hợp lệ, không gửi mãi sau 413; không bỏ validation |
| POST 429 `RATE_LIMIT` / `DB_QUEUE_FULL` | Hết admission token hoặc worker queue | Ghi rate offered vs ACK, theo `Retry-After`, giảm tải và kiểm tra hàng đợi; không gọi 429 là “served successfully” |
| POST/API 503 `DB_UNAVAILABLE` | Writer/reader failed, shutdown hoặc storage | Kiểm tra `/health/ready`, worker-up, disk/WAL và logs; bảo toàn ACK, không auto xóa DB/WAL |
| Public telemetry 503 `UPSTREAM_UNAVAILABLE` | Preview proxy không kết nối private Node | Health private backend, đúng loopback upstream và port; không trỏ proxy qua public DB/dynamic URL |
| `/health/live` 200 nhưng `/health/ready` 503 | HTTP alive nhưng worker/draining không ready | Ngừng gửi traffic mới, chẩn đoán worker/DB; 200 live không chứng minh sẵn sàng ingest |
| `/api/summary` 422 `WINDOW_TOO_LARGE` | Cohort query >**1.000.000 samples** | Dùng cửa sổ 1/6/24h phù hợp, phân đoạn offline; đây là guard chủ đích, không phải dữ liệu bị mất |
| Dashboard `/ops/` 404 ở preview | Private endpoint bị deny đúng thiết kế | PASS isolation; vào 8090 local có quyền; **không mở** `/ops/` lên CDN public |
| `velance_alert{alert="backup_stale"}=1` | Không có verified backup mới dưới ngưỡng ~2h | Xem backup age, permissions, disk, worker failure; verify snapshot mới, sau đó diễn tập restore fixture |
| `velance_alert{alert="disk_pressure"}=1` hoặc disk đầy | Volume >80%, WAL/snapshot chiếm chỗ | Khảo sát capacity và retention theo policy, backup trước; không `rm` WAL/SQLite/file đang dùng |
| RSS hoặc event loop vượt mục tiêu | Peak RSS >512MiB hoặc sampled loopP99 >50ms | Giữ raw report, CPU/IO profile, kiểm tra compression/DB queues; không tăng ngưỡng để báo PASS |
| Crash/SEQ sai, thiếu ACK sau restart | Integrity/receipts/`last_seq`/orphans không khớp | Chặn release, giữ evidence, verify backup, restore **sang DB mới**; không tuyên bố positive SIGKILL probe PASS khi preconditions không thỏa |

### Khi báo incident

Ghi tối thiểu: thời điểm UTC, Node/OS, port/surface affected, release ID và active/previous, route+HTTP status+error `code`, valid offered/completed/429/503/timeout, p95/p99, RSS/loop lag, readiness, size WAL/backup age, integrity, manifest verification, ảnh hưởng người dùng và phương án rollback đã/không áp dụng. **Không** gửi toàn bộ raw telemetry/body/cookie/token lên issue công khai.

## 10. Cleanup, kết quả được chấp nhận và blockers cuối

1. Dừng Terminal D (proxy), B (preview), C (private Ops) bằng Ctrl+C hoặc SIGTERM đúng PID. Xác nhận không còn process đang dùng file DB và không còn listener 8081/8082/8090 của lượt thử.
2. Giữ `$P5_DIR/snapshot.json`, report JSON QA, ID release, output verify, manual backup/manifest đủ lâu để đối chiếu trong local. Không ghi vào `tools/perf/results` cũ, không rename P4 evidence.
3. Chỉ xóa **workspace test vừa tạo** sau khi đã xác minh không chứa dữ liệu cần giữ; không dùng wildcard `/tmp/velance-*`, không xóa repository hoặc DB thật.
4. Kiểm tra `git status --short`; phạm vi P5 bàn giao của lượt này chỉ có **`docs/p5-system-design.md` và `docs/p5-operations.md`**. Không commit/push/deploy.

**Acceptance hiện tại:** [P4 Extended `PASS_LOCAL`](../tools/perf/results/p4-extended-acceptance.json) gồm **16/24/30 native**, **10/25/50/100 virtual HTTP journeys** với byte/hash/ETag đúng, **4 WebGPU +4 WebGL2 tabs** cùng GPU và **600/600 POST +270/270 reads trong 60s mixed soak**. Những dữ liệu này là **local**, không phải 100 browser độc lập, 1.000 người/ngày thực hay CDN đa PoP.

**Public launch = BLOCKED** cho đến khi xác minh [asset rights](p5-asset-rights-register.json), provider CDN + origin, TLS/WAF, Ops SSO, offsite encrypted backup và restore drill, production metrics/alerts, bảo vệ dữ liệu/retention, real-WAN/real-device load và kiểm thử failover. P5 viết tài liệu không thay đổi trạng thái đó.
