# VELANCE P9 — Forensics nguồn gốc 16 model 3D, trạng thái quyền chưa xác minh

**Kiểm tra ngày 17/11/2026. Phạm vi: chỉ đọc 16 GLB public hiện thời và bản gốc/prepared, tìm nguồn tác giả/giấy phép; không sửa bất kỳ asset nào.** Kết quả mới là **16/16 URL Sketchfab chính xác nằm trong JSON metadata của file gốc**, **15/16 trang/author/license đã tìm được trong chỉ mục web**; toàn bộ **0/16 được cấp phép phát hành sau kiểm tra pháp lý**, **public NO-GO**. Metadata và nguồn web là *bằng chứng cần kiểm tra tiếp*, không phải approval.

Máy có **18** GLB trong `assets/models_original` nhưng hiện chỉ **16** GLB trong `assets/models`. Bản tổng hợp SHA-256, tên tác giả/URL, nguồn bằng chứng và lỗ hổng từng file: [`p9-model-candidates.json`](p9-model-candidates.json).

## Cách truy nguyên nguồn gốc — và độ chắc chắn

GLB là container binary glTF 2.0. Với mỗi file `assets/models_original/<name>.glb`, đọc header `glTF`, JSON chunk đầu tiên và các trường `asset.generator` + `asset.extras`. **Cả 16** bản gốc có `generator: Sketchfab-<version>` và `extras` chứa `author` (tên + profile URL), `title`, `source` (link model chứa Sketchfab UUID 32 ký tự) và `license` (nhãn + URL CC). Những URL này lấy **trực tiếp từ bytes**, không suy đoán từ tên xe. Các file gốc không có `asset.copyright` riêng.

Mỗi cặp được đối chiếu SHA-256 và tên node/material:

- **16/16:** hash bản gốc khác bản public đã optimize/rebake. Mỗi node/material có tên trong bản public đều có tên tương ứng trong bản gốc (đối chiếu tập hợp tên); đây là bằng chứng kỹ thuật mạnh cho cùng họ model, **không phải xác thực người cấp quyền**.
- **15/16:** hash của `models_prepared` khác hash bản public; riêng `mercedes-amg_project-one.glb` trùng hai bản. `models_prepared` là bản trung gian, không đồng nhất với phiên bản exporter ban đầu.
- Public/prepared có `asset.generator = glTF-Transform v4.5.1`, `asset.extras.velancePrepared = 2`; metadata Sketchfab (tên tác giả, URL, license) không còn trong hai bản này. Vì vậy cần giữ **attribution bên ngoài GLB** và hồ sơ nguồn trước khi có bất kỳ bản phát hành hợp lệ.
- `src/data/vehicles.js` chứa các link thông tin kỹ thuật của **hãng sản xuất xe**, không phải bằng chứng URL cấp phép của model 3D. Không chuyển các link hãng đó vào `originalSourceUrl`.

`git log --all -- assets/models` xác nhận assets public xuất hiện trong `4c330ab` (14/11/2026), mở rộng/re-optimize ở `dbaaed6` (15/11), rebake ở `69c022e` (15/11). `git ls-files assets/models_original assets/models_prepared` không có file nào vì các source này đang nằm ngoài tracked Git. Repository **không chứa** chứng từ giao dịch tải từ Sketchfab, lịch sử OAuth, invoice, ảnh chụp license ở thời điểm download hay giấy phép từ chủ sở hữu game/texture. Thời điểm, account và người thực hiện tải vẫn chưa xác minh.

## 16 URL gốc chính xác trong exporter

`CC-BY`/`CC-BY-NC-SA` dưới đây là **nhãn được nhúng trong bản exporter**, không phải quyền đã được người có thẩm quyền kiểm tra. `Indexed` nghĩa là kết quả tìm kiếm công khai của Sketchfab thể hiện đúng tiêu đề/tác giả tại URL, **không** phải đã tải lại GLB hiện thời. Web fetch trực tiếp đến Sketchfab gặp HTTP **403**, nên kiểm chứng listing thông qua chỉ mục tìm kiếm; riêng Corvette không thu được listing phù hợp để đối chứng.

