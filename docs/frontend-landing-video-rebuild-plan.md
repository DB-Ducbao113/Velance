# VÉLANCE — kế hoạch dựng lại landing theo video tham chiếu

**Trạng thái:** cập nhật sau phản hồi ngày 18/11/2026: người dùng bác bỏ việc ghép ảnh, tách xe và xoay mâm ảnh. Landing hiện chuyển sang ảnh thật nguyên cảnh. Motion bánh xe chỉ được phép bằng footage chuyển động thật được cấp quyền.
**Nhánh triển khai:** `frontend`. **Phạm vi:** màn chào trước nút `ENTER`, không thay đổi engine/showroom 16 xe.
**Video gốc:** `Ghi Màn hình 2026-11-17 lúc 20.38.21.mov`, dài **8,865 giây**, 2.872 × 1.934 px; video ghi màn hình trang MotionSites.
**Định hướng đã chốt:** McLaren P1 **ảnh chụp thật nguyên cảnh**, VÉLANCE **đen + vàng champagne**, ít chữ, chuyển động máy quay toàn ảnh mượt. **Nếu** có bánh xe quay, phải đến từ footage quay thật, không được giả lập bằng cắt ghép mâm. Không dùng xe GLB/AI để tạo hero.

## 1. Phân tích reference: sao chép điều gì, không sao chép điều gì

| Khoảng thời gian video | Quan sát từ video | Yêu cầu chuyển thể sang VÉLANCE |
|---|---|---|
| 0–1 giây | Hero xe cam ở góc 3/4, chiếm gần toàn bộ chiều ngang vùng hero, headline khổng lồ nằm sau thân xe | McLaren P1 thật làm chủ thể; chữ `VÉLANCE` lớn **phía sau xe** nhưng không che xe |
| 1–3 giây | Bối cảnh đen, phần sàn đỏ cam có ánh sáng và bóng tiếp xúc; xe nổi rõ trên nền | Studio đen than, sàn vàng hổ phách **trầm** để đồng bộ showroom đen–champagne |
| 3–5,5 giây | Vệt sáng/điểm phản xạ thay đổi trên đầu xe, bố cục vẫn cố định, không có cú zoom/cắt mạnh | Ánh sáng lướt có mask theo bề mặt, máy quay/canvas dịch rất ít, giữ chi tiết ảnh thật |
| Sau ~5,5 giây | Người quay chuyển sang phần khác của trang MotionSites | Không dựng lại UI marketplace, trình duyệt, thẻ template hay banner giảm giá |

**Giới hạn quan sát:** video là màn hình quay một bản preview khá nhỏ; không đủ bằng chứng để xác minh kỹ thuật dựng gốc hoặc đo chính xác vận tốc quay bánh xe. **Bánh quay là yêu cầu bổ sung rõ ràng của người dùng**, phải triển khai và nghiệm thu độc lập. Không khẳng định video đang dùng kỹ thuật nào.

**Những điểm bắt buộc giữ:** màu xe cam McLaren P1, góc 3/4, typographic hero khổ lớn sau xe, sàn ánh sáng trầm, độ sắc nét cao, motion chậm và bố cục tối giản.

**Những điểm cố ý khác video:** thay `NEW ERA` bằng `VÉLANCE`; thay Porsche bằng ảnh thật McLaren P1; vàng champagne thay màu sàn đỏ tươi; chỉ còn `P1`, nút `ENTER` và một dòng ghi nguồn ảnh nhỏ theo giấy phép.

## 2. Chẩn đoán bản hiện tại — vì sao trông giả

1. `assets/hero/mclaren-p1-studio.webp` được tách nền bán tự động từ ảnh chụp ngoài trời, nên mép mái, kính, gương và vùng phản xạ còn ánh sáng/chi tiết bối cảnh cũ. Độ tương phản không giống studio.
2. `assets/hero/mclaren-p1-wheel-front.webp` và `...rear.webp` là texture tròn được kéo thành hình elip bằng CSS. Sự phân lớp với lốp/mâm/khung bánh chưa đạt cảm giác chuyển động thật.
3. `styles/landing.css` đặt background bằng gradient, nhưng thiếu phản xạ ánh sáng có hình dạng theo thân xe, bóng tiếp xúc và liên kết ánh sáng giữa xe với mặt sàn.
4. Phần xe được cắt tương đối lớn; trên màn hình dọc phần đuôi và đầu xe bị crop mạnh, khiến bố cục mất cân bằng.
5. Bài `frontend_landing_smoke.mjs` hiện kiểm tra DOM và transform xoay; **chưa kiểm tra bằng mắt độ liền mạch của bánh, silhouette, crop và fidelity so với video**. PASS kỹ thuật không đồng nghĩa đạt thiết kế.

**Quyết định:** bỏ hướng chắp vá thêm CSS trên ảnh đang lỗi. Làm lại chất lượng **asset/roto** và motion prototype trước, chỉ thay landing sau khi prototype được duyệt bằng hình ảnh và video 5–8 giây.

