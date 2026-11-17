# VELANCE P5 — Thiết kế hệ thống và bàn giao vận hành (chưa triển khai cloud)

**Trạng thái: DESIGN HANDOFF / NOT PRODUCTION READY.** Ngày đối chiếu: **17/11/2026**. P2/P3/P4 Extended đã đạt **`PASS_LOCAL`** trong phạm vi fixture, HTTP loopback, GPU/browser cùng máy và tài sản thật trên ổ đĩa local. P5 ở đây **chỉ chuẩn hóa kiến trúc và hợp đồng triển khai tương lai**, không có CDN provider, DNS công khai, TLS termination, WAF, SSO, origin cloud, cloud database, alert delivery hoặc deployment.

Nguồn tham chiếu: [P2 kiến trúc](backend-system-design.md), [P2 vận hành](backend-operations.md), [P3 delivery kiến trúc](delivery-system-design.md), [P3 release runbook](delivery-operations.md), [P4 capacity plan](p4-capacity-plan.md), [P4 acceptance](p4-acceptance.md), [P4 load runbook](p4-operations.md). **Bằng chứng P4 mới nhất**: [P4 Extended Acceptance JSON](../tools/perf/results/p4-extended-acceptance.json) và các raw report liên kết tại `evidenceFiles` của JSON. Tài liệu này không sửa hoặc thay thế các nguồn đó.

## 1. Mục tiêu, luồng dữ liệu và trust boundary

VELANCE là showroom 3D phía browser, không phải một ứng dụng render hình ảnh trên server. GPU của **thiết bị người dùng** xử lý scene; CDN nếu được triển khai chỉ vận chuyển tài nguyên đã chuẩn bị, không chia sẻ GPU cho browser, không tự tối ưu frame time.

~~~mermaid
flowchart TB
    U["Browser của người xem<br/>WebGPU → WebGL2 → ảnh fallback<br/>HTML / JS / 16 GLB / WebP"]
    EDGE["Public delivery edge — THIẾT KẾ, CHƯA CÓ PROVIDER<br/>GET/HEAD versioned static<br/>POST duy nhất /api/telemetry"]
    CACHE["Cache mỗi PoP: HIT trả về browser<br/>MISS hỏi private object origin"]
    ORIGIN["Immutable release/object origin — CẦN TRIỂN KHAI<br/>/r/release-id/path, manifest + SHA-256"]
    ACCESS["Private access gateway / SSO — CẦN TRIỂN KHAI"]
    OPS["Ops dashboard + read API + /metrics — NỘI BỘ"]
    API["Node.js 24+ Ops API<br/>telemetry POST, validate, admit/rate-limit"]
    WRITER["SQLite writer worker<br/>transaction + receipt (id, seq)"]
    READER["SQLite read-only worker<br/>summary / sessions / detail"]
    DB[("SQLite WAL — private persistent disk")]
    BAK["Native backup / verify / retention<br/>local private snapshots"]
    OBS["Monitoring / alert delivery — CẦN TRIỂN KHAI"]

    U -- "GET/HEAD public immutable" --> EDGE
    EDGE --> CACHE
    CACHE -- "MISS only" --> ORIGIN
    EDGE -- "POST no-store, proxy không cache" --> API
    ACCESS --> OPS
    OPS --> READER
    API --> WRITER
    WRITER --> DB
    READER --> DB
    DB --> BAK
    API -. "health, metrics" .-> OBS
~~~

**Hai môi trường không được đánh đồng:**

