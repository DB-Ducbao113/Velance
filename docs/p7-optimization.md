# VELANCE P7.2 — On-demand GLB loading và đo cold visit

**Phạm vi:** thay đổi hành vi runtime VELANCE (không thay dữ liệu GLB/WebP, không triển khai cloud). Test bằng Node24 và Chrome trên private loopback immutable release.

## Baseline và nguyên nhân

P4 historical trên Mac M5 tải **16 GLB** trong một cold visit (~**43,311,520 bytes** nội dung GLB) và tổng khoảng **44,15 MB** browser transfer. Trong `src/engine/showroom.js` cũ, `init()` gọi `enqueueAround(focus)` đưa cả 16 GLB vào queue và `prefetchAll()` sau focused buffer, bất kể visitor chọn xe nào. CDN cache giảm origin transfer, không giảm bytes browser lần đầu.

## P7 demand-driven behavior

- Một cold visit chỉ gọi `prioritize(focus)` và fetch **một GLB** được chọn bởi `car` URL hoặc xe mặc định. Toàn bộ 16 bay/labels/placeholders vẫn xuất hiện; các GLB chưa yêu cầu chưa tải.
- `next`, `prev`, drag release hoặc switch rear row yêu cầu model mới khi người dùng chuyển đến; drag preview không mở request cho từng bay khi pointer vẫn kéo.
- Khi người dùng **chủ động** bấm `FULL GALLERY`, queue mới được mở rộng đủ 16 theo khoảng cách từ focus, tải giới hạn (2 simultaneous mobile, 4 desktop). GLBs đã tải dùng cache/memory; không request lại do đã có trong `cars`.
- Selected view có WebP preview **chỉ khi** GLB chưa sẵn sàng, sau đó dỡ preview và hiển thị 3D. Nếu fetch/model fail, preview editorial thay thế và màn loading không bị treo.
- Không auto-prefetch cả bộ, không dùng URL public/cloud. `src/engine/load-policy.js` là policy thuần và `tools/p7/test/load-policy.mjs` kiểm thử order/invalid values.

## Kiểm thử thực tế và tiêu chí

```bash
node --test tools/p7/test/load-policy.mjs
node tools/p7/browser_lazy.mjs --out tools/perf/results/p7-lazy-browser-20261117-samplingfix.json
node tools/p7/check.mjs --mode evidence --browser tools/perf/results/p7-lazy-browser-20261117-samplingfix.json \
  --out tools/perf/results/p7-local-acceptance-20261117-samplingfix.json
```

`browser_lazy.mjs` dùng một Chrome headed, **2 browser contexts** WebGPU/WebGL2 trong một máy Mac/GPU; mỗi context cold cache, kiểm tra 1 model ở startup, sau navigation đúng 2 GLB, selected và rear-row loading, full overview đủ 16, backend đúng, không có error. Kiểm tra thêm privacy UI Allow/Withdraw (không có POST do không gắn upstream). Đo encoded browser network bytes từ Chrome DevTools Protocol (origin riêng với third-party), không suy đoán từ file size. Không phải kiểm định WAN, 100 real browsers hoặc CDN provider.

**Giới hạn QA:** scripts P4 cũ giả định `loaded===16` ngay sau cold load, nên **không tương thích với hành vi mặc định P7**; báo cáo P4 cũ giữ nguyên làm historical benchmark, không được coi là full browser evidence cho SHA hiện tại. Với P7 phải dùng browser harness mới hoặc yêu cầu overview để tải đủ model trước khi test tính năng 16 xe. P4/P3/P2 native security regression vẫn chạy độc lập.

## Kết quả Chrome P7 (final after 1Hz sampling fix)

| Chrome backend | First machine ready | Cold local transfer | Cold third-party | Khi mở overview | Lỗi |
| --- | ---: | ---: | ---: | --- | --- |
| WebGPU | 608 ms | **1,940,806 bytes** | 124,466 bytes | 16/16 loaded | 0 |
| WebGL2 | 577 ms | **1,940,806 bytes** | 124,466 bytes | 16/16 loaded | 0 |

Browser report: [`tools/perf/results/p7-lazy-browser-20261117-samplingfix.json`](../tools/perf/results/p7-lazy-browser-20261117-samplingfix.json), Chrome `157.0.8103.79`, Node `24.21.0`. Hai context trên **cùng một Mac/GPU**, không phải hai thiết bị độc lập. Kết quả 1.94 MB là traffic origin-local tính tới sau GLB đầu tiên + 1,2 giây idle; lịch sử P4 ~44.15 MB đo hành vi cũ tải 16 GLB. Hai điểm dừng hành trình khác nhau, nên không diễn giải thành tỷ lệ cải thiện production có kiểm soát. Sau khi chọn thêm xe, xem ảnh editorial và tải đủ gallery, tổng local transfer P7 trong harness là ~48.49 MB mỗi backend — lazy loading trì hoãn, **không xóa** bytes cần tải khi xem toàn bộ.

Phiên bản đầu trước bản sửa sampling được giữ ở `p7-lazy-browser-20261117.json` làm evidence trung gian, không dùng thay cho report của release mới. Cần kiểm thử iPhone/Android/4G/WAN CDN trước khi đo hiệu suất production.
