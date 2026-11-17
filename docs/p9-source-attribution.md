# VELANCE — nguồn model gốc, bản quyền và attribution (17/11/2026)

**Đây là hồ sơ dẫn nguồn, không phải xác nhận được phép phát hành.** Tên người đăng, URL gốc, và nhãn license được đọc từ `asset.extras` do Sketchfab exporter nhúng trong **16 file `assets/models_original/*.glb` có tên tương ứng với bản phát hành**. Các nguồn được kiểm tra lại bằng trang Sketchfab công khai khi có kết quả tìm kiếm. Bản GLB tối ưu trong `assets/models/` đã mất phần metadata này. Bản ghi chuẩn per-file và SHA-256 xem [p9-asset-source-ledger.json](p9-asset-source-ledger.json); kiểm chứng lại bằng `node tools/p9/source-ledger.mjs --audit`.

## Trích dẫn cho 16 model thực tế trong showroom

| Model VELANCE | Link nguồn được nhúng trong GLB gốc | Uploader | Nhãn trong GLB / Trang Sketchfab khi tra cứu | Điều kiện chưa đóng |
| --- | --- | --- | --- | --- |
| Ferrari LaFerrari | [2014 Ferrari LaFerrari](https://sketchfab.com/3d-models/2014-ferrari-laferrari-8b46fa49718647de846387ef4c1e95b3) | [Ddiaz Design](https://sketchfab.com/ddiaz-design) | **CC BY-NC-SA 4.0 / CC BY** | **LICENSE CONFLICT**; uploader ghi model từ Need for Speed Mobile; profile ghi **không dùng thương mại**. Không coi CC BY hiện hành là tự xóa rủi ro nguồn gốc |
| Ferrari SF90 XX Stradale | [2023 Ferrari SF90 XX Stradale](https://sketchfab.com/3d-models/2023-ferrari-sf90-xx-stradale-2c80c667232544649328cf3589921bcd) | [Ddiaz Design](https://sketchfab.com/ddiaz-design) | CC BY / CC BY | Model mô tả **dựa trên CSR2**; uploader ghi không dùng thương mại |
| Lamborghini Revuelto | [2024 Lamborghini Revuelto](https://sketchfab.com/3d-models/2024-lamborghini-revuelto-6b1217debc3449eabd993c5af8b4a7e5) | [HYPR:IMPS 3D](https://sketchfab.com/HYPRIMPS3D) | CC BY / CC BY | Chưa xác minh bản quyền gốc / nội dung texture |
| Koenigsegg Jesko Attack #7376 | [2025 Jesko Attack #7376](https://sketchfab.com/3d-models/2025-koenigsegg-jesko-attack-7376-35d9ccc6636a49b0bbcfae3069f544e5) | [HYPR:IMPS 3D](https://sketchfab.com/HYPRIMPS3D) | CC BY / CC BY | Chưa xác minh quyền gốc và phân phối qua self-hosted GLB |
| Aston Martin Valkyrie | [Aston Martin Valkyrie](https://sketchfab.com/3d-models/aston-martin-valkyrie-1ffd7998ae1f4b8ba5a74d8a74b598e2) | [chiwei](https://sketchfab.com/chiwei2333) | CC BY / CC BY | Người đăng thừa nhận dùng **original model từ Cascade Models**, làm lại UV/texture; chưa có chứng cứ quyền từ Cascade Models |
| Bugatti Tourbillon 2024 | [Bugatti Tourbillon 2024](https://sketchfab.com/3d-models/bugatti-tourbillon-2024-c992c9bc9ba8427197d5fe380eaa2b31) | [MdMahib](https://sketchfab.com/MdMahib) | CC BY / CC BY | Chưa chứng minh uploader là chủ sở hữu tất cả chi tiết/texture |
| Chevrolet Corvette Stingray | [Corvette Stingray](https://sketchfab.com/3d-models/corvette-stingray-edabade6d6074197ba73a52809e398a4) | [Harri3D](https://sketchfab.com/harrisondorn) | CC BY / **chưa truy hồi độc lập** | Chỉ xác nhận metadata exporter; trạng thái trang và quyền gốc chưa kiểm chứng |
| Lamborghini Aventador | [Lamborghini Aventador](https://sketchfab.com/3d-models/lamborghini-aventador-3d4f50dba72b4329bde2ef22894f500a) | [Blender Studio](https://sketchfab.com/Blend_GUY) | CC BY / CC BY | Chưa xác minh quyền gốc, quyền công khai model/texture |
| McLaren 765LT | [Mclaren-765lt (With Windows) V2](https://sketchfab.com/3d-models/mclaren-765lt-with-windows-v2-cc1876d0179b42aeb31e004c01a857da) | [Sloftm_Carz](https://sketchfab.com/SLBofficial) | CC BY / CC BY | Chưa xác minh quyền của thiết kế và texture |
| McLaren P1 | [McLaren P1](https://sketchfab.com/3d-models/mclaren-p1-e791b5aee5c6497c83994f4e5f1db84b) | [hartwelkisaka](https://sketchfab.com/hartwelkisaka) | CC BY / CC BY | Trang có nhãn **NoAI**; giữ điều kiện và credit, chưa có rights review |
| McLaren Senna | [McLaren Senna Free](https://sketchfab.com/3d-models/mclaren-senna-free-ea3e43a6eb004853a87fe9c58422eb96) | [Black Snow](https://sketchfab.com/BlackSnow02) | CC BY / CC BY | Tác giả gốc và texture chưa được xác minh độc lập |
| Mercedes-AMG Project ONE | [Mercedes-AMG Project-ONE](https://sketchfab.com/3d-models/mercedes-amg-project-one-8f76cd6087b54380b54075a30e662a02) | [dannzjs](https://sketchfab.com/dannzjs) | CC BY / CC BY | Chưa có xác nhận quyền gốc, thương hiệu/texture |
| Pagani Huayra | [Pagani Huayra (Free)](https://sketchfab.com/3d-models/pagani-huayra-free-c2d61a9f53a54a229547bb76e4b71e25) | [Black Snow](https://sketchfab.com/BlackSnow02) | CC BY / CC BY | Cần xác minh nguồn mesh và quyền phân phối derivative |
| Pagani Utopia | [Pagani Utopia 2023](https://sketchfab.com/3d-models/pagani-utopia-2023-a8a0264c80714a21b6f3e2ab4b538b0b) | [DFLEX](https://sketchfab.com/DFLEX) | CC BY / CC BY | Cần làm rõ tên material chứa dấu hiệu `CSR2_` trong GLB; chưa có chain-of-title/texture/tác giả độc lập |
| Porsche 911 with interior | [Porsche 911 with interior](https://sketchfab.com/3d-models/porsche-911-with-interior-877b1bc1739f4a2bb65d62fd7ffd9f75) | [n.brizitskaya](https://sketchfab.com/n.brizitskaya) | CC BY / CC BY | Listing ghi 911 **Turbo S**, trong khi UI hiện gọi **Carrera S**; cần thống nhất chủng loại và kiểm tra quyền nội thất/texture |
| Porsche 918 Spyder | [Porsche 918 Spyder 2015](https://sketchfab.com/3d-models/porsche-918-spyder-2015-b8d069b411804e43bccccd2e9e6fc1e7) | [3D Cars Studio](https://sketchfab.com/3DC_STUDIO) | CC BY / CC BY | Chưa có xác nhận đầy đủ quyền gốc và thương hiệu |

**Lưu ý chống nhầm nguồn:** Một số trang Sketchfab có tên xe trùng nhau nhưng của người đăng khác, thậm chí game rip. Bảng trên dùng **chính xác UID nguồn lưu trong GLB gốc**, không thay bằng trang cùng tên. Chẳng hạn bản Revuelto của dự án là **HYPR:IMPS**, không phải bản của Ddiaz Design thuộc CC BY-NC-SA; bản Porsche 918 là **3D Cars Studio**, không phải bản cùng tên của DisneyCars.

## Điều khoản và điều kiện bắt buộc

- **[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)** cho phép chia sẻ/sửa đổi (kể cả thương mại) khi bên cấp phép **thực sự có quyền** và thực hiện attribution, ghi link license, ghi thay đổi. Tên license trên một listing không chứng minh quyền sở hữu mesh, texture, logo hoặc quyền của game gốc.
- **[Creative Commons BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)** loại trừ mục đích thương mại và đặt nghĩa vụ ShareAlike. Áp dụng nhãn này cho dữ liệu LaFerrari trong exporter, cho đến khi làm rõ xung đột với trang hiện hành.
- **[Sketchfab — Download API Guidelines](https://sketchfab.com/developers/download-api/guidelines)** yêu cầu hiển thị credit người sáng tạo, đường dẫn model và license đầy đủ. Các quyền từ bản tải CC và **[Sketchfab paid standard/editorial agreement](https://sketchfab.com/licenses)** không được đánh đồng: paid standard có hạn chế phát tán model standalone. Không suy diễn từ một loại license sang loại khác.
- Các model của Ddiaz Design phải xét cả **[profile chính thức](https://sketchfab.com/ddiaz-design)** vì profile mô tả tập hợp là tham khảo phi thương mại và có model từ game. Một tuyên bố CC của người đăng không nhất thiết cấp được quyền trên tác phẩm trò chơi của bên thứ ba.

## 80 ảnh WebP và 2 ảnh môi trường

Mỗi xe có 5 góc ảnh `assets/images/<VEHICLES.id>/01..05.webp`, trích dẫn **cùng nguồn model GLB tương ứng** ở bảng trên. Công cụ có thể dựng và xuất ảnh bằng `tools/render/render.html` + `tools/render/shoot.mjs` (Three.js/WebGPU, GLTFLoader, Sharp). Đã tái mã hóa từ PNG hiện tại và so byte: **45/80 WebP khớp hoàn toàn** pipeline Sharp đang có; **35/80 WebP đời đầu dùng lossless VP8L** không tái tạo trùng từ PNG hiện tại nên phiên bản renderer/thành phẩm gốc chưa được xác minh trọn vẹn. Tất cả 80 có liên kết album→GLB và đều chưa được phê duyệt bản quyền. Một file ảnh tự render không loại bỏ nghĩa vụ bản quyền đối với model gốc, texture hoặc môi trường render. Xem [p9-asset-source-ledger.json](p9-asset-source-ledger.json), [p9-image-lineage.json](p9-image-lineage.json) và [p9-render-provenance.md](p9-render-provenance.md) để đối chiếu từng file, kiểm tra byte-for-byte khi có.

Hai WebP `/assets/environment/private_garage_1080x1350.webp` và `/assets/environment/private_garage_1920x1080.webp` **chưa có URL nguồn, chủ sở hữu hoặc license**; không tự gắn một ảnh internet có vẻ giống làm nguồn. Chúng vẫn ở ngoài phạm vi 96 entries P5 và nằm trong danh mục cần bổ sung trước khi public.

## Mẫu credit dự kiến cho trang web — CHƯA dùng như tuyên bố license

Ví dụ một entry khi chủ sở hữu đã được xác minh:

> McLaren P1 — 3D model uploaded by [hartwelkisaka](https://sketchfab.com/hartwelkisaka) on [Sketchfab](https://sketchfab.com/3d-models/mclaren-p1-e791b5aee5c6497c83994f4e5f1db84b); source lists [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Mesh was optimized and five editorial renders were produced by the VELANCE project. No affiliation with or endorsement by McLaren is implied.

Không xuất bản mục attribution này như một giấy phép pháp lý. Quyền phát hành **vẫn 0/96 approved, public NO-GO** trong [P5 register](p5-asset-rights-register.json); cần người có thẩm quyền kiểm tra nguồn/chủ thể, điều khoản, thương hiệu, commercial/self-hosted distribution và texture trước khi thay trạng thái.