| Lớp | Đã có/đã test trên localhost | Cấu phần phải có trước production |
| --- | --- | --- |
| Client | Browser Chrome headed, WebGPU/WebGL2, lazy loading, fallback logic, render scene | Đo mobile thực/iPhone, thiết bị độc lập, nhiều GPU/driver, UX, accessibility |
| Static delivery | `tools/delivery/static.mjs`, `release.mjs`, `server.mjs`; immutable snapshot, allowlist, ETag, 304, verify | CDN PoP thật, private object origin, HTTPS/TLS, DNS, cache-key rule, purge/rollout, phân vùng |
| POST telemetry | Local preview proxy duy nhất `POST /api/telemetry` đến một loopback upstream | Public-facing edge rule, anti-abuse, bảo vệ private upstream, quota/bot protection, e2e policy |
| API | Node 24, validator, writer/reader, rate limits, health/metrics, SQLite WAL | Deployment, persistent block storage, restart policy, IAM/network ACL, secret/incident management |
| Ops | `/ops/` và read APIs trên private local origin | SSO/MFA, access gateway, RBAC, audit, không public expose |
| Operations | Native backups/checksum, manual retention, Prometheus-format metrics | Backup mã hóa offsite, restore drill ngoài host, scrape+alert+on-call, RPO/RTO và retention compliance |

### Sự phân chia public/private bắt buộc

- **Public GET/HEAD:** `/` và `/index.html` chọn release, các đường dẫn `/r/<release-id>/...` chỉ được đọc asset allowlist. Repo nội bộ, model nguồn, PNG master, source map, `/ops/`, SQLite, WAL/SHM, manifests backup và `/metrics` không được phát hành.
- **Public POST:** chỉ đúng **`POST /api/telemetry`** (path chính xác, không query/alias); Node preview chuyển về upstream loopback được khai báo khi startup, từ chối URL proxy tùy ý. Payload POST phải có `Content-Type: application/json`, capped size, trả JSON và `Cache-Control: no-store`. Không đưa `/api/summary` hay `/api/sessions` ra public edge.
- **Private read/operations:** dashboard `/ops/`, `GET /api/summary?hours=24`, `GET /api/sessions?limit=50`, `GET /api/sessions/:id`, `/health/*`, `/metrics` chỉ nằm sau private network/access gateway trong **thiết kế production**. Ở localhost hiện tại, người có quyền chạy process trên cùng máy có thể truy cập; Host/Origin/Fetch-Metadata không phải authentication.
- **Không ghép public origin và private dashboard vào cùng cấu hình CDN** với quy tắc cache tổng quát `/api/*`. Nếu provider gắn cache sai, API response và dữ liệu người dùng có thể lộ. Cần test denial và `no-store` tại provider, không lấy 404 local làm chứng nhận firewall cloud.

## 2. Browser / WebGPU / WebGL2 / đường dẫn asset

1. Browser truy cập `/`. Local delivery preview trả **307 + `Cache-Control: no-store`** tới `/r/<sha256-release>/index.html` và giữ query string. Đây là active pointer, không phải URL immutable.
2. Document dùng đường dẫn tương đối để tải JS/CSS, WebGPU/WebGL2 modules, 16 GLB và WebP theo nhu cầu. `/r/ID/index.html` và `/r/ID/src/...` cùng release; chuyển active không thay source của tab cũ. Browser phát hiện backend/khả năng tương thích; fallback ảnh là phương án riêng, **không** cho thấy WebGPU dùng được trên mọi máy.
3. GPU renderer chạy trong browser. Vẫn phải đo chất lượng frame time, GPU memory, overdraw, battery và render fallback trên thiết bị đại diện. WebGPU/WebGL2 dùng cùng máy GPU trong test nhiều tab.
4. Telemetry collector có thể gọi POST ở root path khi local preview được cấp upstream; chỉ HTML document đủ điều kiện có `X-Velance-Ops: 1`. Không upstream → header không có, collector không được tự cho là có server. Query opt-out/setting opt-out vẫn được tôn trọng.

**Giới hạn giấy phép:** 16 GLB và ảnh render từng được đọc trong thử nghiệm local không đồng nghĩa quyền phân phối công khai. Phải có hồ sơ provenance/license cho **từng** tài sản được public qua WebGL, kể cả WebP/editorial; đây là **blocker** cho deploy.

## 3. Cơ chế CDN thực tế cần triển khai — khác local preview

CDN **không** bắt đầu hoạt động khi đạt một số người dùng nhất định; nhà cung cấp thực thi caching/distribution ngay khi DNS/edge/origin được cấu hình. Cơ chế mong muốn:

