# P6 — Security, consent và privacy gate

**Giới hạn:** local controls P2–P3 có native regression, chưa có kiểm thử từ Internet hay bên thứ ba. P6 bổ sung `tools/p6/test/security.mjs` và fail-closed contract. Xem [P5 checklist C01–C04, E05](p5-public-launch-checklist.md).

## Threat model

| Rủi ro | Ranh giới hiện thực local | Điều kiện phải kiểm chứng trước private provider/public |
| --- | --- | --- |
| Lộ source, master, secrets, DB, WAL/SHM, Ops | Immutable allowlist + release manifest, 404, HEAD/GET negative matrix | Origin ACL, deny object listing và direct-origin bypass, external scan |
| Path traversal, percent alias, route normalization/cache poisoning | `BAD_PATH` hoặc `NOT_FOUND` trên local preview; SHA route; ETag | CDN và proxy phải preserve canonical semantics; real PoP cache-key tests |
| CSRF/CORS, credential/header forwarding | Loopback proxy Host/Origin/fetch checks, telemetry only exact POST, drop auth/cookies/XFF | Cross-site browser tests, gateway must strip spoofed auth and not reflect wildcard CORS |
| Payload flood / availability / storage | JSON cap 256KiB, P2 ingress rate/backpressure, private backend 503, public static unaffected | WAF distributed rate rules, quotas, origin DDoS, exhausted limits/alerts |
| Admin bypass | Ops is inaccessible via local delivery server | IdP SSO/MFA, role enforcement, VPN, break-glass, audited authorization on every private endpoint |
| Leak via logging, telemetry | Backend logger allowlisted request metadata; client redacts error message URL/token patterns | No raw edge logs to third parties by default, privacy/legal review, log access/audit/deletion |
| Asset legal exposure | Register SHA identities; 96 `UNVERIFIED` | Chain of title, 3D/render derivative license, brand/vendor, authorized signoff |
| Supply chain | `tools/vendor/verify.mjs` and native CI | SBOM/CVE/license scanning and pinned actions/deps with policy review |

## Dữ liệu telemetry hiện tại và yêu cầu consent

Client [`src/telemetry/collector.js`](../src/telemetry/collector.js) hiện có cơ chế tắt (`?notelemetry`, localStorage `velance_telemetry_off=1`) nhưng **chưa có opt-in consent và privacy notice được phê duyệt**. Script chỉ bật sau khi nhận header `x-velance-ops: 1` từ preview proxy có upstream; việc này **không đồng nghĩa với consent**. Do đó staging contract mặc định **disable telemetry**; tuyệt đối không bật proxy trên Internet chỉ vì server hỗ trợ.

Payload có session UUID, seq, mốc thời gian, backend WebGPU/WebGL2/images, FPS/drawcalls/geometry, samples và events; context có UA, kích thước màn hình, DPR, cores, memory, network class, feature flags; lỗi có chuỗi được redact heuristic. Các mục này có thể là dữ liệu cá nhân hoặc fingerprint khi kết hợp. Backend phải giữ mục đích đo hiệu năng, không mở rộng sang hành vi cá nhân khi chưa phê duyệt.

**G1/C03/C04 phải có trước kích hoạt:** thông báo ngôn ngữ người dùng (purpose/data/controller/contact/storage country/retention/processors), positive opt-in UI và versioned consent record, withdrawal và opt-out enforcement phía thu thập, export/delete request workflow, retention tách session/sample/event/batch/log/backups, DPA/DPIA nếu cần, kiểm định xoá theo backup lifecycle, legal/privacy signoff. Không đưa ID người dùng, IP, cookie hay token vào logs làm debug. Quyết định retention, lawful basis, owner và quyền xóa chưa được xác nhận: **`BLOCKED`**.

## Bài kiểm tra native

Chạy Node24: `node tools/p6/check.mjs --mode native`. Test P6 có fixture private độc lập trong `os.tmpdir()`, fake assets do test tạo. Với upstream telemetry, test HTTP server loopback trong test process; không mở DB thật, không đụng cloud. Kiểm thử denied private routes, encoded aliases/traversal, ETag, 304, method restrictions, Host/Origin rejection, oversized 413, unsupported media 415, no public POST unless configured, upstream down 503, no leaked credentials, static still serves. P2/P3/P4 native regression chạy lại và ghi kết quả.

Đối với các điểm chưa test: browser consent UX, IdP 2FA/RBAC, WAF, secret rotation, TLS, origin bypass, 24h soak và external pen test phải cung cấp evidence provider riêng. **Native PASS không thể kết thúc G1 hay G4.**
