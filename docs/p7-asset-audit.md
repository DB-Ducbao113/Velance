# VELANCE P7 — Kiểm toán asset, release SHA và quyền phân phối

**Kết quả kiểm tra local ngày 17/11/2026:** `PASS_LOCAL` cho tính toàn vẹn file và phép đối chiếu inventory; **G0 BLOCKED — Public NO-GO**. Quyền đã được người có thẩm quyền xác minh độc lập: **0/96**. Hai ảnh môi trường đã có trong public release nhưng **chưa có mục khai báo quyền trong P5 register**. Không có giấy phép hoặc approval mới được tạo trong P7.

## 1. Phạm vi và nguồn sự thật

| Nguồn | Chức năng | Khả năng xác nhận |
| --- | --- | --- |
| [`docs/p5-asset-rights-register.json`](p5-asset-rights-register.json) | Danh mục từng file, `bytes`, SHA-256, trường provenance/reviewer/permission | Trạng thái kê khai quyền; hiện 16 GLB + 80 WebP, tất cả `UNVERIFIED` |
| [`assets/models/manifest.json`](../assets/models/manifest.json) | SHA-256/size của 16 GLB public | Đồng nhất từng GLB với register và release |
| [`tools/delivery/release.mjs`](../tools/delivery/release.mjs) | Tạo immutable snapshot local và `manifest.json`, xác nhận snapshot bằng `verifySnapshot` | Mọi file public có checksum/byte size, ID SHA-256 toàn manifest, symlink/extra-file checks |
| [`tools/p7/rights.mjs`](../tools/p7/rights.mjs) | Cross-check 3 nguồn, hash lại từng file public trong source, scan các media bổ sung | Gate máy kiểm tra *tính toàn vẹn*, tự động phát hiện thiếu inventory; **không cấp phép pháp lý** |
| [`tools/p7/test/rights.mjs`](../tools/p7/test/rights.mjs) | Fixture 16 GLB + 80 WebP + 2 environment và mutation tests | Phát hiện lệch hash, fake approval, thiếu/trùng path, source mutation, symlink |

Không sử dụng tên file có chữ `free`, SHA khớp, hình render lại, nguồn manufacturer hiển thị trong `src/data/vehicles.js` hoặc sự tồn tại trên mạng làm bằng chứng quyền sử dụng. Cần xác định tác giả/chủ sở hữu của **model gốc**, chain of title, điều khoản chuẩn xác, quyền sửa đổi/chuyển đổi, phân phối file qua WebGL/CDN, quyền sử dụng thương mại, ảnh derivative/texture/HDRI, attribution và bằng chứng reviewer độc lập.

## 2. Cách chạy kiểm toán và giữ bằng chứng

Chạy tại repository root, Node **24+**:

```bash
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node --test tools/p7/test/rights.mjs
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node tools/p7/rights.mjs
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node tools/p7/rights.mjs --out tools/perf/results/p7-rights-audit-<unique-label>.json
git diff --check
```

`--out` chỉ chấp nhận tên `tools/perf/results/p7-rights-audit-*.json` và tạo mới bằng `wx`, không ghi đè evidence cũ. Không bắt buộc tạo report mỗi lần chạy: lệnh không tham số xuất cùng trường JSON ra stdout. CLI không sửa asset, register, manifest model hay release hiện hữu: snapshot được tạo trong thư mục tạm bên ngoài repo, `verifySnapshot` kiểm tra rồi xóa trong `finally`.

**Exit 0 + `localAudit=PASS_LOCAL`**: inventory P5 đúng 16+80; sha+size của các mục đúng với manifest immutable, source byte và manifest model; release ID là SHA-256 nội dung manifest; scan public media không phát hiện file media ngoài snapshot. **Không có nghĩa G0 được phép GO**. Report luôn nêu `publicLaunch=NO_GO`, `g0LegalGate=BLOCKED` và `legalDistributionAuthorizedByAudit=false` vì máy không thể chứng thực quyền tác giả/hợp đồng/chữ ký pháp lý.