~~~mermaid
sequenceDiagram
    participant B as Browser
    participant E as CDN PoP (chưa triển khai)
    participant O as Private immutable origin (chưa triển khai)
    participant T as Private Node telemetry (chưa triển khai)
    B->>E: GET / (mỗi lần vào)
    E-->>B: 307 Location /r/ID/index.html, no-store
    B->>E: GET /r/ID/assets/models/car.glb
    alt HIT theo URL/representation, cache hợp lệ
        E-->>B: 200 bytes từ edge
    else MISS / revalidation
        E->>O: GET đúng /r/ID/...
        O-->>E: asset đã verify SHA/manifest
        E-->>B: 200, immutable + ETag
    end
    B->>E: POST /api/telemetry JSON
    E->>T: Chỉ route POST này; không cache
    T-->>B: JSON ACK qua edge, no-store
~~~

**Điểm cần phân biệt khi đo:**

- **Browser cache HIT**: trình duyệt không cần truy cập mạng cho asset immutable đã lưu; có thể tiết kiệm cả client bytes.
- **CDN PoP HIT**: một browser chưa cache vẫn nhận đầy đủ bytes từ edge; HIT giảm origin fetch/egress, **không** xóa bytes edge→browser.
- **MISS**: PoP (hoặc cache trung gian nếu provider có) truy cập origin; origin phải giữ `/r/ID/...` bất biến và không public listing.
- Edge routing tùy Anycast/ISP, load và provider; không hứa PoP về mặt địa lý gần nhất. Multi-region hit ratio và actual origin egress hiện **chưa đo**.
- `ETag` được hash từ nội dung **và** encoding `identity`/`gzip`/`br`; `Vary: Accept-Encoding`, `If-None-Match` (weak/list/star), response `304` rỗng và `406` khi không encoding khả dụng. Local mutable = `Cache-Control: no-cache` (có thể revalidate); versioned = `public, max-age=31536000, immutable`. Không tuyên bố `Range/206` khi chưa triển khai. GLB/WebP/WASM tải identity theo P3.
- Local compression dùng LRU 16 MiB/256 entries, tối đa 2 jobs chạy +32 chờ; không nên dùng thuật toán/giới hạn trong Node preview làm mặc định cho CDN provider. Edge chính thức phải có chính sách cache key, compression, Vary, negative caching và failover riêng đã test.

### Release, active pointer, rollback và tính toàn vẹn

~~~text
<private-release-store>/
  active.json                # active + previous; đổi atomically sau verify
  releases/
    <ID-A>/                  # manifest và bytes A giữ nguyên
    <ID-B>/                  # manifest và bytes B giữ nguyên
~~~

- `snapshot` chỉ copy byte public allowlist sau canonical path guard, tạo manifest `path / bytes / SHA-256` và ID hash manifest ổn định. Không copy `assets/models_original`, `assets/models_prepared`, PNG master, `/tools/ops`, `/ops`, database, private files. `verify` xác minh bản copy; `activate` đổi `active.json` atomically; `rollback` quay về `previous` **nếu previous hợp lệ**.
- Không bao giờ ghi đè hoặc xóa `/r/ID-A` khi active sang B: tab A vẫn cần JS/GLB A. Rollback chỉ ảnh hưởng **lượt vào mới** qua `/`; không đảm bảo các tab đã tải JS B tự reload về A, không rollback dữ liệu SQLite.
- Local preview còn kiểm tra hash/size từ file descriptor trước khi gửi headers/304; mismatch trả `503 RELEASE_MISMATCH`. Khi dùng object storage/CDN thật cần cơ chế đồng bộ và verify khác, không suy luận rằng preview sẽ chạy bên trong PoP.
- **Chưa có production rollout**: phải định nghĩa staged publish, cache warm-up, 404/missing asset alarms, quy tắc clear active pointer khi cần, rollback kiểm thử xuyên edge, origin access control và retention snapshot giữ đủ lâu. Không purge tất cả versioned releases để “sửa cache”.

