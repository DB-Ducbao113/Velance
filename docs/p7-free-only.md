# VELANCE — P7.3 Free-only private staging

## Quyết định ngân sách (17/11/2026)

**Ngân sách hạ tầng mới: 0 VND.** Không mua VPS, domain, CDN, managed DB, storage, WAF hoặc support. Không dùng free trial có nguy cơ chuyển sang trả phí, không tạo account yêu cầu thẻ hoặc thiết lập auto-charge, không gọi API/cloud có thể tính tiền. Tận dụng Mac/Node.js 24/Chrome/Docker đã cài; không tính điện và đường truyền máy tính cá nhân là chi phí hạ tầng mới bằng 0.

**Scope được phép:** lập trình, kiểm thử, synthetic fixture, localhost review, security/readiness documentation, private immutable release. **Scope không được phép:** public deploy, Cloudflare Tunnel/Funnel, port-forwarding, bất kỳ upstream telemetry thật, gắn domain công cộng, commit/push/merge theo điều kiện hiện tại.

**G0 vẫn BLOCKED:** 16 GLB + 80 WebP chưa được cấp phép công khai (0/96 approved), cộng 2 WebP environment thiếu hồ sơ quyền. Local private review không nâng tình trạng bản quyền. **G4 public NO-GO**.

## Công cụ mới không cần npm install, Docker hoặc tài khoản

`tools/p7/free-staging.mjs` tái sử dụng `tools/delivery/release.mjs` và `tools/delivery/server.mjs`. Phần cốt lõi chỉ dựa trên Node.js 24 và repo hiện tại.

### Kiểm thử an toàn hoàn toàn synthetic

```bash
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node tools/p7/free-staging.mjs --mode smoke
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node tools/p7/check.mjs --mode native
```

Smoke mode tạo một source fixture mới trong thư mục temp hệ thống, gồm HTML/JS/CSS, byte giả không phải GLB/WebP thật, file .env, fake DB, fake Ops và fake original. Nó tạo release immutable, verify hash và active pointer, bind HTTP **duy nhất 127.0.0.1** với port do OS cấp, thử GET/HEAD/ETag/304 và deny private paths, Host/Origin lạ, traversal, telemetry POST, rồi đóng server và xóa temp trong `finally`. Không chạm `tools/ops/telemetry.db` hoặc gửi gì tới provider.

### Xem full website với assets thật — chỉ trên máy

```bash
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node tools/p7/free-staging.mjs --mode review --port 8091
```

CLI in ra URL dạng `http://127.0.0.1:8091/r/<sha256>/index.html`. URL chứa SHA chính xác của source worktree hiện tại. Chỉ mở trong trình duyệt trên **chính máy**. Phải giữ terminal đang chạy trong lúc xem; **Ctrl+C** để đóng server và xóa temp release.

Review mode sao chép **public allowlisted source** vào private temporary immutable store, không bao gồm `tools/`, `ops/`, `docs/`, master PNG, .env, original GLB hoặc telemetry DB. Đây là local-only evaluation của các file chưa có quyền public, **không** phải staging đã bảo vệ trên Internet. HTTPS/TLS/WAF/CDN/IdP không tồn tại ở localhost; các gate provider được giữ `NEEDS_PROVIDER_TEST`.

Trang vẫn có link fonts Google do website hiện tại cấu hình; trình duyệt có Internet có thể tải fonts từ Google. Không đồng nghĩa cloud deployment hay giao telemetry. Muốn kiểm thử không có mạng ngoài, sử dụng DevTools Network để chặn yêu cầu third-party hoặc kiểm thử offline.

### Đo và kiểm tra

```bash
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node --test tools/p7/test/free-staging.mjs
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node tools/p7/browser_lazy.mjs --out tools/perf/results/p7-lazy-browser-<new-label>.json
```

Script browser còn kiểm chứng WebGPU/WebGL2 và 1-GLB cold load; mở `FULL GALLERY` là yêu cầu tải đủ 16 model. Không sử dụng các bằng chứng này để tuyên bố CDN/cloud or worldwide capacity pass.

## Lựa chọn hosting miễn phí khi đã có quyền assets

**Chưa kích hoạt bất kỳ dịch vụ nào.** Về lâu dài, có thể đánh giá **Cloudflare Pages Free** cho phần static-only vì cung cấp `*.pages.dev` và CDN mà không cần tự mua domain; tại thời điểm kiểm tra tài liệu chính thức tháng 11/2026, Free có giới hạn khoảng **500 builds/tháng**, **20.000 files/site** và **25 MiB/file**. Đây là giới hạn gói, không phải sự đảm bảo không thể phát sinh phí trong mọi tình huống; cần kiểm tra chính sách billing trước khi đăng ký. Dự án hiện 126 file public và models dưới 25 MiB/file trong bản P7, nhưng số liệu publish vẫn phụ thuộc giới hạn của provider và quyền tài sản. Xem:

- [Cloudflare Pages — Limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare Pages — Overview](https://developers.cloudflare.com/pages/)
- [Cloudflare Billing — FAQ](https://developers.cloudflare.com/billing/understand/faq/)

Không chuyển `POST /api/telemetry`, SQLite write/read/metrics/Ops/private backup lên Cloudflare Pages theo mô hình static-only: các phần này là **backend riêng**, không tự nhiên có miễn phí bảo đảm hoặc phù hợp privacy/ops. Cloudflare Pages static không thay SSO/MFA, origin private, off-host DR hay 24–72h soak thực tế.

**Không chọn AWS Free Tier/trial hoặc VPS "free credits" làm mặc định**: có giới hạn và điều kiện thanh toán, không phù hợp yêu cầu không thẻ và 0 đồng tuyệt đối. **GitHub Pages** cũng không phải lời giải production cho VELANCE hiện tại vì các điều khoản về website thương mại/traffic, tính công khai asset, và không thay backend/DB; xem [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

## Điểm dừng và điều kiện để tiến bước

| Hạng mục | Hiện tại | Còn thiếu |
| --- | --- | --- |
| Free-only local preview | PASS_LOCAL | Không có |
| Immutable release, HTTP deny paths | PASS_LOCAL | Provider auth/TLS/WAF chỉ cần nếu thực sự xuất bản |
| G0 rights | BLOCKED | 96 từng file + 2 environment + fonts/vendor/brand |
| G1 privacy | CLIENT_LOCAL_TESTED | DPO/legal notice, retention/delete, consent enforcement phía server |
| G2 WAN/cloud | NOT RUN | Provider free hợp lệ + quota + networking + mobile/WAN testing |
| G3 DR/alerts | LOCAL FIXTURES ONLY | Off-host restore và delivered alerts; không tuyên bố miễn phí production |
| G4 Public | NO-GO | Independent owner sign-off |

Tại ngân sách 0, có thể tiếp tục nâng cấp frontend, QA, security code, local capacity và hồ sơ bản quyền **mà không cần bất kỳ phê duyệt chi tiêu nào**.
