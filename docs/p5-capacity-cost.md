# VELANCE — P5 capacity & cost handoff (chưa triển khai công khai)

**Ngày khóa dữ liệu:** 17/11/2026. **Quyết định hiện tại:** `PASS_LOCAL` cho đúng các workload P4 đã đo; **không phải** `PRODUCTION_READY`. Các con số traffic dưới đây là mô hình giả định theo lượt **cold**. Không có báo giá CDN/cloud, không giả định tài sản 3D đã được cấp phép phân phối công khai. Tài liệu này phục vụ lựa chọn kiến trúc và xin báo giá, **không** cho phép tạo tài nguyên cloud hoặc xuất bản.

## 1. Nguồn số đo và ranh giới suy luận

| Đại lượng | Giá trị có bằng chứng | Ý nghĩa; không được đánh đồng |
| --- | ---: | --- |
| Chrome cold navigation | **~44,15 MB/lượt** (số dùng để lập kế hoạch; 1 MB = 10⁶ B) | Lưu lượng tải của **một lần cold** trong profile Chrome được đo; không phải kích thước toàn bộ origin, không phải trung bình tất cả người dùng, và không phải băng thông ISP cam kết. Raw: [`delivery-local-browser-3.json`](../tools/perf/results/delivery-local-browser-3.json), [`delivery-local-browser-constrained.json`](../tools/perf/results/delivery-local-browser-constrained.json); đối chiếu [`delivery-system-design.md`](delivery-system-design.md). |
| 16 GLB đã chuẩn bị | **43.311.520 B** = **43,311520 MB** = **41,305 MiB** | Tổng byte của **16 file model**, kiểm tra qua inventory/release; riêng các model, không gồm 80 ảnh hoặc HTML/JS/CSS. Raw: [`p4-real-asset-virtual-10-25-50-100.json`](../tools/perf/results/p4-real-asset-virtual-10-25-50-100.json) → `assets.totalModelBytesPerUser`. |
| Bản phát hành tĩnh P3 | **84.894.894 B** = **84,894894 MB** ≈ **80,962 MiB** | Toàn bộ public release (16 GLB, 80 WebP biên tập, 2 WebP môi trường và mã/tài nguyên công khai khác); **không phải** một lượt người xem tải toàn bộ 80 ảnh. Raw: [`delivery-p3-acceptance.json`](../tools/perf/results/delivery-p3-acceptance.json) → `publicBytes`, [`delivery-local.json`](../tools/perf/results/delivery-local.json) → `release.publicBytes`. |
| Public release trừ 16 model | **41.583.374 B** | Bao gồm ảnh và file public khác; **không** suy ra 41,58 MB đó được tải bởi một lượt cold. |
| SQLite fixture 30 ngày | **30.000 sessions / 9.000.000 samples / 783.998.976 B** = **0,783999 GB** ≈ **0,730 GiB** | DB được *seed trực tiếp* bằng prepared statements trong benchmark; không chứng minh rằng 9 triệu mẫu đã đi qua HTTP ingest hay kích thước mỗi phiên trong production bất biến. Raw: [`p4-backend-30day-10rps.json`](../tools/perf/results/p4-backend-30day-10rps.json), [`p4-acceptance.json`](../tools/perf/results/p4-acceptance.json). |

**Trạng thái P4 mới nhất:** [`p4-extended-acceptance.json`](../tools/perf/results/p4-extended-acceptance.json) có `result: PASS_LOCAL`, bao gồm Chrome constrained, 4 Chrome tabs cùng GPU cho mỗi backend, kiểm thử mixed soak/recovery và 10/25/50/100 **virtual HTTP clients** trên release thật. Ở profile 100: **2.200/2.200** request hoàn chỉnh (2.100 HTTP 200, 100 HTTP 304), **0** incomplete 200/SHA mismatch, tổng body ~**4,569 GB**, nhưng `globalInflightLimit=16`, `observedPeakInFlight=16`. Đây **không phải 100 trình duyệt thật** cùng lúc, không chạy 100 GPU contexts, không đo CDN PoP/region/ISP. Các Chrome multitab riêng chỉ kiểm chứng 4 tab cùng thiết bị; không nối hai phép đo để khẳng định năng lực 100 real users.

