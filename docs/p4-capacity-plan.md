# VELANCE P4 — Capacity, tải đồng thời và độ bền (chỉ local)

**Mục tiêu:** kiểm chứng giới hạn hoạt động thực tế của 2 worker SQLite, HTTP admission, query dashboard và static/release delivery dưới tải có kiểm soát. P2 chứng minh hợp đồng dữ liệu/backup; P3 chứng minh cache, snapshot và release isolation. **P4 phải trả lời số lượng dữ liệu, tốc độ request, mức trễ và hành vi overload mà một máy có thể đáp ứng**, không quy đổi bài benchmark localhost thành số lượng người dùng Internet bảo đảm phục vụ được.

## 1. Ba biến không được nhầm lẫn

1. **Kích thước dữ liệu lưu trữ:** giả định 1.000 phiên/ngày × 30 ngày = **30.000 sessions**; 300 samples/phiên = **9.000.000 samples**; 2 event/phiên = 60.000 events; 30 receipt/phiên = 900.000 batches. Tất cả là **dữ liệu tổng hợp** từ một database temporary, không phải telemetry người dùng đã thu thập.
2. **Tốc độ truy cập:** 10 POST telemetry/s (baseline), 50 POST/s (gần giới hạn refill của token bucket), >50 POST/s (overload chủ động). Một phiên có nhiều request, một request có thể chứa nhiều samples; **10 POST/s không phải 10 người dùng/s**.
3. **Lưu lượng delivery:** trình duyệt cold đã đo ~44,15 MB/journey với 16 GLB, 1.000 cold journeys/ngày ~44,15 GB/ngày. CDN edge giữ assets khác SQLite writer; tải 10 POST/s và tải GLB không cùng đơn vị. Phép đo HTTP static concurrency local phải tách khỏi bài full-fleet Chrome.

Lượng phiên đồng thời có thể ước lượng chỉ khi biết **thời lượng phiên** và request arrival thực:

```text
approx. concurrent sessions = session starts per second × average session duration in seconds
average session starts/sec at 1,000/day = 1000 / 86400 ≈ 0.01157
at 10 minutes mean session duration, naive daily average ≈ 6.94 sessions concurrently
```

