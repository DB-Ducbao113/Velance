# VELANCE P3 — Local delivery/release runbook

**Phạm vi:** chạy trên loopback, dùng source public hiện tại và một thư mục release riêng do người chạy tạo ra. Không public Internet, không tạo cloud resource, không cấu hình DNS/TLS, không push/commit, không sửa `tools/ops/telemetry.db`. Phải có Node.js 24+.

## 1. Nghiệm thu native trước

```bash
node tools/delivery/check.mjs
```

Quality gate kiểm tra syntax P3, các native test protocol/security/release, sau đó gọi lại P2 gate. Các test sử dụng temporary root/DB/process và tự cleanup. Kết quả pass không đại diện hiệu năng browser hoặc CDN thật.

### Evidence và phép đo lặp lại

```bash
# HTTP probe + real-source snapshot, chỉ localhost, DB fixture.
node tools/perf/delivery.mjs

# Chrome headed, 3 paired A/B runs theo hai network profiles.
node tools/perf/delivery.mjs --browser --runs 3 --profile loopback \
  --out tools/perf/results/delivery-local-browser-3.json
node tools/perf/delivery.mjs --browser --runs 3 --profile constrained \
  --out tools/perf/results/delivery-local-browser-constrained.json

# Browser open-tab release switch/rollback trên synthetic source.
node tools/perf/release_switch.mjs
```

Trong phiên 17/11/2026 native gate đạt **24/24 P3 + 30/30 P2**, 9 syntax checks. JSON tổng hợp: [delivery-p3-acceptance.json](../tools/perf/results/delivery-p3-acceptance.json); TAP: [P3](../tools/perf/results/delivery-p3-native.tap) và [P2](../tools/perf/results/delivery-p3-p2-regression.tap). Browser A/B sử dụng cache bật, fresh context cho cold và reload cho warm; có 3 cặp luân phiên mỗi profile. Giới hạn constrained là 20 Mbps down, 5 Mbps up, latency 40 ms, CPU 1×. Thời gian tới đủ 16 GLB và dữ liệu network CDP không chứng minh CDN provider hoặc 30-day load SLO.

**Không coi frame gate là PASS tuyệt đối:** constrained warm frame-gap trung vị lệch +1,3 ms ở ba cặp đầu, +0,7 ms ở ba cặp chạy lại (mục tiêu dưới 1 ms). Raw đều được giữ: [đầu](../tools/perf/results/delivery-local-browser-constrained.json) và [lặp](../tools/perf/results/delivery-local-browser-constrained-repeat.json). P4 cần xét lại bằng headed journeys đầy đủ, thêm WebGL2/fallback, desktop/mobile và screenshot; những phần này chưa được chạy trong P3 test harness.

## 2. Snapshot từ public files

```bash
# Tại VELANCE repo root; giữ riêng thư mục ngoài repo và không chia sẻ công khai.
DELIVERY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/velance-release.XXXXXX")"
chmod 700 "$DELIVERY_DIR"

node tools/delivery/release.mjs snapshot --source-root . --store-dir "$DELIVERY_DIR"
```

Lệnh trả JSON có `id` là SHA-256 64 ký tự hex, `root` và `manifest.files` với size/hash của từng file. Lưu `id` thực từ output vào biến phiên terminal:

```bash
RELEASE_ID="<64-digit-sha256-from-output>"
node tools/delivery/release.mjs verify --store-dir "$DELIVERY_DIR" --id "$RELEASE_ID"
node tools/delivery/release.mjs activate --store-dir "$DELIVERY_DIR" --id "$RELEASE_ID"
```

Không sửa trực tiếp nội dung `$DELIVERY_DIR/releases/$RELEASE_ID/`. Release immutable là định danh của nội dung. Đổi source public rồi snapshot tạo ID khác. Snapshot đã có cùng ID không bị ghi đè.

## 3. Preview trên local

```bash
# Chỉ public static release; không có upstream collector.
node tools/delivery/server.mjs --host 127.0.0.1 --port 8081 --store "$DELIVERY_DIR"
```