Phép đổi đơn vị bắt buộc: **GB/TB thập phân** (1 GB = 10⁹ B, 1 TB = 10¹² B); **GiB/MiB nhị phân** (1 GiB = 2³⁰ B). Dùng 30 ngày làm **tháng kế hoạch**; hóa đơn thực theo chu kỳ/thứ hạng/đơn vị của vendor. Không làm tròn số trung gian khi tính tiền.

## 2. Lưu lượng đến người xem và nguồn CDN

Đặt `D` = số **cold visits/ngày**, `F = 44,15 MB/visit` là giả định planning cố định, `T = 30 ngày`. Giả sử mỗi visit tải đủ F một lần, **chưa** tính warm reload, bot/prefetch, retry, phát hành mới, telemetry, HTTP headers hoặc request overhead:

```text
B_browser_day  = D × 44.15 × 10^6 bytes
B_browser_30d  = 30 × B_browser_day
B_edge_gb_30d  = B_browser_30d / 10^9

h_byte = (bytes edge cache đáp ứng / bytes đủ điều kiện cache được yêu cầu)
B_origin_cacheable = (1 − h_byte) × B_edge_cacheable
B_origin_total = B_origin_cacheable + B_bypass + B_fill_other
```

Trong bảng minh họa *đơn giản hóa*, giả sử **100% F đủ điều kiện cache**, `B_bypass = B_fill_other = 0`, không có phát sinh khác; khi đó `B_origin ≈ (1−h_byte) × B_browser`. Hai tỷ lệ **80% và 95% là giả định**, **chưa đo** trên nhà cung cấp nào. Cột CDN là **response payload đến trình duyệt**, không phải lượng byte origin đã gửi.

| Cold visits/ngày | CDN → browser GB/ngày | CDN → browser GB/30 ngày | Origin GB/ngày nếu hit-bytes 80% | Origin GB/30 ngày (80%) | Origin GB/ngày nếu 95% | Origin GB/30 ngày (95%) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **100** | **4,415** | **132,450** | **0,883** | **26,490** | **0,22075** | **6,6225** |
| **1.000** | **44,150** | **1.324,500** | **8,830** | **264,900** | **2,2075** | **66,2250** |
| **10.000** | **441,500** | **13.245,000** | **88,300** | **2.649,000** | **22,0750** | **662,2500** |

Quy đổi nhanh: 1.000 cold/ngày ×30 ≈ **1,3245 TB/30 ngày** đến browser; 10.000 cold/ngày ≈ **13,245 TB/30 ngày**. **Cache hit làm giảm tải origin, không làm giảm số byte mà edge thực sự trả đến người xem** trong giả định mỗi người đều cold. Một CDN vẫn có thể **tính phí edge egress** trên toàn bộ byte edge trả, kể cả cache hit.

### Quy tắc cache thực tế cần áp dụng trước khi dùng mô hình

- **Cache key** cho release `/r/<sha256>/...`: tối thiểu hostname + path + query được chuẩn hóa theo chính sách + representation/encoding; không đưa cookie/auth không liên quan vào key. Quy định rõ những query được chấp nhận; tránh vô hạn cache variants qua query-string. Canonical immutable release ID mới tránh ghi đè cache cũ. Chỉ cache GET/HEAD tĩnh đã xác nhận trong allowlist. Chặn cookie cá nhân hóa và không đặt `public` trên phản hồi riêng tư.
- **Latest pointer** `/` trả **307** và `Cache-Control: no-store`; không được cache vĩnh viễn để rollout/rollback cập nhật đúng. **ETag/304** là revalidation có request và header nhưng **0 response body**; cache hit thật tại browser có thể **không tạo request**. Không cộng 304 0-byte vào số lượt tải `44,15 MB`.
- Tỷ lệ cần đo là **byte hit ratio** theo release/asset/PoP/thời điểm, không phải `hit requests / all requests`. Một HIT của HTML 10 KB không bù một MISS của GLB 4 MB. Segregate `edge-to-viewer egress`, `origin-to-CDN bytes`, `bypass`, `revalidation`, `304`, `partial content`, `Purge`, `prefetch`, `404/5xx`, và phần lưu lượng retry.
- **Cold CDN PoP**, release vừa phát hành, cache eviction hoặc cache phân mảnh có thể tạo đợt origin fill đồng thời với tỷ lệ hit thấp hơn 80/95%. Rate limiting tại origin, request collapsing/Origin Shield, multi-PoP replication, cache warming và chống stampede cần kiểm định theo provider. Không lấy tỷ lệ hit dài hạn áp cho peak 10 giây khi toàn bộ object đều MISS.
- Browser WebGPU/WebGL2, image editorial, số model user chọn và thiết bị sẽ thay đổi traffic. Mọi dự báo phải được cập nhật bằng **byte distribution đo thật** (p50/p95/peak và loại asset), không chỉ nhân tuyến tính một cold load.

