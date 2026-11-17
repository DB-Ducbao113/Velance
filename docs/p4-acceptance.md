# VELANCE — P4 local capacity acceptance, 17/11/2026

## Phạm vi và quyết định

**P4 local fixture correctness/capacity: PASS_LOCAL** đối với bộ workload dưới đây. Đây là nghiệm thu **trong máy kiểm thử** chứ không phải SLA uptime, tài nguyên cloud hoặc giới hạn số người dùng thật. Không có CDN provider, TLS/WAF/SSO production, tài sản 3D được phê duyệt license hoặc off-host encrypted backup. Không commit, merge, push hay deploy.

Máy: macOS ARM64, Apple M5, Node v24.21.0, Chrome headed 157.0.8103.79. Script tạo DB và release tạm ở OS temp directory, chỉ bind `127.0.0.1`, kiểm tra rồi cleanup. Database gốc `tools/ops/telemetry.db` không được sử dụng. Chuẩn đo lường, mẫu số request và SLO dự kiến nằm ở [P4 capacity plan](p4-capacity-plan.md); CLI tái lập ở [P4 runbook](p4-operations.md).

**Source-of-truth:** [P4 acceptance JSON](../tools/perf/results/p4-acceptance.json) kiểm tra dữ liệu từ raw reports và các gate không được nới ngưỡng. Nếu report có status `NOT_PROVEN` hoặc `NOT_CONFIGURED`, không diễn giải thành production-ready.

## Backend — 30.000 sessions, 9 triệu samples

| Chỉ số | Đã đo | Mục tiêu | Kết quả |
| --- | ---: | ---: | --- |
| 30-day seed | 30.000 sessions / 9.000.000 samples | Đủ workload lịch sử | PASS |
| Seed database size | 783.998.976 B (~747,7 MiB) | Ghi nhận số đo | Measured |
| Telemetry offered | 600 POST / 60s (10/s) | Baseline 10/s | Measured |
| Full JSON HTTP 200 ACK | 600/600, 0 local drop/timeout/429/503 | ≥99,9% valid offered | PASS |
| Arrival-to-ACK p95 | 3,94 ms | ≤150 ms | PASS |
| Arrival-to-ACK p99 | 5,62 ms | ≤300 ms | PASS |
| Dashboard read p95 | 217,08 ms; 48 reads, all complete 200 | ≤500 ms | PASS |
| Backend peak RSS | 185.909.248 B = 177,30 MiB | ≤512 MiB | PASS |
| Event-loop delay p99 cao nhất | 29,38 ms | ≤50 ms | PASS |
| SQLite integrity / orphans / receipts | `ok`; tất cả row counts khớp | Không mất ACK | PASS |
| Broad summary trên >1M samples | HTTP 422 `WINDOW_TOO_LARGE` | Bounded 422 | PASS |

Sau chạy: **30.600 sessions / 9.006.000 samples / 60.600 events / 900.600 batches**, tương đương seed cộng 600 phiên live ×10 sample, ×1 event, ×1 receipt. 9 triệu samples ban đầu **được seed bằng prepared SQLite statements**; benchmark không hề ingest 9 triệu mẫu qua 600 POST.

Raw evidence: [30-day backend](../tools/perf/results/p4-backend-30day-10rps.json), [3-day intermediate 900k samples](../tools/perf/results/p4-backend-3day-10rps.json).

### Overload theo đúng hợp đồng admission

Rate 100 POST/s, 10 giây, database tạm không seed:

- Offered **1.000**; full 200 ACK **599**, HTTP 429 `RATE_LIMIT` **401**.
- 0 network error, timeout, local sender drop, invalid/incomplete response.
- Sau shutdown tồn tại đúng 599 sessions / 5.990 samples / 599 events / 599 receipts, integrity `ok`.
- Success rate ở mức vượt admission là **59,9%**, không đạt mục tiêu baseline 99,9% nếu cố áp cùng SLO. Đây là expected overload, không phải benchmark throughput 100/s đã xử lý thành công.

Rate limiter hiện có refill ~50/s, burst 100, nên số 429 là một phần có chủ đích của contract. Không thay config, không bỏ 429 khỏi mẫu số khi trình bày. Raw: [backend overload 100/s](../tools/perf/results/p4-backend-overload-100rps.json).

## P3 delivery — synthetic release local

Script [delivery_capacity.mjs](../tools/perf/delivery_capacity.mjs) không đọc model/ảnh của showroom; tạo HTML, JS, GLB và WebP transfer surrogate trong temp, snapshot bằng release ID SHA-256, rồi đo HTTP/1.1 trên loopback.

