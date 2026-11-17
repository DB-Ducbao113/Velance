# VELANCE P4 — Runbook kiểm thử tải (fixture-only)

Đối tượng kiểm thử là Node 24 backend, SQLite writer/reader, P3 release preview và Chrome GPU. **Chỉ localhost, dữ liệu tạm, không deploy, không sửa database thật hoặc assets.** Các lệnh chạy từ root repository và không sử dụng dịch vụ CDN công khai. Các công cụ benchmark dùng `mkdtemp` tạo database/snapshot, sau khi kết thúc kiểm tra rồi cleanup. File evidence `--out` là tạo mới; không ghi đè kết quả lịch sử.

## 1. Native quality gate

```bash
node tools/perf/p4_check.mjs
```

Lệnh kiểm tra cú pháp các harness P4 và test native P4, rồi gọi P3 và P2 regressions. **Không** tự động seed 9 triệu samples hay mở Chrome. Phải chạy thành công trước các profile tải lớn.

## 2. Backend: tăng dần dữ liệu lịch sử, sau đó đo traffic

```bash
# A: baseline ngắn và fixture thật nhỏ
node tools/perf/backend_load.mjs --smoke \
  --out tools/perf/results/p4-backend-smoke.json

# B: 3 ngày = 3,000 sessions / 900,000 samples
node tools/perf/backend_load.mjs --days 3 --duration 5 --rate 10 \
  --out tools/perf/results/p4-backend-3day-10rps.json

# C: 30 ngày = 30,000 sessions / 9,000,000 samples
# 600 POST trong 60s, 2 dashboard readers đọc mỗi 5s.
node tools/perf/backend_load.mjs --days 30 --duration 60 --rate 10 \
  --probe-large-window --out tools/perf/results/p4-backend-30day-10rps.json
```

**Không chạy đồng thời với browser benchmark trên cùng máy**, vì CPU/disk contention làm sai lệch kết luận. Profiling 30 ngày cần ghi rõ seed time, seed bytes, HTTP p95/p99, RSS, event-loop p99, dashboard query p95, toàn vẹn DB và persisted receipts.

Lưu ý: 9M samples được **seed** trực tiếp bởi SQLite chuẩn bị trước lúc bật server. Chúng không đến từ 600 POST. Với dataset này một window 30 ngày phải trả **422 WINDOW_TOO_LARGE** theo API contract; 24-hour dashboard window chỉ chứa một phần. Kiểm tra kỹ `dashboard.expected422ProbedSeparately` và `verification.ok` trong JSON. Không quy đổi 9M seeded samples thành ingestion throughput.

## 3. Overload tách riêng khỏi baseline

```bash
# Rate-limit dự kiến khoảng 50 req/s có burst 100; ở 100/s sẽ có 429.
node tools/perf/backend_load.mjs --days 0 --duration 10 --rate 100 \
  --out tools/perf/results/p4-backend-overload-100rps.json
```

Các `429 RATE_LIMIT`, `429 DB_QUEUE_FULL`, `429 UPLOAD_CAPACITY` được đếm rõ. Overload `gates.overall` và `validOfferedSuccess99_9pct` là `null` (not applicable), không tự gán `PASS`. Yêu cầu vẫn là server không trả JSON cắt cụt, không có dữ liệu ACK bị mất, liveness và integrity hợp lệ.

## 4. P3 synthetic release: cache và static concurrency

```bash
node tools/perf/delivery_capacity.mjs --duration 10s --rps 10 \
  --concurrency 16 --out tools/perf/results/p4-delivery-10rps.json
```

Benchmark này tạo bốn file giả lập hoàn toàn bằng code (HTML, JS, GLB và WebP transfer surrogate). Mỗi lượt chạy có ba nhóm: GET unconditional, GET với ETag nhận 304, và GET binary identity. Thống kê số offer/sent/completed/shed, response actual bytes, HTTP/1 header bytes ước lượng, p95/p99, trạng thái lỗi, giới hạn RAM/event-loop. Test thêm upstream telemetry không tồn tại: static phải tiếp tục 200, telemetry 503. **Không có CDN PoP** và không tính số byte trên giao thức HTTPS/TCP/IP.

Giới hạn an toàn CLI: mỗi mode tối đa 30 giây, 40 request/s, 32 request đang chạy, 1.200 request được đề xuất. Không giảm cap bằng cách sửa app core hoặc tạo traffic tới Internet.

Profile kiểm chứng thêm ở ngưỡng CLI cao hơn (không có người dùng thật):

```bash
node tools/perf/delivery_capacity.mjs --duration 10s --rps 40 \
  --concurrency 32 --out tools/perf/results/p4-delivery-40rps.json
```

Trong lần đo 17/11/2026, ba mode đạt đủ 400/400 response mỗi mode, burst 32 synthetic GLB requests hoàn tất 32/32; raw output được giữ ở [P4 delivery 40/s](../tools/perf/results/p4-delivery-40rps.json).

## 5. Chrome GPU sau khi các load profile dừng

```bash
node tools/perf/p4_browser.mjs --pairs 3 --backend both --profile loopback \
  --out tools/perf/results/p4-browser-both-loopback.json
```

Sử dụng một browser Chrome headed, 1440×900, ba cặp xen kẽ baseline/candidate cho WebGPU và WebGL2, mỗi cặp có warm reload cùng browser context rồi tải đủ 16 GLB. Lần lượt đo 1,5s home idle, overview idle và selected orbit với drag có kiểm soát; so chênh lệch trung vị từng cặp của **avg frame-gap** (target dưới +1ms). Lưu cả p50/p95/p99/max và errors. Bài này không thay thế real iPhone, image fallback, visual-pixel comparison hay full-fleet all-vehicles test.

## 6. Đọc kết quả theo đúng phạm vi

- `PASS_LOCAL`: native/fixture hợp lệ ở cấu hình đo.
- `FAIL`: vượt ngưỡng ghi trước, dữ liệu hỏng, client drop hoặc thiếu ACK. Giữ nguyên JSON.
- `MIXED`: kết quả chưa ổn định hoặc nhiều profile có kết quả trái nhau; cần thêm measurement.
- `NOT_RUN`: chưa chạy đủ profile.
- `NOT_CONFIGURED`: CDN real PoPs/TLS/WAF/object origin, off-host encrypted backup, external alerting/SSO.

Lưu ý các measurement nhỏ không xác lập SLO 99,9% production. Với load 600 requests không lỗi, tỷ lệ mẫu là 100%, nhưng chưa đủ thông tin để bảo đảm rằng một tháng ở quy mô thật sẽ có lỗi dưới 0,1%. Tổng số người dùng/ngày, phiên đồng thời và POST/s phải được đo tách biệt; xem [kế hoạch và ngưỡng P4](p4-capacity-plan.md).

Tổng hợp acceptance đã kiểm tra các raw JSON/TAP:

```bash
node tools/perf/p4_acceptance.mjs --out tools/perf/results/p4-acceptance-new.json
```

`--out` là create-only, nên đổi tên khi chạy lại. Kết quả hiện tại ở [P4 acceptance JSON](../tools/perf/results/p4-acceptance.json), giải thích tại [P4 acceptance report](p4-acceptance.md).