Đây là phép ước lượng trung bình (Little's Law trong trạng thái ổn định), **không** là bằng chứng số active peak. Mục tiêu peak 100 phiên của plan vẫn phải được xác minh bằng telemetry thực, không nội suy từ 1.000 lượt/ngày.

## 2. Ngưỡng P4 và cách đánh giá không đánh tráo mẫu số

| Nhóm | Chỉ tiêu đo | Ngưỡng mục tiêu ban đầu |
| --- | --- | ---: |
| API bình thường (10/s) | Tỷ lệ hoàn tất HTTP 200 đầy đủ trên **valid offered** | ≥99,9% |
| API bình thường | Latency từ scheduled arrival tới complete response | p95 ≤150 ms; p99 ≤300 ms |
| API reads | Hoàn tất HTTP 200 và p95 từ scheduled arrival | p95 ≤500 ms |
| RAM riêng tiến trình backend | Max sampled RSS | ≤512 MiB |
| Event-loop | Max sampled 1-second interval p99 loop lag | ≤50 ms |
| DB sau stop | `PRAGMA integrity_check`, orphan counts | `ok`, orphan=0 |
| ID/seq receipt | Full 200 ACK và persistent batches tồn tại đúng expected | 100% |
| Tổng hợp dữ liệu | `GET /api/summary?hours=24` khi ≤1M samples | HTTP 200 |
| Window quá lớn | `summary` trả bounded failure | HTTP 422 `WINDOW_TOO_LARGE` |
| Overload >50/s | Rate-limit/admission, không mất dữ liệu ACKed | 429 được thống kê riêng |
| P3 delivery | Cache/immutable GET/HEAD/304 ổn định khi concurrent load | byte/hash/etag đúng, không leak |
| Browser steady render | Paired median tăng frame-gap average | <1 ms cho từng stage/backend |

**Mẫu số là valid offered requests**, bao gồm cả request bị local sender bỏ trước khi mở socket hoặc client timeout; không tính chỉ các HTTP 200 vào success denominator. Report riêng offered/sent/completed/200/429/503/network error/client drop. P95 của requests thành công và p95 của mọi offered completion phải tách: latency chỉ trên HTTP 200 có thể che giấu overload.

Một lần chạy 60 giây không phải uptime SLO và không thể kết luận 99,9% availability dài hạn. Với 600 requests chỉ có thể nhận 0 lỗi là kết quả quan sát, chưa đủ confidence để chứng minh 0,1% error budget trong production. Không đổi ngưỡng khi thất bại.

## 3. Các profile công việc

### A. Baseline nhỏ để phát hiện harness lỗi

Database temp 0–1 ngày, open-loop 10/s trong 10–20 giây. Kiểm tra request timestamp, payload JSON, server child startup/shutdown, ACK receipts và 2 dashboard readers. Chỉ chạy benchmark 30 ngày khi A không có lỗi logic.

### B. Hệ thống dữ liệu 30 ngày (stress *read* và *storage*)

Ghi trước 30.000 sessions, 9 triệu samples bằng prepared statements/SQLite transaction vào **file tạm**; không làm động tác này qua API để tránh nhầm stress storage với stress ingestion. Chụp DB size và thời gian seed, sau đó bật server/2 dashboard clients/open-loop POSTs. Sau khi dừng server, xác minh integrity và row counts, không có orphan. Kết quả trường hợp summary vượt 1M samples phải được ghi là guard 422 có chủ đích; đọc 24h phải tính theo cohort của thời điểm bắt đầu phiên.

### C. Bình thường so với overload

Test baseline 10/s, ramp 30/s, sát giới hạn 50/s, và overload 80–100/s. Rate limiter gốc refill 50/s, burst 100 tokens. Vì thế **load 100/s phải có 429 theo thiết kế**, không được coi đó là sự mất mát âm thầm hoặc ép kết quả success ≥99,9% ở mức đã vượt admission contract. Mục đích là xác minh fault containment, `Retry-After`, alive/ready và phục hồi về baseline sau khi giảm tải.

### D. Read concurrency và operations

Cần kiểm thử đồng thời `/api/summary`, `/api/sessions`, `/api/sessions/:id` và các backup/restore/retention trên fixture nếu được lập lịch. Đọc phải lấy snapshot nhất quán, write ACK giữ nguyên. Các bài giết worker, SQLite busy lock, full-cap/413, backup/restore và startup read-only đã nằm trong native P2; P4 kiểm chứng thêm dưới lưu lượng liên tục, không suy diễn rằng test P2 một lần bảo đảm soak.

### E. Static delivery, GPU và hành vi browser

Dùng synthetic release temp cho concurrency/cache, không sao chép models có license chưa rõ vào public test origin. Với Chrome headed và source local, so **cùng backend** WebGPU/WebGL2, **cùng viewport/stage** (home, overview, selected orbit), cùng thứ tự luân phiên A/B và 3 cặp. Chỉ đo rAF khi full 16 đã load, không trộn 18 giây bandwidth-limited cold loading với warm steady-state frame-gap. Ghi cả p95/max, page/console errors và các trường hợp GPU fallback. Browser benchmark có thể bị nhiễu nếu chạy song song stress SQLite trên cùng máy; cần lịch chạy tách biệt và giữ raw evidence.

## 4. Runtime bounds đã tồn tại, không thay đổi chỉ để đạt benchmark

- Backend rate limiter ~50 POST/s và burst 100; upload cap 256 KiB/request; global upload reservation 16 MiB.
- Writer queue 128 jobs / 8 MiB; reader queue 16 jobs / 64 KiB, mỗi worker chạy serialized, 10s DB deadline.
- Summary in-memory cache 15s / 8 keys; summary window >1M samples trả 422.
- P3 compression cache 16 MiB / 256 entry, 2 nén đang chạy +32 chờ, input nén tối đa 4 MiB. GLB/WebP stream identity với SHA-256 verification.
- Chưa có self-healing writer/reader, horizontal scale writer, CDN provider, TLS, external alarms hay cloud SLO.

## 5. Tính chất bằng chứng

Mọi bài dùng loopback, database temp có cleanup, không truy cập `tools/ops/telemetry.db`, không sửa GLB/WebP hay showroom, không commit/push/deploy. JSON/TAP thô phải được lưu trong `tools/perf/results/`. File tổng kết phân loại riêng: `PASS_LOCAL`, `FAIL`, `MIXED`, `NOT_RUN`, `NOT_CONFIGURED`. Không gắn `PASS` cho mô hình production nếu chỉ đo local.

P4 chỉ kết thúc khi có thực đo và verdict cho từng hàng ngưỡng; nếu một tải vượt giới hạn, ghi số liệu và nguyên nhân chứ không giảm số request/đổi p95 để báo PASS.