## 3. Hệ thống hình ảnh cuối

- **Layout:** 1 hero chiếm 100svh; xe ở giữa và thấp hơn headline; góc 3/4 từ trước; khoảng 70–83% chiều rộng desktop. Chữ `VÉLANCE` ở sau xe, rộng gần đầy vùng hero. Xe không được che mất CTA.
- **Màu:** nền `#050709` / `#0A0D10`; champagne chính `#E8CD9F`; vàng phản xạ `#B89563`; nền sàn `#1D1711` đến `#08090B`; cam nguyên bản của thân xe vẫn tự nhiên, không biến thành vàng giả.
- **Ánh sáng:** một nguồn highlight mềm phía trước/trên; dải sáng bám theo bonnet và kính; bóng tiếp xúc tối đúng vị trí bốn bánh; sàn có phản xạ rất nhẹ và không phản chiếu sai hình học.
- **Chữ:** duy nhất `VÉLANCE` (headline), `P1`, `ENTER`, credit nhỏ theo giấy phép; bỏ copy marketing, số xe, slogan và nhãn trang trí.
- **Responsive:** desktop 1440×900 và 1920×1080, tablet 768×1024, mobile 390×844 và 320×640 có bố cục riêng; mobile không phóng to desktop quá mức làm cụt xe một cách ngẫu nhiên.
- **Nguồn gốc:** ảnh thật có URL gốc, tác giả, quyền chỉnh sửa, link giấy phép; nếu sử dụng ảnh Axion23 hiện có phải tiếp tục ghi `PHOTO · AXION23 / CC BY 2.0` và cập nhật bản mô tả mọi chỉnh sửa.

## 4. Hướng kỹ thuật ưu tiên và điều kiện lựa chọn

**Ưu tiên A — footage thật đúng khung hình.** Tìm video/chùm ảnh McLaren P1 được phép sử dụng, góc 3/4 trong môi trường studio, có bánh quay thật và ánh sáng phù hợp. Chỉ chọn khi xác minh nguồn/quyền lưu trữ, chỉnh sửa, self-host. Ưu tiên cảnh xe không bị watermark, giữ nguyên tỷ lệ và không thay hình học xe. Với video gốc có bánh quay, xuất clip ngắn WebM/MP4 cùng poster WebP cho fallback; giữ giao diện chữ/CTA bằng HTML/CSS.

**Phương án B — ảnh chụp thật nguyên cảnh.** Nếu không có footage thật phù hợp, sử dụng ảnh nguyên khung hình đủ phân giải; giữ nguyên bánh, thân xe, môi trường chụp và bóng tiếp xúc. Motion duy nhất là chuyển động toàn khung hình rất nhẹ. Không phân đoạn bằng mask, không thay nền bằng sàn CSS và không xoay mâm bánh từ ảnh.

**Cổng quyết định:** phương án CSS xoay mâm từ ảnh tĩnh đã bị loại sau phản hồi trực quan. Không tái sử dụng. Chỉ khôi phục motion bánh khi đã có footage thực với giấy phép được xác minh.

## 5. Timeline motion cần dựng

| Nhịp của **motion VÉLANCE đề xuất** | Hiệu ứng | Kiểm soát |
|---|---|---|
| 0–0,6 s | Nền đen và chữ bắt đầu xuất hiện | Không nhảy kích thước/font (preload fonts) |
| 0,6–1,6 s | Xe vào hình bằng opacity + dịch nhẹ 10–20 px | Giữ toàn thân đúng tỷ lệ; không scale đột ngột |
| 1,6–3,6 s | Ánh sáng mềm quét trên đầu xe; mâm quay chậm ổn định | Không tạo vệt sáng tách rời car paint; không lộ seam bánh |
| 3,6–5,5 s | Ánh sáng lắng, studio/sàn duy trì chiều sâu | Chuyển động được composited; không thêm render 3D hoặc decode nặng giữa chừng |
| Sau 5,5 s | Trạng thái idle loop dịu, nút `ENTER` luôn bấm được | Loop liền khung; không flash tại điểm nối; dừng khi tab ẩn |

**Chuyển động bánh:** không triển khai với ảnh tĩnh. Nếu sau này có footage thật, dùng chính chuyển động trong footage và không điều khiển bánh bằng CSS.

**Reduced motion:** không chạy ánh sáng, bánh hoặc chuyển động camera; ảnh poster sắc nét vẫn hiển thị và `ENTER` hoạt động.

## 6. Các giai đoạn thực hiện theo cổng nghiệm thu

### G0 — Baseline và reference lock

