# VELANCE P3 — Thiết kế phân phối nội dung và quản lý release (local)

**Mục tiêu:** Kiểm chứng cơ chế phục vụ HTML/JS/CSS/GLB/WebP có cache đúng giao thức, phát hành các phiên bản bất biến và chỉ định tuyến **POST /api/telemetry** tới private backend. P3 tạo một *local delivery preview* để kiểm thử hợp đồng HTTP trước khi chọn nhà cung cấp CDN; preview **không phải CDN production, TLS, WAF hay SSO**. Model/render hiện chưa được xác nhận đầy đủ về license nên không phát hành công khai.

## Vì sao VELANCE cần thiết kế CDN?

CDN không có ngưỡng người dùng tối thiểu. Đầu vào hợp lý là **lưu lượng byte**, **mức phân tán địa lý**, **độ trễ**, **cache hit theo byte**, **độ đột biến lưu lượng** và **giá egress**. Một trang có 100 người tải GLB lớn trong vài giây có thể cần delivery khỏe hơn trang có 10.000 lượt/ngày nhưng chỉ vài KB HTML.

Những con số trong plan là **mục tiêu/giả định**, chưa phải traffic đã đo:

| Tham số | Giả định P3/P4 | Cách diễn giải |
| --- | ---: | --- |
| Lượt truy cập | 1.000/ngày | Không đồng nghĩa 1.000 đồng thời |
| Active peak | 100 phiên | Thời điểm bận nhất |
| Payload minh họa mỗi cold visit | 50 MB (thập phân) | Phải xác minh qua Chrome CDP, không lấy tổng thư mục thay thế |
| 1.000 cold visits × 50 MB | 50 GB/ngày | Browser-facing egress **nếu tất cả đều cold và tải đủ 50 MB** |
| 30 ngày × 50 GB | 1,5 TB | Budget lý thuyết, chưa tính cache trình duyệt và hành vi chọn xe |
| 100 cold visits, 50 MB mỗi visit, 10 giây | 4 Gbps | Tổng băng thông tới browser; giả định đồng bộ tải |
| Peak telemetry | ~10 POST/s | Workload API riêng, không phải 4 Gbps GLB |

Trên filesystem source đang có **16 file GLB** (41,31 MiB, tức 43,32 MB) và **80 ảnh editorial WebP**. Cạnh đó còn 80 PNG master **không đưa vào release**. Tổng file nằm trên đĩa không bằng payload thực tế: showroom lazy-load và người dùng có thể không mở mọi editorial/car. Về sau phải đo request/response và *wire bytes* trên từng journey.

### Số liệu local P3 đã đo — 17/11/2026

Snapshot từ source thật chứa **125 file public / 84.894.894 bytes** (84,895 MB, gồm 16 GLB, 80 WebP editorial và 2 WebP environment); PNG master không nằm trong snapshot. Trên Chrome headed 157, máy macOS Apple M5, ba cặp chạy tuần tự và luân phiên baseline/candidate, **cold visit** tới lúc đủ 16 GLB truyền khoảng **44,15 MB** qua mạng local, không phải 84,895 MB. Raw CDP measurements: [loopback 3 pairs](../tools/perf/results/delivery-local-browser-3.json) và [20 Mbps/5 Mbps/40 ms](../tools/perf/results/delivery-local-browser-constrained.json). Mỗi run dùng fresh browser context cho cold và warm reload trong cùng context; cache vẫn bật.

Nếu giả sử mọi lượt truy cập sau này đều thực hiện chính journey cold vừa đo, có thể làm sensitivity math gần đúng bằng 44,15 MB/lượt:

| Cold visits mỗi ngày | CDN/browser-facing traffic/ngày | Origin egress khi byte hit 80% | Origin egress khi byte hit 95% |
| --- | ---: | ---: | ---: |
| 100 | 4,415 GB | 0,883 GB | 0,221 GB |
| 1.000 | 44,15 GB | 8,83 GB | 2,208 GB |
| 10.000 | 441,5 GB | 88,3 GB | 22,075 GB |

Đây là phép tính giả định cho **byte cache-hit** và *journey* đo được, không phải sự thật về CDN production. Egress qua CDN vẫn có thể tương đương traffic cột 2; provider/CDN PoPs, browser reuse và cache-key mới quyết định origin egress. Nếu 100 phiên cùng kéo 44,15 MB trong 10 giây thì tổng network throughput tới browser xấp xỉ **3,53 Gbps**.

### CDN phân phối như thế nào?