| Scenario 10 req/s | Offered/complete | p95 response | Response payload |
| --- | ---: | ---: | ---: |
| GET unconditional (br/gzip/binary identity) | 100/100 HTTP 200 | 4,32 ms | 12.321.725 B |
| GET conditional with matched ETag | 100/100 HTTP 304 | 3,18 ms | 0 B |
| GET binary identity only | 100/100 HTTP 200 | 3,76 ms | 24.584.000 B |
| One burst of 16 synthetic GLBs | 16/16 HTTP 200 | 19,30 ms | 6.293.696 B |

Không có 429/503, timeout hay header-policy violation trong các trường hợp tải hợp lệ trên. Client và preview cùng tiến trình Node cho benchmark này; RSS và CPU là tổng của cả hai. Khi telemetry upstream dừng, static trả 200 còn POST telemetry trả 503. Response header bytes đo xấp xỉ, không tính TLS/TCP/IP. Warm 304 có 0 body **không** đại diện cho hoàn toàn không có request ở CDN/browser cache hit.

Raw evidence: [P4 delivery 10/s](../tools/perf/results/p4-delivery-10rps.json).

### Profile kiểm tra thêm: 40 req/s và 32 synthetic GLB requests phát cùng lúc

Sau benchmark 10/s, chạy riêng profile `--duration 10s --rps 40 --concurrency 32`:

- **1.200/1.200** HTTP responses hoàn chỉnh trong ba mode (400 unconditional 200, 400 conditional 304, 400 binary 200); không có local-shed, 429, 503, timeout hoặc cache-policy violation.
- p95 tương ứng **3,48 ms**, **3,34 ms** và **3,10 ms**; response bodies lần lượt khoảng **49,29 MB**, **0 byte**, **98,34 MB**.
- Burst riêng **32/32** synthetic GLB responses đầy đủ, p95 **50,18 ms**, tổng ~12,59 MB. Đây là 32 request đồng thời gửi từ client harness; không chứng minh 32 real-user browser sessions hay 32 origin workers đồng thời.
- Combined client+server peak RSS ở mode lớn nhất khoảng **120,2 MiB**, burst đạt **132,4 MiB**. Peak và latency của profile này không tương đương vendor CDN đa vùng.

Raw evidence: [P4 delivery 40/s](../tools/perf/results/p4-delivery-40rps.json).

## Chrome — Steady-state 3D trên cùng máy

Ba cặp chạy luân phiên baseline/candidate, warm reload có cache, `?nointro&notelemetry`, viewport 1440×900, cả WebGPU và WebGL2 đều load đủ 16 GLB. Đo rAF trong từng khung 1,5 giây **sau** khi load hoàn tất. Chênh lệch là median của các chênh lệch cùng cặp candidate trừ baseline.

| Stage | WebGPU Δ avg frame-gap | WebGL2 Δ avg frame-gap |
| --- | ---: | ---: |
| Home idle | −0,02 ms | −0,05 ms |
| Overview idle | +0,01 ms | −0,02 ms |
| Selected orbit drag | −0,01 ms | −0,08 ms |

Tất cả **6/6 mục tiêu delta dưới +1ms** đạt, không có page/console errors trong 12 lượt đo, không có image fallback thay thế 3D. [Raw Chrome evidence](../tools/perf/results/p4-browser-both-loopback.json).

**Giới hạn quan trọng:** P3 đã quan sát warm full-navigation frame-gap +1,3 ms trên profile constrained 20 Mbps/40ms (lần lặp +0,7ms). P4 steady-state loopback cải thiện tính đồng nhất phép đo nhưng **không phủ định** kết quả P3 constrained; cần benchmark steady-state constrained riêng nếu đó là hard gate. Không có automated visual pixel comparison, ảnh trên iPhone thật, long-duration GPU soak hoặc 100 real-user browser sessions đồng thời trong P4 này.

## Regression và những điều chưa xác lập

- 7/7 native P4: [raw P4 TAP](../tools/perf/results/p4-native.tap); 24/24 P3 + 30/30 P2 cũng pass qua `node tools/perf/p4_check.mjs`.
- **Không xác lập** production SLO 99,9% hoặc số users tối đa từ 600 POST/60s và binary files từ một máy. Cần nhiều client machines, scale profile theo địa lý, 24–72h soak, disk fault drills, CDN PoP cache-hit/origin egress thực, TLS/WAF/origin access và chi phí vendor.
- Mỗi POST gồm mười samples trong harness. Tốc độ **10 POST/s ≠ 10 sessions đồng thời ≠ 1.000 users/ngày**.
- Một writer SQLite vẫn là single point of failure và giới hạn ~50 POST/s do rate limiter; tăng hardware đơn thuần không tự giải quyết admit >50/s.
- **Public deploy vẫn bị chặn bởi license/provenance models/renders và operational security gates.**