## 4. Private Node24 + SQLite — hợp đồng dữ liệu và failure semantics

~~~text
Public edge: exact POST /api/telemetry (no-store)
  -> proxy có giới hạn body (không chuyển Cookie/Auth/X-Forwarded của client)
  -> private Node24 admission: validation, 256 KiB cap, ~50 POST/s refill + 100 burst,
     global in-flight upload reservation 16 MiB
  -> writer worker (128 jobs / 8 MiB) -> BEGIN IMMEDIATE
  -> sessions + samples + events + batches(session_id, seq) -> COMMIT -> 200 {ok:true}

Private Ops/SSO: GET /api/summary, /api/sessions, /api/sessions/:id
  -> read-only worker (16 jobs / 64 KiB) -> SQLite WAL snapshot reads
Private Ops/monitor: /health/live, /health/ready, /metrics
~~~

- `id` và `seq` là khóa receipt; cùng `(session_id,seq)` được ACK lại nhưng không nhân đôi samples/events. Metadata mới hơn thắng theo `seq`; bản cũ không làm giảm `last_seq`. Samples/events unique per session/time và transaction all-or-nothing. Giới hạn 2.000 samples/500 events trong một batch, timestamp session quá cũ/tương lai bị từ chối.
- Tổng hợp `hours=1/6/24` hoặc cửa sổ tối đa 31 ngày, nhưng truy vấn chứa **hơn 1.000.000 samples** trả bounded **`422 WINDOW_TOO_LARGE`**. `422` này là bảo vệ hợp đồng, không được nhập chung lỗi mất dữ liệu. Đọc theo thời gian bắt đầu session, không phải thời gian POST đến.
- `429` gồm admission rate limit/queue full, `503` gồm lỗi DB/worker/upstream; lỗi 429 khi **cố ý vượt** 50/s không tự chứng minh 99,9% success. `/health/live` có thể 200 trong khi `/health/ready` 503.
- **Một SQLite writer và một host/volume** là điểm lỗi đơn; WAL giúp reader song song, không cung cấp replication, HA hoặc durable queue khi origin mất. Cloud cần quyết định một writer primary, persistence, backups và phương án failover có thử nghiệm. Không dùng multiple independent writers chia sẻ SQLite file qua network filesystem.

### Backup, retention và giám sát

- Backup SQLite native là snapshot nhất quán và cặp manifest checksum/size/schema/row counts. Scheduler chỉ bật khi truyền `--backup-dir`; mặc định định kỳ khoảng **1 giờ**, giữ **168 snapshots theo số lượng**, không phải 168 ngày. `verify` kiểm tra hash + SQLite integrity; `restore` chỉ ghi ra đường dẫn **mới** và kiểm tra lại. Snapshot local chưa mã hóa và chưa offsite.
- Telemetry retention **không chạy tự động**. CLI `retention` preview; `--apply --backup-dir` snapshot+verify trước khi xóa sessions cũ hơn khoảng 30 ngày (kèm guard 5 phút), transaction batch và dependents. Cloud cần lịch retention có kiểm toán và chính sách privacy xác định trước khi bật.
- Metrics Prometheus-format: `velance_http_requests_total`, `velance_ingest_batches_total`, `velance_http_request_duration_seconds`, `velance_db_queue_jobs`, `velance_db_worker_up`, `velance_ready`, `velance_process_resident_memory_bytes`, `velance_event_loop_delay_p99_seconds`, `velance_backup_age_seconds` và `velance_alert`. Hiện là metric được expose **chứ không có** scraper/pager/on-call. Giữ `/metrics` private, tăng cardinality và nhãn động cần review.

## 5. Quy mô 1.000 người/ngày và 100 người tại peak — không suy diễn

Cần tách **daily unique visitors**, **lượt tải thực**, **active sessions**, **HTTP connections/downloads đồng thời**, **POST/s** và **GPU tabs**. Giả định để tính ngân sách, **không** phải quan sát production:

| Giả định | Phép tính | Nghĩa |
| --- | --- | --- |
| 1.000 lượt/ngày | 1.000 / 86.400 = **0,0116 session mới/s** trung bình | Không phải 1.000 concurrent |
| Thời gian session trung bình 10 phút | 0,0116 × 600 ≈ **6,94 active sessions trung bình** | Little's Law sơ bộ, không cho biết peak |
| Peak kế hoạch 100 active sessions | Cần phân phối thời gian session / arrivals thực | Không tự suy ra 100 POST/s hoặc 100 tải GLB cùng lúc |
| Cold journey 16 GLB ≈44,15 MB | 1.000 ×44,15 MB ≈ **44,15 GB/ngày** | Kịch bản mọi visit đều cold và đi đủ 16 GLB; chưa gồm mọi editorial |
| 100 cold journeys cùng 10 giây | 100×44,15 MB/10s ≈**3,53 Gbit/s** | Băng thông **tới clients**, chưa gồm HTTP/TLS overhead |
| Byte cache hit giả định 80% | 44,15 GB×20%≈**8,83 GB origin/ngày** | Chỉ mô hình byte HIT; CDN vẫn có thể gửi ~44,15 GB tới cold clients |
| Byte cache hit giả định 95% | 44,15 GB×5%≈**2,21 GB origin/ngày** | Không phải hit ratio đã đo, phụ thuộc PoP/cache policy |

Chi phí dự kiến = **CDN bytes to viewers × giá egress + số request × giá request + origin egress/storage + compute/API + DB disk + backup + monitoring**; hiện không có báo giá provider/region. CDN có thể có ích ngay ở 1.000 lượt/ngày nếu asset lớn hoặc traffic quốc tế, nhưng cần số liệu cold/warm thực trước khi quyết định gói/cấu hình. GPU workloads không scale tuyến tính theo HTTP virtual users.

## 6. Bằng chứng P4 Extended chính xác (17/11/2026)

**Tài liệu chuẩn:** [`p4-extended-acceptance.json`](../tools/perf/results/p4-extended-acceptance.json), kết quả **`PASS_LOCAL`**, không phải `PASS_PRODUCTION`. Các con số sau được rút từ chính file tổng hợp và raw linked; không phóng đại phạm vi:

| Nhóm | Bằng chứng | Kết luận hợp lệ |
| --- | --- | --- |
| Native gates | **16/16 P4**, **24/24 P3**, **30/30 P2** native; 0 fail mỗi bộ | Correctness/regression local đạt, không phải 16 CDN nodes |
| Chrome constrained | **12 cases**, 3 A/B pairs mỗi WebGPU/WebGL2; tất cả load **16 GLB**, frame-gap paired delta ở 3 stages/backend <+1ms | Cùng máy, Chrome/network emulation 20 Mbps/40 ms; không đại diện mọi thiết bị |
| Real Chrome tabs | **4/4 WebGPU + 4/4 WebGL2**, đều load 16 GLB, hoàn thành overview/selected; elapsed ~9,99s và ~11,43s | **8 tabs tổng**, cùng GPU/host; không phải 8 người ở 8 nơi |
| Real-source virtual HTTP | **10/25/50/100 virtual journeys**, mỗi journey 16 GLB thật +5 WebP thật + conditional 304; SHA/ETag/bytes được verify | 100 virtual clients **không** là 100 independent browsers; global inflight tối đa 16 ở profile 25/50/100 |
| 100 virtual profile | **2.200 requests**, ~**4,569 GB payload**, p95 complete journey **5.266 ms**, actual peak **16 downloads** | Thời gian loopback/OS cache; không phải throughput CDN 100 browser đồng thời |
| Mixed soak | **60s**, 3 ngày seed **3.000 sessions / 900.000 samples**; **600/600** valid offered POST ACK; **270/270** mixed reads; verified backup khi đang ghi | Đo 10 POST/s local; 0 timeout/drop/429/503, không là SLA dài hạn |
| Fault + DB | SIGKILL **sau khi steady requests đã settle và ACK được kiểm tra**, restart/replay idempotent/seq advance pass; **451** receipts riêng biệt sau probe; integrity ok/orphan 0 | Crash recovery fixture đã chứng minh; không chứng minh HA hay RPO/RTO cloud |
| Resources mixed | Max RSS **191,33 MiB**, max sampled event-loop P99 **13,53 ms** | Cùng môi trường Apple M5, Node v24.21.0 |