**Exit 1 + `FAIL_CLOSED`**: file bị sửa, thiếu, symbolic link, SHA/size lệch, ID/manifest không hợp lệ, file media công khai không xuất hiện trong immutable manifest, register khai sai/thừa/thiếu/đụng path, metadata phê duyệt không đủ. Kết quả này là failure của gate toàn vẹn, cần sửa chính xác nguồn lệch hoặc xác lập lại hồ sơ. Không chữa lỗi bằng cách giả mạo `approvalStatus=APPROVED` hoặc bổ sung thông tin chưa được xác minh.

## 3. Bằng chứng máy P7 tại thời điểm chạy

Report tạo mới: [`p7-rights-audit-local-20261117.json`](../tools/perf/results/p7-rights-audit-local-20261117.json). Evidence timestamp theo UTC nằm trong JSON, giá trị release ID phản ánh **snapshot tức thời của worktree đang thay đổi**.

| Chỉ tiêu | Quan sát |
| --- | --- |
| Asset trong P5 register | 16 GLB + 80 editorial WebP = 96 |
| Trạng thái | 96 `UNVERIFIED`, 0 `APPROVED`, 0 `REJECTED` |
| SHA/size register ↔ GLB manifest ↔ source ↔ immutable release | `PASS_LOCAL` tại thời điểm audit |
| Public media trong snapshot | 98: 96 được khai trong P5, 2 WebP môi trường chưa khai |
| Public asset chưa có mục rights | `/assets/environment/private_garage_1080x1350.webp` và `/assets/environment/private_garage_1920x1080.webp` |
| Media riêng nằm ngoài public release | 80 PNG master + 34 GLB ở `models_original`/`models_prepared`; chỉ là inventory, **chưa có kết luận về quyền** |
| Vendor/package code trong public snapshot | 20 path candidates; kiểm tra giấy phép và attribution riêng ở A03 |
| Snapshot trong report | 126 file, ID `4ccdc5acbdda23ebd91011965aa8cb3571cb426a9594f3651c81fc5b7b9fb671` tại lần ghi evidence |
| P4 historical release | `1f626b6c60d66af3202ae953167338e464f4c8ce49e539bbb94f92e701d0a3b6`, **khác** P7 current source |
| Kết luận pháp lý / public | `G0=BLOCKED`, `Public=NO_GO`, 0 legal sign-off được xác thực |

**Sai khác release ID là giới hạn bắt buộc phải nêu:** P4 fingerprint lịch sử là bằng chứng của source đúng tại thời điểm P4. P7 kiểm tra lại source hiện tại, không chuyển nhãn performance P4 thành bằng chứng benchmark của release P7. Cần rerun những bài test về browser/performance trên source mới trước khi gắn chúng với release mới. Repo đang có thay đổi song song nên không sử dụng ID ở bảng trên làm ID triển khai cố định.

## 4. Hồ sơ pháp lý còn thiếu và trình tự xử lý

1. **A01 — 16 GLB:** chỉ khi có original creator/source proof, điều khoản và license của chính model được dùng, cho phép modify/convert, phân phối tệp GLB self-hosted/WebGL/CDN, thương mại và attribution; loại bỏ nguồn game-rip/provenance-risk không xác thực. Đối chiếu SHA từng file và lưu chứng từ. Hiện **16/16 chưa đạt**.
2. **A02 — 80 WebP editorial:** xác định model gốc, renderer/tác giả, texture/material/HDRI/scene và quyền tạo/phát hành ảnh dẫn xuất. Cần quyền cho từng thành phẩm, không suy ra từ bản render. Hiện **80/80 chưa đạt**.
3. **A02 — 2 WebP môi trường:** cần bổ sung hồ sơ quyền *ngoài* P5 register hiện có, hoặc xử lý bằng register riêng được quản lý có reviewer và bằng chứng, không ghi đè 96 mục cũ. Cần truy nguyên chính xác môi trường dựng và thành phần texture/ánh sáng, người tạo, điều khoản công bố/commercial/attribution.
4. **A03 — media khác + third-party code + nhãn hiệu:** công cụ đã rà file media trong `assets`, `src`, `styles`, `vendor`, `packages` và liệt kê file ngoài phát hành. Cần kiểm soát thay đổi nếu media ngoài phát hành được đưa vào release sau này; soát giấy phép của GSAP/ScrollTrigger, Lenis, Three.js, decoder, carpaint package và các logo, tên thương hiệu/model xe theo điều kiện dùng thực tế. Source URL hãng xe trong danh mục chỉ cung cấp dữ liệu tham khảo, không chứng minh quyền 3D/ảnh.
5. **G0 / G4:** người chịu trách nhiệm Legal/IP xác minh tài liệu nguồn, bên cấp phép, giới hạn license, điều kiện attribution và ký duyệt. Bảo đảm signed evidence tồn tại, có quyền phát hành đúng nội dung/hash và notice hợp lệ; cập nhật hồ sơ qua review có kiểm toán. Sau đó còn G1–G4 về security, privacy, provider, capacity và vận hành trong [P5 public launch checklist](p5-public-launch-checklist.md) và [P6 acceptance](p6-acceptance.md).