| # | GLB public | Nguồn model Sketchfab (URL chính xác trong exporter) và người đăng | License nhúng → quan sát indexed | Vấn đề ưu tiên |
|---:|---|---|---|---|
| 1 | `2014_ferrari_laferrari.glb` | [2014 Ferrari LaFerrari](https://sketchfab.com/3d-models/2014-ferrari-laferrari-8b46fa49718647de846387ef4c1e95b3) — **Ddiaz Design** | **CC BY-NC-SA 4.0 → trang indexed hiển thị CC Attribution** | **CRITICAL:** hai nhãn license xung đột; trang nêu model từ *Need for Speed Mobile* |
| 2 | `2023_ferrari_sf90_xx_stradale.glb` | [2023 Ferrari SF90 XX Stradale](https://sketchfab.com/3d-models/2023-ferrari-sf90-xx-stradale-2c80c667232544649328cf3589921bcd) — **Ddiaz Design** | CC BY 4.0 → CC Attribution | **CRITICAL:** trang nói dựa trên 3D model của **CSR2**, khác người đăng |
| 3 | `2024_lamborghini_revuelto.glb` | [2024 Lamborghini Revuelto](https://sketchfab.com/3d-models/2024-lamborghini-revuelto-6b1217debc3449eabd993c5af8b4a7e5) — **HYPR:IMPS 3D** | CC BY 4.0 → CC Attribution | Chưa rõ nguồn hình học/texture đầu tiên |
| 4 | `2025_koenigsegg_jesko_attack_7376.glb` | [2025 Koenigsegg Jesko Attack #7376](https://sketchfab.com/3d-models/2025-koenigsegg-jesko-attack-7376-35d9ccc6636a49b0bbcfae3069f544e5) — **HYPR:IMPS 3D** | CC BY 4.0 → CC Attribution | Chưa có chứng từ người tạo nguyên tác |
| 5 | `aston_martin_valkyrie.glb` | [Aston Martin Valkyrie](https://sketchfab.com/3d-models/aston-martin-valkyrie-1ffd7998ae1f4b8ba5a74d8a74b598e2) — **chiwei** | CC BY 4.0 → CC Attribution | **HIGH:** uploader tự nêu bản gốc từ **Casacade Models**, họ chỉ rework UV/texture |
| 6 | `bugatti_tourbillon_2024.glb` | [Bugatti Tourbillon 2024](https://sketchfab.com/3d-models/bugatti-tourbillon-2024-c992c9bc9ba8427197d5fe380eaa2b31) — **MdMahib** | CC BY 4.0 → CC Attribution | Chưa có source file/ownership chứng thực |
| 7 | `corvette_stingray.glb` | [Corvette Stingray](https://sketchfab.com/3d-models/corvette-stingray-edabade6d6074197ba73a52809e398a4) — **Harri3D** | CC BY 4.0 → **chưa kiểm chứng được trang hiện tại** | **HIGH:** chỉ chắc URL và tác giả được nhúng trong bản exporter; direct 403, không có indexed listing tương ứng |
| 8 | `lamborghini_aventador.glb` | [Lamborghini Aventador](https://sketchfab.com/3d-models/lamborghini-aventador-3d4f50dba72b4329bde2ef22894f500a) — **Blender Studio** (`Blend_GUY`) | CC BY 4.0 → CC Attribution | Chưa kiểm tra tác giả gốc cho model/textures |
| 9 | `mclaren-765lt___with_windows__v2.glb` | [McLaren 765LT With Windows V2](https://sketchfab.com/3d-models/mclaren-765lt-with-windows-v2-cc1876d0179b42aeb31e004c01a857da) — **Sloftm_Carz** | CC BY 4.0 → CC Attribution | **HIGH:** trang profile nói các model miễn phí nhưng **không có quyền/license** |
| 10 | `mclaren_p1.glb` | [McLaren P1](https://sketchfab.com/3d-models/mclaren-p1-e791b5aee5c6497c83994f4e5f1db84b) — **hartwelkisaka** | CC BY 4.0 → CC Attribution | Listing gắn **NoAI**; không dùng model làm input generative AI khi chưa kiểm tra điều khoản |
| 11 | `mclaren_senna_free.glb` | [McLaren Senna Free](https://sketchfab.com/3d-models/mclaren-senna-free-ea3e43a6eb004853a87fe9c58422eb96) — **Black Snow** | CC BY 4.0 → CC Attribution | Tên `Free` không chứng minh provenance; listing không có mô tả nguồn |
| 12 | `mercedes-amg_project-one.glb` | [Mercedes-AMG Project-ONE](https://sketchfab.com/3d-models/mercedes-amg-project-one-8f76cd6087b54380b54075a30e662a02) — **dannzjs** | CC BY 4.0 → CC Attribution | Chưa có chứng từ bản quyền hình học/material |
| 13 | `pagani_huayra_free.glb` | [Pagani Huayra Free](https://sketchfab.com/3d-models/pagani-huayra-free-c2d61a9f53a54a229547bb76e4b71e25) — **Black Snow** | CC BY 4.0 → CC Attribution | Không mô tả xuất xứ, chữ `Free` không đồng nghĩa quyền |
| 14 | `pagani_utopia_2023.glb` | [Pagani Utopia 2023](https://sketchfab.com/3d-models/pagani-utopia-2023-a8a0264c80714a21b6f3e2ab4b538b0b) — **DFLEX** | CC BY 4.0 → CC Attribution | **ELEVATED:** material trong GLB gốc chứa prefix `CSR2_`, cần kiểm tra game-derived origin; prefix tự nó chưa phải bằng chứng vi phạm |
| 15 | `porsche_911_with_interior.glb` | [Porsche 911 with interior](https://sketchfab.com/3d-models/porsche-911-with-interior-877b1bc1739f4a2bb65d62fd7ffd9f75) — **n.brizitskaya** | CC BY 4.0 → CC Attribution | Listing ghi **911 Turbo S**, trong khi showroom hiện gọi **Carrera S**; cần sửa nhận diện trong task khác |
| 16 | `porsche_918_spyder_2015.glb` | [Porsche 918 Spyder 2015](https://sketchfab.com/3d-models/porsche-918-spyder-2015-b8d069b411804e43bccccd2e9e6fc1e7) — **3D Cars Studio** | CC BY 4.0 → CC Attribution | Nguồn listing tồn tại; chưa có chain-of-title và material rights |

**Các trang tham chiếu quan trọng để xác minh đối chiếu:** [Ddiaz Design profile](https://sketchfab.com/ddiaz-design) ghi các model ở tài khoản dùng làm reference cho papercraft và không dùng thương mại; [LaFerrari listing](https://sketchfab.com/3d-models/2014-ferrari-laferrari-8b46fa49718647de846387ef4c1e95b3) ghi nguồn game *Need for Speed Mobile*; [SF90 XX listing](https://sketchfab.com/3d-models/2023-ferrari-sf90-xx-stradale-2c80c667232544649328cf3589921bcd) ghi *Based on a CSR2 3d model*; [Valkyrie listing](https://sketchfab.com/3d-models/aston-martin-valkyrie-1ffd7998ae1f4b8ba5a74d8a74b598e2) ghi *Original model: Casacade Models* và [profile Casacade](https://sketchfab.com/CasacadeOperations/models) có model Aston Martin Valkyrie; [Sloftm profile](https://sketchfab.com/SLBofficial) mô tả `Free to use (not rights or licensed)`; [McLaren P1 listing](https://sketchfab.com/3d-models/mclaren-p1-e791b5aee5c6497c83994f4e5f1db84b) có nhãn NoAI. Đây là **các tuyên bố trên trang** và dấu hiệu cần điều tra, không đưa ra cáo buộc quyền tác giả khi chưa có chain-of-title.

## Khác biệt giữa CC trong exporter và chính sách cần áp dụng

- **15 file** nhúng `CC-BY-4.0`: [Creative Commons BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/) cho phép chia sẻ/sửa đổi, kể cả thương mại, **nếu người cấp có đúng quyền**, đồng thời yêu cầu credit, URL tới tác phẩm/license và thông báo các chỉnh sửa. [Legal code](https://creativecommons.org/licenses/by/4.0/legalcode) là văn bản cần tham khảo; các quyền đối với trademark, texture hoặc tác phẩm có trước vẫn có thể ngoài phạm vi license của người upload.
- **LaFerrari** nhúng `CC-BY-NC-SA-4.0`: [deed](https://creativecommons.org/licenses/by-nc-sa/4.0/) và [legal code](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode) giới hạn mục đích **NonCommercial**, yêu cầu **ShareAlike** nếu phát hành tác phẩm phái sinh. Hình thức website miễn phí không tự động chứng minh một mục đích là `NonCommercial`. **Current indexed listing lại hiển thị `CC Attribution`**, một xung đột license đáng kể. Không dùng nhãn có vẻ rộng hơn để tự nâng quyền; cần license đúng bản tải, thời điểm cấp và thẩm quyền uploader.
- [Sketchfab Download API guidelines](https://sketchfab.com/developers/download-api/guidelines) yêu cầu đưa tên tác giả, nguồn Sketchfab và license theo asset trong các ứng dụng dùng model download. [Sketchfab Terms](https://sketchfab.com/terms) quy định uploader chịu trách nhiệm quyền của nội dung, người tải phải tuân license tương ứng. [Trang phân loại license Sketchfab](https://www.sketchfab.com/blogs/community/refine-downloadable-model-searches-with-new-license-filters/) phân biệt giấy phép **Creative Commons free** và **Store/paid license**; không áp dụng nhầm giới hạn license của hàng Store vào 16 download có metadata CC, nhưng quyền từ tác phẩm bên thứ ba vẫn phải xác minh.
- Các model tồn tại trong tài khoản và nút *Download 3D Model* xuất hiện trong kết quả web của **15 model**; cuộc kiểm tra này **không** đăng nhập Sketchfab hay tải lại bất kỳ model nào. Giá bằng 0 tại thời điểm download thực tế và quyền phân phối từ chủ sở hữu nguyên tác **chưa được chứng thực**. Chính sách `NoAI` và nhãn xe/huy hiệu nhãn hiệu cần được xem độc lập với giấy phép mesh.

## Hai bản gốc không còn trong 16 model public

Hai GLB `assets/models_original` đã được loại khỏi danh mục hiện hành trong lịch sử `dbaaed6`, nên không trộn vào 16 dòng trên và không nâng số asset cần audit G0:

| Bản nguồn chỉ còn ở local | Tác giả/giấy phép nhúng | Ghi chú |
|---|---|---|
| `2023_koenigsegg_jesko_attack.glb` | [Ddiaz Design — 2023 Jesko Attack](https://sketchfab.com/3d-models/2023-koenigsegg-jesko-attack-18240b21b4d747c7b7e86a404c3a195a), `CC-BY-NC-SA-4.0` | SHA gốc `8b47b972395308a2e981b5548000f1d9de526f4981f58189e7702f25bcc3faf5`; không nằm trong public snapshot |
| `2026_bugatti_tourbillon.glb` | [Ddiaz Design — 2026 Tourbillon](https://sketchfab.com/3d-models/2026-bugatti-tourbillon-4f63f5a74611477989cefd9861b9784a), `CC-BY-NC-SA-4.0` | SHA gốc `0d7f217a8d2f8555e59b9b4d936afa9fed49a4668df8e4bbf222e6b79829f778`; không nằm trong public snapshot |

Tuy không public hiện tại, các bản này phải tiếp tục ở vùng private; nếu được đưa lại vào release, audit rights lại từ đầu.

## Lỗ hổng chứng từ và hành động trước bất kỳ yêu cầu phê duyệt nào

1. **Khóa provenance tại file gốc:** lưu hash SHA-256 nguyên bản, URL Sketchfab exact UUID, profile người đăng, screenshot trang và toàn bộ license tại thời điểm chính xác. JSON P9 hiện đã giữ SHA/URL, **chưa có screenshot/biên bản download**. Nếu license web khác `asset.extras`, kiểm tra snapshot ngày tải và xác nhận từ chủ thể có quyền, không tự chọn license rộng nhất.
2. **Truy đến người nắm quyền thật:** đối với LaFerrari (Need for Speed Mobile), SF90 XX (CSR2), Valkyrie (Casacade) và 765LT (uploader tuyên bố không có quyền), cần tài liệu đủ chứng minh người cấp phép có thể hợp pháp cho sử dụng nguyên mẫu, texture và derivative. Material prefix `CSR2_` ở Utopia là tín hiệu kiểm tra, không thay cho bằng chứng.
3. **Rà yêu cầu từng điều khoản:** quyền chỉnh sửa/optimize/mesh conversion; tự host file GLB để browser tải nguyên binary từ CDN; use thương mại; sharealike/noncommercial/noAI; phân phối **80 WebP** render từ model và texture; công bố attribution theo model; thương hiệu xe, logo/huy hiệu; reviewer xác thực chain-of-title.
4. **Lập biên bản Legal G0 độc lập:** người được ủy quyền phê duyệt đúng bytes/hash, URL, ngày, license và điều khoản rõ ràng; sau đó mới cập nhật register được kiểm soát theo quy trình của Prime. P9 chỉ là bảng **ứng viên và forensic evidence**. Hai WebP môi trường cũng chưa có rights; toàn bộ public release vẫn **NO-GO**.

## Lệnh kiểm tra tại local (read-only)

Trong thư mục VELANCE, không phát sinh cloud hay thay đổi 16 GLB:

```bash
git log --all --format='%h %as %s' -- assets/models
git ls-files assets/models_original assets/models_prepared
python3 -m json.tool docs/p9-model-candidates.json >/dev/null
/Users/baobungbu/.nvm/versions/node/v24.21.0/bin/node -e 'const j=require("./docs/p9-model-candidates.json");const f=j.models; if(f.length!==16||f.some(x=>x.clearanceStatus!=="UNVERIFIED"||x.independentLegalSignoff)) process.exit(1);console.log(j.summary)'
git diff --check
```

**Nguồn ghi lại trong JSON là thông tin ứng viên, không tự động cập nhật `docs/p5-asset-rights-register.json`.** Không tạo asset mới, không chỉnh release, không công bố GLB/WebP, không commit/push/merge/deploy và không truy cập database telemetry.