Riêng P4 baseline với **30-day 30.000-session/9.000.000-sample seed** đã ghi nhận 600/600 ACK tại 10 POST/s, trong [P4 acceptance](p4-acceptance.md); đó là **seed SQLite**, không phải gửi 9 triệu samples qua API. Ở profile **100 POST/s** có **599/1.000 ACK** và **401/1.000 HTTP 429** theo token bucket, không được mô tả là 100% success. [Raw overload](../tools/perf/results/p4-backend-overload-100rps.json).

## 7. Chỉ tiêu đo, ranh giới SLO và quyết định P5

**Ngưỡng nghiệm thu local** được giữ nguyên, không tự chỉnh để đạt PASS:

| SLI / chỉ tiêu | Ngưỡng thử P4 | Kết quả 60s mixed / nguồn |
| --- | --- | --- |
| Valid offered POST → full 200 JSON ACK | ≥99,9% (mẫu số **mọi offered**, kể cả drop/timeout) | 600/600 (100%) local |
| Latency từ **scheduled arrival** đến ACK | p95 ≤150ms; p99 ≤300ms | p95 ~3,54ms, p99 ~5,29ms |
| Mixed read complete 200 | p95 ≤500ms, không local dropped | 270/270; p95 ~6,50ms |
| Backend RSS | Peak sampled ≤512MiB | ~191,33MiB |
| Event-loop lag | Max sampled 1s interval P99 ≤50ms | ~13,53ms |
| Durability và DB | 100% ACK receipts, `PRAGMA integrity_check=ok`, orphan=0 | PASS sau restart / backup / fault probe |
| CDN real | Cần hit/miss/egress/TLS/PoP traces | **NOT_CONFIGURED** |
| Uptime production | Tháng nhiều vùng, health checks ngoài hệ thống, on-call | **NOT_PROVEN** |

**Không tính khả dụng production là “99,9%” chỉ vì 600/600 trong 60 giây.** Những sample này không đo mất mạng ISP, DNS, edge outage, 24h+ soak, failover volume, geolocation, mobile GPU/battery hay chi phí. Ngưỡng phải được đo lại trên các vùng, thiết bị và hạ tầng thực, với tiêu chuẩn valid offered rõ ràng và phân biệt intentional overload 429.

### Điều kiện bắt buộc trước bất kỳ quyết định phát hành công khai

1. **Legal assets gate:** ghi giấy phép/provenance, quyền chỉnh sửa và phân phối WebGL công khai cho từng GLB/WebP; cấm publish nếu chưa đạt.
2. **Security/privacy gate:** chính sách thu thập/opt-out/retention, bảo vệ dữ liệu người dùng, TLS, WAF/rate limit tại edge, private origin ACL, SSO/MFA Ops, review HTTP cache key và route deny.
3. **Reliability gate:** host có disk persistent, offsite encrypted backup + thử restore trên máy khác, disk/worker crash runbook, metrics scrape và notification/on-call, documented RPO/RTO.
4. **Delivery gate:** chọn vendor và region, PoP hit/miss và byte-hit, origin egress, 304/ETag/encoding, URL A/B retention, failure at origin, rollout + rollback qua edge.
5. **Real-user performance gate:** 100 **thiết bị/browser độc lập nếu yêu cầu 100 peak thực**, test các khu vực mạng, 24h+ soak, iPhone và GPU fallback, đo bytes/first render/all16/frame gaps/battery và traffic 1.000/ngày thực.

**Trạng thái bàn giao P5:** kiến trúc, mô hình dự kiến và runbook local đã được xác định; **cloud readiness chưa đạt và chưa deploy**. Hướng dẫn thao tác an toàn ở [`p5-operations.md`](p5-operations.md).