Với một entry tự khai `APPROVED`, script yêu cầu đủ các trường license/provenance/quyền, timestamp/reviewer, attribution và đường dẫn file chứng cứ **có thật, không rỗng, nằm trong `docs/`**. Điều kiện này chỉ đánh giá *sự hiện diện metadata*, không xác nhận chữ ký hay tính chân thực của bằng chứng. Kể cả tự khai đủ 96/96, audit vẫn báo `NO_GO` đến khi người có thẩm quyền ký và toàn bộ public gates được nghiệm thu.

## 5. Phạm vi kiểm tra và giới hạn

- Phần `localAudit` xác minh snapshot và **source byte hiện thời**. Script không cung cấp private CDN origin ACL, TLS/WAF, quyền IAM, SSO Ops, consent, private DB, backup cloud hoặc benchmark CDN/100 người dùng thật.
- Scan media ưu tiên asset/raster/model/font/video xuất hiện trong các thư mục dự kiến chạy trên web; đường dẫn ngoài asset allowlist (ví dụ PNG master, GLB gốc) được báo là không được public snapshot. Một file không được tìm thấy qua scan không có nghĩa tất cả trademark, texture bên trong GLB hoặc quyền license dependency đã được xác minh.
- P7 chỉ tạo code, tài liệu và fixture/evidence local. Không commit, push, deploy, upload asset, sửa source/release P4/P5/P6 hay ghi đè dữ liệu telemetry hiện hữu.

## 6. Bổ sung P9: truy nguồn asset từ Sketchfab exporter (17/11/2026)

Sau báo cáo P7 ban đầu, công cụ P9 đã đọc `asset.extras` trực tiếp trong **16 GLB gốc** ở `assets/models_original/`, tìm thấy URL listing Sketchfab, uploader và nhãn Creative Commons của **đúng 16 GLB** dùng trong showroom. Đồng thời đã ghi vào `docs/p5-asset-rights-register.json` URL gốc và bằng chứng nội bộ cho 16 model, cùng liên kết model→album ảnh cho 80 WebP, **không thay bất kỳ trường phê duyệt/quyền pháp lý nào**. Sổ nguồn chi tiết, SHA-256, nhãn license và các xung đột được lưu tại:

- [P9 — bảng trích dẫn chính xác 16 model](p9-source-attribution.md)
- [P9 — source ledger 16 GLB + 80 WebP + 2 environment](p9-asset-source-ledger.json)
- [P9 — forensic nguồn model](p9-model-forensics.md)
- [P9 — provenance ảnh render](p9-render-provenance.md)

**Cảnh báo:** LaFerrari exporter gắn CC BY-NC-SA 4.0 nhưng listing hiện ghi CC BY; Ddiaz khai tham khảo phi thương mại và nguồn gốc từ Need For Speed Mobile/CSR2. Valkyrie ghi model gốc của Cascade Models. Chevrolet Corvette Stingray mới xác thực được URL gắn trong GLB exporter, chưa có kết quả trang hiện hành độc lập. Hai ảnh garage vẫn chưa có chủ sở hữu/URL/license. Các vấn đề chain-of-title này **không** được giải quyết bằng attribution.

Kiểm chứng lại:

```bash
node tools/p9/source-ledger.mjs --audit
node tools/p7/rights.mjs
```

P7 vẫn trả `PASS_LOCAL` cho SHA/inventory, `0/96 APPROVED`, `publicLaunch: NO_GO` và hai environment WebP cần xét quyền riêng. Bằng chứng nguồn P9 cho phép review chính xác hơn, **không** tự biến metadata của người đăng thành quyền phân phối công khai.
