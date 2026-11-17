# P7 — Telemetry: explicit consent và withdrawal

**Phạm vi:** client `src/telemetry/collector.js` và fixture `tools/p7/test/consent.mjs`. Kiểm định trên Node.js 24 với sandbox browser; **không phải privacy/legal approval**. Chưa triển khai public provider, chưa tạo consent service, chưa gửi dữ liệu thật, không chạm `tools/ops/telemetry.db`. P6 [security/privacy gate](p6-security-privacy.md) và P5 [public launch checklist](p5-public-launch-checklist.md) vẫn **BLOCKED / NO-GO**.

## 1. Ranh giới kích hoạt

| Trạng thái | HEAD kiểm tra `x-velance-ops` | UUID/context/timers | POST `/api/telemetry` |
| --- | --- | --- | --- |
| Mặc định, chưa quyết định | Không | Không | Không |
| `?notelemetry` | Không; override tuyệt đối trên URL hiện tại | Không | Không |
| Legacy `velance_telemetry_off=1` | Không cho đến khi bấm nút Allow | Không | Không |
| `localStorage` thiếu/hỏng/bị chặn, consent hết hạn hoặc version không khớp | Không | Không | Không |
| Nhấn **Allow optional diagnostics** (hoặc bản ghi hợp lệ từ lần nhấn trước) | HEAD một lần cho mỗi activation | Chỉ tạo sau khi HEAD thành công với header đúng | Chỉ có thể gửi sau activation thành công |
| Nhấn **Withdraw permission** | Không HEAD mới; abort HEAD đang chờ | Xóa session trong bộ nhớ, dừng timers và listeners | Ngừng batch mới; abort POST đang chạy nếu browser hỗ trợ |
| HEAD không hỗ trợ Ops hoặc thất bại | HEAD đã thử nếu có consent | Không tạo UUID/context hay timers | Không |

Client có `<details>` cố định ở góc màn hình, `<summary>` dùng được với bàn phím, nút Allow/Withdraw và vùng thông báo `role="status"`/`aria-live="polite"`. ID: `#velance-telemetry-settings`, `#velance-telemetry-allow`, `#velance-telemetry-withdraw`. UI được tạo từ chính collector bằng CSS scoped, không sửa `index.html` hoặc theme chính. Người dùng luôn có thể mở phần Settings và thu hồi khi đang ở trang. Nếu `?notelemetry` tồn tại, nút Allow ẩn và không thể override bằng local preference; nút **Keep diagnostics disabled** vẫn cho phép xóa grant cũ khỏi storage và ghi nhận opt-out.

`window.__VELANCE_TELEMETRY__.consent` trả về `off`, `granted` hoặc `forced-off`; `.enabled` chỉ đúng sau HEAD thành công, không đồng nghĩa với quyền pháp lý hay trạng thái server đã lưu dữ liệu. `.session` là UUID trong bộ nhớ, null khi tắt/withdraw.

## 2. Cơ chế nhớ lựa chọn

- Key mới: `localStorage["velance_telemetry_consent_v1"]` với JSON `{"version":1,"decision":"granted","at":<Unix timestamp milliseconds>}`. Chỉ tạo khi nhấn Allow; không tự ghi grant khi nhìn thấy capability header. Bản ghi grant có giá trị tối đa **90 ngày** theo đồng hồ thiết bị, không chấp nhận mốc thời gian tương lai quá 60 giây. Thay đổi version yêu cầu consent lại.
- Legacy key `velance_telemetry_off=1` luôn được ưu tiên khi load. Khi người dùng **chủ động** Allow, client xóa key legacy; khi Withdraw, xóa record grant và đặt legacy off. Hai thao tác không chuyển một flag server-side nào thành “đã duyệt privacy”.
- Khi `localStorage` bị chặn hoặc lỗi: lựa chọn Allow chỉ có hiệu lực trong trang hiện tại; trang tải lại mặc định off. Không có cookie, IndexedDB hoặc fallback tracking khác.
- Consent tồn tại trong browser storage, không phải consent audit log đáng tin cậy. Record có thể bị sửa/xóa trên client và không được server xác thực. Thời gian từ đồng hồ thiết bị chỉ đủ làm guard UX, không đủ chứng cứ pháp lý.