## 3. Peak 100 cold visits trong 10 giây — băng thông, không phải users đo được

**Giả thuyết độc lập**: 100 trình duyệt thật đều yêu cầu ~44,15 MB và **toàn bộ body đó phải đến trong cùng 10 giây**. Băng thông biên tối thiểu cho response payload:

```text
100 × 44.15 MB = 4,415 MB = 4.415 GB trong 10 giây
4.415 GB ÷ 10 s = 441.5 MB/s
441.5 MB/s × 8 = 3,532 Mb/s ≈ 3,53 Gbps (edge → browsers)
```

Đây là **tốc độ trung bình lý tưởng** của payload trong cửa sổ 10 giây; chưa tính TLS, TCP/IP, headers, packet loss, retries, HTTP/2/3, origin fill hay burst không đều. Để đạt mục tiêu trải nghiệm thực, cần headroom và kết quả **WAN + nhiều vùng địa lý** do provider xác nhận, không lấy `3,53 Gbps` làm giá trị cấu hình chắc chắn.

Nếu giả định cùng lúc `h_byte=80%` hoặc `95%` *trên chính đợt peak*, origin→edge bình quân tương ứng **0,7064 Gbps** hoặc **0,1766 Gbps**; đây **không phải cam kết** và không tính request miss trùng lặp. Khi cold cache/miss 100%, mức origin tham chiếu có thể tiếp cận **3,532 Gbps** trước overhead. Với 100 virtual clients đã đo, **chỉ 16 download đang hoạt động tối đa** và các model được gọi tuần tự mỗi client; kết quả local **không xác minh** giả thuyết 100 trình duyệt hoàn tất 10 giây.

## 4. Lưu trữ release, SQLite và backup

### 4.1. Object storage cho release

Một release hiện tại: `S_release = 84.894.894 B` = **0,084894894 GB** ≈ **80,962 MiB**, gồm **toàn bộ** public static set. Bản release là content-addressed và **không tự động bị xóa** khi rollback hoặc activate release khác; số retained versions do người vận hành xác lập.

| Số release giữ nguyên byte-size (R) | Tổng byte | Dung lượng thập phân |
| ---: | ---: | ---: |
| 1 | 84.894.894 B | 0,084895 GB |
| 3 | 254.684.682 B | 0,254685 GB |
| 10 | 848.948.940 B | 0,848949 GB |

`S_releases ≈ Σ_i S_release_i`; chỉ khi giả sử tất cả version cùng size mới dùng `R × S_release`. Chưa tính multipart/object metadata, phiên bản trùng do provider, index/manifest riêng, lifecycle storage, replication và archive retrieval. **Không** giả định có block-level deduplication hoặc object storage chỉ thu một lần cho hai bản release trùng file. Tính phí theo **GB-month trung bình theo thời gian**, không chỉ snapshot tại cuối tháng.

### 4.2. Database và hourly backups

Fixture 30 ngày: **783.998.976 B** (~0,784 GB, 0,730 GiB) với 30.000 sessions/9.000.000 samples. Nếu tạo **hourly full backup** và giữ **168 bản**, **mỗi bản vẫn có đúng kích thước như fixture**:

```text
S_backups_168 = 168 × 783,998,976 B
              = 131,711,827,968 B
              ≈ 131.712 GB ≈ 122.666 GiB

S_live_plus_backups ≈ (1 + 168) × 783,998,976 B
                    = 132,495,826,944 B ≈ 132.496 GB
```