```text
Browser (VN/EU/US)
  │  GET /r/<release-id>/index.html, GLB, WebP, JS
  ▼
CDN edge theo định tuyến mạng (không đảm bảo trung tâm địa lý gần nhất)
  ├─ cache HIT  -> trả ngay từ edge
  └─ cache MISS -> private immutable object origin -> edge -> browser

Browser -> exact POST /api/telemetry -> TLS/edge limits -> private Node writer/SQLite

Operator -> SSO/access gateway -> private Ops, read APIs, metrics
```

- **Browser cache:** nếu một URL immutable đã có trên máy khách, browser có thể không gửi request mạng lần nữa, tiết kiệm byte truyền về browser.
- **CDN edge cache:** nếu edge đã lưu đúng cache key, giảm request và byte từ **origin**. Edge vẫn phải truyền file tới browser chưa cache. Mỗi địa điểm edge có thể có cache riêng; không mặc định mọi user có cùng hit.
- **Origin:** lưu snapshot versioned bất biến; cache miss mới cần đọc/gửi từ origin (có thể qua tầng regional/tiered cache).
- **API telemetry:** request có side effect; không được cache, chỉ route POST chính xác đến private origin. API đọc, Ops, source, DB, backup, metrics hoàn toàn không nằm trên public surface.