Mở `http://127.0.0.1:8081/`. Trả 307 `no-store` sang `/r/<release-id>/index.html`. Trên URL release, JS/asset relative sẽ giữ cùng `/r/<release-id>/`. Khi không có `--upstream`, HTTP document không có `X-Velance-Ops`, collector không tự bật. Mọi `/ops`, `/api/summary`, `/api/sessions`, `/metrics`, private DB/sources trên preview phải trả 404.

Khi cần kiểm thử end-to-end telemetry, chạy private Ops backend trên **DB fixture**, ở terminal khác:

```bash
node tools/ops/server.mjs --host 127.0.0.1 --port 8090 --db "$DELIVERY_DIR/fixture.db"
```

Sau đó dùng cổng preview khác, cấu hình upstream **cố định là loopback**:

```bash
node tools/delivery/server.mjs --host 127.0.0.1 --port 8082 \
  --store "$DELIVERY_DIR" --upstream http://127.0.0.1:8090
```

Trong cấu hình này, chỉ `POST /api/telemetry` đi qua proxy tới private backend. Preview tự rewrite Host/Origin upstream, không forwarding Cookie/Authorization/X-Forwarded headers người dùng; JSON không cache. Chỉ tài liệu HTML mới được gắn capability header cho collector. Không tồn tại endpoint proxy URL tùy ý.

## 4. Kích hoạt release kế tiếp và rollback

```bash
node tools/delivery/release.mjs snapshot --source-root . --store-dir "$DELIVERY_DIR"
NEW_RELEASE_ID="<new-id-from-output>"
node tools/delivery/release.mjs activate --store-dir "$DELIVERY_DIR" --id "$NEW_RELEASE_ID"

# Khi cần rollback active pointer:
node tools/delivery/release.mjs rollback --store-dir "$DELIVERY_DIR"
```

Activation/rollback chỉ thay atomic `active.json` sau verify; release cũ vẫn tồn tại để một tab đã mở có thể tiếp tục request file `/r/OLD/...`. Các URL immutable vẫn mang ID cũ; không purge hoặc overwrite. Không tự xóa thư mục release dù có version cũ: đó là quyết định retention release riêng.

## 5. Kiểm tra HTTP

```bash
curl -I http://127.0.0.1:8081/
curl -I "http://127.0.0.1:8081/r/$RELEASE_ID/index.html"
curl -i -H 'Accept-Encoding: br' "http://127.0.0.1:8081/r/$RELEASE_ID/src/ui/app.js"
curl -i http://127.0.0.1:8081/ops/
curl -i http://127.0.0.1:8081/api/summary
```

HTML/JS/CSS có ETag riêng cho representation identity/br/gzip và `Vary: Accept-Encoding`. Kiểm tra 304 với `If-None-Match`, 406 khi mọi representation bị từ chối và độ dài body sau nén. GLB/WebP giữ identity. Với mutable dev, `Cache-Control: no-cache` cho phép browser revalidate. Với versioned release, `Cache-Control: public,max-age=31536000,immutable`.

## 6. Những điều chưa có

- Preview không có mạng CDN/PoP, TLS, object storage, access gateway, WAF, geo-routing hoặc origin shielding thật.
- Lần kiểm thử local không phản ánh số byte qua Internet, latency đa khu vực, ISP khác nhau, CDN hit/miss, pricing hay throughput cloud.
- Đã có Chrome CDP fresh/warm theo 3 cặp/profile và browser release switch trên fixture; **chưa** có GPU journey đủ WebGPU/WebGL2/fallback, desktop/mobile, cũng chưa có kết quả CDN edge mạng thật. Không dùng kết quả warm 403 byte để kết luận frame timing hoặc throughput đều tốt hơn.
- Chưa được phép công khai GLB, ảnh render hoặc backup cho đến khi xác minh license, quyền truy cập và các public readiness gates.

Chi tiết hệ thống và công thức tính traffic: [delivery-system-design.md](delivery-system-design.md).