**131,7 GB chỉ là mô hình full, non-compressed, non-deduplicated, cùng kích thước** khi đã giữ đủ 168 hourly backups (~7 ngày). Trong thực tế backup theo từng giờ phản ánh DB đang tăng/retention đang xóa dữ liệu; vật lý storage khác tùy block size, compression, object versioning, WAL, snapshots, multi-region replicas và lịch rotation. Không lấy 131,7 GB làm số đo cloud hiện tại. `DB 30-day seed` chưa bao gồm phân vùng dữ liệu dài hạn tại production, recovery point và bất kỳ DB managed service nào. Cần dự trù **live DB + WAL + temporary restore scratch + off-host copies + metadata**, không chỉ 168 object.

Nguyên tắc vận hành: backup ngoài host phải **mã hóa**, phân quyền tách biệt, có chính sách retention được duyệt, xác minh `PRAGMA integrity_check`/manifest và **restore thực nghiệm** đo RPO/RTO. Lưu 168 bản không tự động đảm bảo RPO 1 giờ nếu job backup trễ/hỏng; không tự động đảm bảo bất kỳ RTO nào.

## 5. Mô hình giá không gán báo giá giả

Tất cả giá sau là **biến cần lấy từ hợp đồng/quote chính thức**, cùng currency, region, tier, billable metric và thuế. Không suy diễn giá của Cloudflare, AWS, GCP, Azure hay bất kỳ provider nào từ benchmark localhost.

| Biến phải xin báo giá | Đơn vị tính / nội dung cần xác minh |
| --- | --- |
| `P_edge` | Phí CDN **egress đến browser** / GB; phân tầng GB/tháng, region, overage, minimum commit, billing theo cache HIT/MISS |
| `P_origin` | Phí **origin egress → CDN** / GB (phí network/cloud origin; có thể miễn phí theo integration hoặc tính khác theo vùng) |
| `P_req` | Phí CDN request / 1.000.000 request; tính GET/HEAD/304/edge function/hit/miss theo điều khoản |
| `P_release` | Phí lưu trữ object public release / GB-month, API ops/lifecycle/delete/versioning/replication |
| `P_backup` | Phí off-host encrypted backup / GB-month và retrieval/restore/egress, key-management/replication |
| `P_compute` | Phí compute + disk/IOPS/network endpoint của backend/SQLite, redundancy, database service nếu đổi kiến trúc |
| `P_security` | TLS/domain/certificate nếu có phí, WAF, DDoS, access gateway/SSO, origin protection, bot management |
| `P_ops` | Metrics/logs/traces/alerts, log retention, pager/on-call, incident support, CI artifact registry |
| `P_misc` | Taxes, currency conversion, support plan, commit overages, egress liên vùng, data sovereignty |

Đặt `V = 30D`, `F=0,04415 GB/visit`, `C = cacheable share` (0–1), `h = byte hit ratio`, `N_req = V × r` (với `r` là **số HTTP requests đo được trên một visit**, cần tính 304/retry khi đúng), `B = backups retained`, `R = releases retained`. Mọi khối lượng lưu trữ dưới đây tính theo **GB-month average** khi có số liệu giờ/ngày:

```text
E_edge_GB      = V × F                            [only if 100% cold at measured 44.15 MB]
E_origin_GB    = E_edge_GB × ((1 - C) + C × (1 - h)) + E_extra_miss_GB
S_release_GBm  = time_average(sum(size_of_retained_release_i) / 1e9)
S_backup_GBm   = time_average(sum(size_of_retained_backup_j) / 1e9)

Monthly_estimate = E_edge_GB × P_edge
                 + E_origin_GB × P_origin
                 + (N_req / 1e6) × P_req
                 + S_release_GBm × P_release
                 + S_backup_GBm × P_backup
                 + P_compute + P_security + P_ops + P_misc
```

`P_*` có thể thuộc các **currency khác nhau**; chỉ cộng sau khi quy đổi về một currency thống nhất. Nếu provider tính CDN requests theo bậc hoặc tính phí **origin GET** riêng, thay tích vô hướng ở trên bằng bảng tier thật. `E_extra_miss_GB` bao gồm fill/eviction/refresh/replication/retry cần chứng từ đo; không tự đặt 0 khi lập ngân sách production.

### Ví dụ tính hoàn chỉnh với biến giá (không có giá vendor giả)