Tham khảo nguyên lý cache: [Cloudflare Get started](https://developers.cloudflare.com/cache/get-started/), [Cloudflare CDN architecture](https://developers.cloudflare.com/reference-architecture/architectures/cdn/), [AWS CloudFront request flow](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HowCloudFrontWorks.html). Việc chọn edge còn phụ thuộc định tuyến ISP và tối ưu mạng, không mặc định geographic-nearest; xem [Cloudflare traffic routing](https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/geographic-traffic-routing/).

### Cache hit ratio và egress — không nhầm số liệu

Giả sử browser thực sự nhận 50 GB nội dung từ CDN/ngày, và **byte cache hit** là 80% cho nhóm file được cache: minh họa origin cần chuyển khoảng **10 GB/ngày** cho nhóm này; 95% → **2,5 GB/ngày**. Đây là mô hình giản lược, bỏ qua warmup, multiple PoPs, tiered cache, purge, không cache HTML, 304 và traffic không qua CDN. **Browser vẫn có thể nhận 50 GB/ngày** nếu tất cả là cold. Không quy đổi request hit ratio thành byte hit ratio: một GLB miss 6 MB quan trọng hơn hàng trăm JS hits nhỏ.

Để tính chi phí khi có nhà cung cấp: `total_cost = CDN_bytes_out × egress_price + edge_requests × request_price + origin_storage + origin_egress + compute + persistent_DB + backups + monitoring`. Các đơn giá để trống đến khi chọn vendor/region. Phân tích 10× là *sensitivity* chứ không chứng minh hạ tầng chịu tải 10×.

## P3 contract — nơi cache đúng và nơi tuyệt đối không cache

| Tài nguyên | URL, HTTP semantics | Cache policy |
| --- | --- | --- |
| Source local mutable | `/src/...js`, `/styles/...css`, `/assets/...glb` | `no-cache`, ETag theo *content và representation*, 304 khi client xác nhận đúng |
| Snapshot local immutable | `/r/<release-id>/...` | `public, max-age=31536000, immutable`, mỗi release URL là content-addressed |
| Active alias | `/`, `/index.html` | `307` tới active ID, `no-store`; query string được giữ |
| Private API/telemetry | `/api/telemetry` ở preview với upstream được cấu hình cố định | `no-store`; **không** generic reverse proxy |
| Errors, API đọc, Ops, metrics | Không được phục vụ trên public preview | Trả lỗi không cache, không để lộ dữ liệu |

HTTP static cần hỗ trợ GET/HEAD, weak/list/`*` If-None-Match theo weak comparison, `Vary: Accept-Encoding`, `br`/`gzip`/`identity` với q-values, 406 khi không thể chọn representation, Content-Length đúng bytes đã encode, 304 rỗng, hủy streaming an toàn. HTML/JS/CSS là compression candidates; GLB/WebP/WASM giữ identity trong P3. Không quảng cáo Range/206 khi không triển khai. Compression LRU có giới hạn **16 MiB / 256 entries**, tối đa **2** jobs nén; file bị sửa cùng size và atomic replacement không được dùng cached bytes cũ.

Giới hạn triển khai local: tối đa **32 compression jobs chờ**, tổng tối đa **34 compression reservations** (2 chạy và 32 chờ). File có đầu vào nén trên **4 MiB** trả `503 STATIC_BUSY` nếu client yêu cầu gzip/Brotli; client nhận `identity` vẫn có thể tải bằng stream. Giới hạn này ngăn buffer vô hạn ở Node; không tương đương edge traffic shaping hoặc throughput production.

## Release model — triển khai mà không thay đổi showroom

1. CLI chụp nguyên byte file public được allowlist, xác minh canonical path, loại source gốc, Ops, database, backup, render harness, Git, dependencies và PNG master.
2. Sinh manifest theo path, size, SHA-256; release ID được hash từ manifest sắp xếp ổn định. Source dev và các `?v=11.0-webgpu` cũ không cần sửa; query đó **không** là fingerprint.
3. Stage release mới ở directory riêng, xác minh manifest trước khi kích hoạt. `active.json` đổi atomic và giữ previous. Không ghi đè snapshot cũ.
4. User còn mở `/r/OLD/index.html` tiếp tục lấy JS/GLB/ảnh tại `/r/OLD/...` kể cả khi active chuyển sang NEW. Rollback chỉ đổi pointer, không xóa bản NEW/OLD.
5. Public preview và actual cloud sau này phải xác nhận route, private origin ACL, vary/cache key, immutable keys và bảo vệ integrity tại nơi thật.

Điểm đặc biệt của VELANCE: các tham chiếu assets trong HTML/importmap đang là đường dẫn `./...`, trong UI/engine có `new URL('./assets/models/...', location.href)`. Đặt document tại `/r/<id>/index.html` giữ chúng thuộc cùng release. Collector giữ `POST /api/telemetry` tuyệt đối ở root, đúng thiết kế public edge.

## Nghiệm thu và giới hạn

- **Kết quả 17/11/2026:** 24/24 native P3, 30/30 native P2 regression, 9 syntax checks đạt, và browser switch/rollback đang mở tab cũ đạt. [Acceptance JSON](../tools/perf/results/delivery-p3-acceptance.json), [raw P3 TAP](../tools/perf/results/delivery-p3-native.tap), [raw P2 TAP](../tools/perf/results/delivery-p3-p2-regression.tap), [browser switch](../tools/perf/results/delivery-release-switch.json).
- **Chrome 157, Apple M5, 3 cặp thứ tự luân phiên mỗi profile:** median tổng bytes tới browser qua local origin và thời gian đạt 16 GLB:

  | Profile / lần tải | Baseline (bytes; all-loaded) | Release preview (bytes; all-loaded) |
  | --- | ---: | ---: |
  | Loopback cold | 44.152.458 B; 2.375 ms | 44.150.970 B; 2.364,1 ms |
  | Loopback warm | 11.513 B; 1.878,5 ms | 403 B; 1.962,7 ms |
  | Constrained 20/5 Mbps, network emulation latency 40 ms cold | 44.152.458 B; 18.187,9 ms | 44.150.970 B; 18.236,6 ms |
  | Constrained warm | 11.513 B; 1.904,7 ms | 403 B; 1.816,9 ms |

  Bytes lấy từ CDP `Network.loadingFinished.encodedDataLength` của origin local; **không phải** CDN edge hit hay content size trên đĩa. External font traffic được đo riêng (~124.466 bytes trong cold run). Các giá trị times chỉ là elapsed tới khi loader báo đủ 16 GLB; `gateMs` trong raw JSON là elapsed tới DOMContentLoaded, chưa xác minh thời điểm gate được vẽ lần đầu. Mọi lần đo có 0 page errors trong scope đo.
- **Frame-gap cần điều tra thêm:** constrained **warm** median frame-gap average của candidate tăng **+1,3 ms** ở 3 cặp đầu (vượt target delta dưới 1 ms), lần 3 cặp lặp lại tăng **+0,7 ms**. Giữ cả [run đầu](../tools/perf/results/delivery-local-browser-constrained.json) và [run lặp](../tools/perf/results/delivery-local-browser-constrained-repeat.json), không đổi ngưỡng. Do đó local protocol/release **PASS**, nhưng browser performance gate **MIXED / cần P4 tái hiện và đánh giá**. Frame p95/max cũng được ghi trong raw file; không tuyên bố cải thiện FPS.
- **P3 local pass:** test raw HTTP có 200/304/406, ETag identity/br/gzip, HEAD Content-Length, mutable invalidation, immutable integrity, release switch/rollback và private endpoint isolation. Preview chỉ nhận upstream loopback, không nhận target từ header/query.
- **P4 và provider verification:** Chrome thật WebGPU/WebGL2/fallback, desktop/mobile, 3 cặp A/B cold/warm, CDP transfer bytes và cached/not-cached, profile 20 Mbps/5 Mbps/40ms, frame-gap; load/soak 30 ngày dataset; origin egress thực và tính giá theo vendor. Những kết quả này **không được tự suy diễn từ native tests P3**.
- **Public gate:** license mỗi model/render rõ, TLS, origin access, SSO Ops, retention/privacy policy, backup encrypted off-host, restore drill ngoài máy, production hardware measurements, alert delivery và người vận hành. Single SQLite writer vẫn là single point of failure.