## 3. Những dữ liệu có thể gửi sau consent

Mỗi session dùng UUID ngẫu nhiên, batch `seq`, `startedAt`, browser user-agent (cắt 512 ký tự), coarse/mobile flag, kích thước màn hình, DPR, số logical cores, class bộ nhớ và kết nối khi có, WebGPU/reduced motion. Các mốc vào trang/first frame/first car/all loaded, backend `webgpu`/`webgl2`/`images`, tốc độ khung hình, thời gian render, draw calls, polygons/loaded, pixel ratio, heap và một số sự kiện tương tác. Lỗi engine/runtime được redact heuristically (URLs, chuỗi token/password/secret/authorization/API key, query) nhưng **không có bảo đảm đã loại bỏ mọi PII**. Dữ liệu user-agent, device fingerprint có thể nhận diện gián tiếp. Header, IP và raw access logs tại edge/proxy là trách nhiệm hệ thống; client không thể ngăn hạ tầng ghi chúng.

Đích HTTP duy nhất khi collection hoạt động là exact `POST /api/telemetry` với JSON và `Content-Type: application/json`. Điều kiện kích hoạt từ `HEAD location.pathname` với `X-Velance-Ops: 1` là **capability gate**, không phải consent. `navigator.sendBeacon` có thể được gọi trước `pagehide`/khi tab ẩn **chỉ nếu vẫn có consent**. Khi Withdraw, collector abort những `fetch` còn chờ, xóa batch trong memory và dừng timer, nhưng các POST/beacon **đã rời thiết bị hoặc đã được server ACK không thể thu hồi** từ browser. Không thể cam kết rằng server đã xóa dữ liệu sau khi Withdraw.

**Tương thích lazy-load P7:** sampling 1 Hz được phép bắt đầu ngay khi **GLB đầu tiên** tải xong và collector đã được cấp consent; không chờ `loaded===16`. Milestone `firstCar` ghi khi nhận được model đầu tiên. Probe 250 ms tiếp tục chạy để ghi `allLoaded` nếu người dùng chủ động mở toàn cảnh và tải đủ 16 xe; `allLoaded=null` là bình thường khi chỉ xem một xe, không được xem là mất telemetry. Các phase `home-idle`, `browse`, `selected-orbit`... được xác định theo trạng thái tương tác sau `firstCar`, không gán sai toàn bộ phiên thành `boot`.

## 4. Kiểm thử cục bộ

```bash
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node --check src/telemetry/collector.js
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node --test tools/p7/test/consent.mjs
```

Fixture dùng VM in-memory, mô phỏng DOM, timers, `localStorage`, HEAD/POST và AbortSignal; không khởi tạo server, không tạo DB hoặc gửi network ngoài. Các ca xác minh: default off; Allow rồi mới HEAD/POST; Withdraw ngừng gửi, không resurrect session; version/TTL/legacy override; `?notelemetry`; HEAD muộn sau withdraw; BFCache restore; POST in-flight abort và grant mới; storage unavailable; backend thiếu capability; DOM sẵn sàng muộn. Bài test P2 `tools/ops/test/collector.mjs` trước P7 kỳ vọng auto-activation; fixture cũ cần thao tác Allow hoặc cung cấp record consent hợp lệ trước các assertion về POST/HEAD. Không được giữ auto-activation để chạy xanh test legacy.

## 5. Các gate chưa được giải quyết

**Privacy/legal `BLOCKED`.** UI hiện có mô tả kỹ thuật và cảnh báo thông tin pháp lý còn thiếu, chỉ sử dụng cho local fixture/preview. Trước bất kỳ public telemetry thật nào, Privacy/DPO/Product/Legal phải duyệt text cuối cùng và ngôn ngữ hiển thị, mục đích/lawful basis, data controller và thông tin liên hệ, nơi lưu trữ, bên xử lý và DPA, retention theo cấp dữ liệu/backup/log, consent audit strategy, user access/export/delete & withdrawal pipeline, deletion SLA và kiểm định xóa từ replicas/backups. Frontend consent không thể thay cho backend enforcement, server-side consent verification, retention/deletion hoặc ký duyệt tài sản. Public launch vẫn NO-GO với 0/96 quyền asset được phê duyệt.