Giữ `D = 1.000 cold/ngày`, `C=1`, `R=3` release cùng cỡ và `B=168` full backups cùng cỡ DB seed; giả định các tập dữ liệu tồn tại **đủ tháng** để minh họa storage GB-month. `N_req = 30.000 × r`, `r` còn phải đo.

| Thành phần | Hit-bytes 80% | Hit-bytes 95% |
| --- | ---: | ---: |
| Edge egress / 30 ngày | 1.324,500 GB | 1.324,500 GB |
| Origin egress / 30 ngày (illustrative) | 264,900 GB | 66,225 GB |
| Release storage (`3 × release`) | 0,254685 GB-month | 0,254685 GB-month |
| Backup storage (`168 × fixture DB`) | 131,712 GB-month | 131,712 GB-month |
| CDN requests (biểu thức) | `30.000 × r` | `30.000 × r` |

```text
Cost_80 = 1324.5 × P_edge + 264.9 × P_origin
        + (30000 × r / 1e6) × P_req
        + 0.254684682 × P_release + 131.711827968 × P_backup
        + P_compute + P_security + P_ops + P_misc

Cost_95 = 1324.5 × P_edge + 66.225 × P_origin
        + (30000 × r / 1e6) × P_req
        + 0.254684682 × P_release + 131.711827968 × P_backup
        + P_compute + P_security + P_ops + P_misc
```

**Chênh lệch nguồn CDN** trong ví dụ: `198,675 GB × P_origin`; **không** tiết kiệm `198,675 GB × P_edge`, vì byte edge → browser vẫn giữ nguyên. Đây là *symbolic scenarios*, không phải bill dự báo có độ tin cậy thương mại.

## 6. Quyết định bắt buộc của Owner trước khi chọn nhà cung cấp

| Checkpoint | Người phê duyệt | Bằng chứng đầu vào | Điều kiện qua |
| --- | --- | --- | --- |
| **C1 — Quyền phân phối assets** | Product Owner + người có thẩm quyền pháp lý | Bảng từng GLB và từng render/WebP, license gốc, chain of title, commercial/public redistribution, quyền chuyển đổi/WebGL và attribution | **16/16 GLB, 80/80 editorial WebP và mọi môi trường/ảnh khác có quyền rõ ràng**; không có vật liệu provenance-risk được public |
| **C2 — Dự báo demand** | Product Owner | Mục tiêu cold/warm/day, vùng người dùng, peak arrival shape, nội dung tải theo funnel, % cacheable và error retries | Chốt forecast, growth buffer và định nghĩa *real users* tách khỏi virtual HTTP |
| **C3 — Giá & quota** | FinOps + Procurement | Báo giá/hợp đồng và quota CDN egress, origin fill, GET/304, RPS, WAF, storage/backups, network region | Điền biến `P_*`, tier, tax, budget cap, alert tiêu dùng và giới hạn trước khi mở công khai |
| **C4 — Kiểm chứng provider** | Infrastructure Lead | Test PoP/region và real browsers trên hardware thật, origin hit/miss byte ratio, HTTPS/WAF, fault/rollback, 24–72h soak | Chỉ chuyển từ **NEEDS_PROVIDER_TEST** khi log và gate thực nghiệm đạt; không nâng trạng thái nhờ P4 local |
| **C5 — Data protection/recovery** | Security + Privacy Owner + SRE | Consent/retention, SSO, off-host encryption, restore RPO/RTO đo thực, on-call và incident plan | Data plane tách static/API, backup restore diễn tập pass, cảnh báo thực sự tới người trực |
| **C6 — Go/no-go** | Chủ sở hữu sản phẩm được ủy quyền | Checklist [P5 public launch](p5-public-launch-checklist.md), bản ghi rủi ro và tất cả artifact audit | **Chỉ phê duyệt GO khi không còn BLOCKED hay NEEDS_PROVIDER_TEST ở bất kỳ gate bắt buộc** |

**Trạng thái handoff:** bảng tính và điều kiện chặn đã sẵn sàng; **provider/giá/giấy phép/SSO/backup ngoài máy/public deployment chưa được xác lập**. Không thực hiện commit, push, deploy hoặc xuất bản release trong bước tài liệu này.