- Chụp full viewport của VÉLANCE hiện tại desktop/mobile; giữ baseline và `git status` trước chỉnh sửa. Giữ toàn bộ thay đổi chưa commit trên `frontend`.
- Từ video tham chiếu 0–5,5 giây, dựng 4 frame mốc để so sánh: bố cục, màu, tỷ lệ xe, chữ, mặt sàn, ánh sáng. Dùng reference như **visual target**, không copy UI MotionSites.
- **Pass:** storyboard và bảng màu thống nhất, có ảnh baseline/target rõ ràng.

### G1 — Asset thật chất lượng cao

- Kiểm tra nguồn ảnh/footage và giấy phép; dựng 2–3 candidate có cùng góc 3/4. Không lấy ảnh watermark hoặc hình render bị gọi nhầm thành ảnh chụp.
- Tối ưu ảnh nguồn tối thiểu khoảng 3K chiều ngang cho desktop; asset mobile crop theo chủ thể và đầu/đuôi xe.
- **Pass:** ở 100% zoom không thấy viền cắt, lỗ alpha, ánh nhà cửa còn sót, phản xạ vô lý; nguồn ảnh và giấy phép đã ghi chép.

### G2 — Prototype tĩnh được duyệt trước motion

- Dựng ảnh desktop/mobile với chữ `VÉLANCE`, McLaren, sàn, shadow/contact/reflection, `P1` và `ENTER`.
- So khung với video ở kích cỡ thực: chữ nằm **sau** xe, car/grounding đủ nổi, đen–vàng giống showroom. Không dùng gradient để che lỗi mask.
- **Pass:** screenshot tĩnh đã giống ngôn ngữ video và đạt yêu cầu sang trọng ngay cả khi motion = off.

### G3 — Motion ảnh thật, footage nếu có

- Với ảnh tĩnh, chỉ di chuyển toàn frame 1–3% bằng một animation dài; giữ nguyên bánh, kính, bóng và ánh sáng thực.
- Với footage được xác minh bản quyền, dùng footage thật cho cả thân và bánh; poster là frame thực từ video.
- **Pass:** không có lớp xe/mâm ghép, không méo hình, không flash khi loop và không rung khung.

### G4 — Tích hợp landing và hiệu suất

- Chỉ thay markup/styles/assets của gate sau khi G2/G3 pass. Tách asset desktop/mobile, preload hero, defer ảnh/GLB showroom sau click theo khả năng kiến trúc hiện tại.
- Giữ nút `ENTER` có thể dùng bằng chuột/bàn phím/touch. Khi bấm, landing fade vào cinematic 16 ô showroom mà không flash đen hay kéo dài TTI.
- **Pass:** không lỗi console, ảnh tải đúng, không layout shift, không lỗi quyền ảnh/attribution, responsive và reduced-motion đúng.

### G5 — QC bằng mắt + tự động

- Tự động: Chromium WebGL2/WebGPU, 1440×900, 1920×1080, 768×1024, 390×844, 320×640; screenshot ở 0, 1,5, 3,5, 5,5 giây; kiểm tra wheel angle thay đổi theo thời gian, focus/keyboard, ENTER và reduced-motion.
- Bằng mắt: chấm từng khung theo bố cục video, màu, ảnh chụp thật, vị trí logo, nền, mép xe, mâm bánh và ánh sáng. DOM/CSS `transform` có thay đổi **không được tính là pass về chất lượng hình ảnh**.
- Hiệu năng: ghi frame-time P50/P95/P99/max và long tasks ở Chrome. Mục tiêu desktop 60 FPS và mobile ít nhất 30 FPS ổn định trên thiết bị mục tiêu; xác nhận trên thiết bị thật, không chỉ headless.
- Hồi quy: `frontend_landing_smoke.mjs`, `frontend_cinematic_smoke.mjs`, `frontend_selection_smoke.mjs`, các node tests của dự án, `git diff --check`.
- **Pass:** tất cả lỗi thị giác lớn bằng 0; chuyển đổi landing → showroom sạch; đủ bằng chứng screenshot/clip và test.

## 7. Deliverables và cách bàn giao

1. **Storyboard/reference checklist** có 4 khung mốc của video và mockup desktop/mobile.
2. **Asset ledger** gồm nguồn, tác giả, license, loại ảnh chụp/footage, bản gốc, ảnh sửa, alpha/overlay, SHA-256, crop và size.
3. **Visual prototype** trước khi chạm code production: một ảnh tĩnh desktop, một ảnh tĩnh mobile và clip 5–8 giây cho bánh/ánh sáng.
4. **Landing tích hợp** gồm assets, CSS/JS và fallback, chỉ sau khi đạt các gate.
5. **QC package** screenshot đối chiếu, crop bánh phóng đại, kiểm tra motion, frame times, kết quả regression.

Mọi thay đổi làm trên `frontend`, giữ nguyên dirty tree không thuộc landing. Không commit, push, merge hoặc deploy trong pha lập kế hoạch này. Việc triển khai về sau phải đi lần lượt qua G0→G5, không chốt theo kết quả test DOM nếu hình ảnh vẫn kém.
