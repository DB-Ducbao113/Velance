# VELANCE P9 — Render provenance, nguồn gốc 80 ảnh xe và 2 ảnh garage

**Ngày kiểm tra:** 17/11/2026 · **Phạm vi:** chỉ kiểm định chứng cứ đang có tại local repository; không tải ảnh mới, không tái render, không chỉnh binary, không mở DB thật, không commit/push/deploy. **G0: BLOCKED / public NO-GO.** Các kết quả `VERIFIED` dưới đây chỉ nói về **quan hệ kỹ thuật giữa file**, không phải giấy phép thương mại, quyền của người tạo model hoặc quyền phân phối ảnh.

**Bảng kiểm toán đầy đủ:** [`p9-image-lineage.json`](p9-image-lineage.json) gồm **82 entry per-file** (80 car WebP và 2 environment WebP), SHA-256 và byte size, PNG master hash, GLB hiện được ánh xạ, codec, ngày/commit đầu tiên, phương pháp đối chiếu và trạng thái quyền. Không thay đổi [`p5-asset-rights-register.json`](p5-asset-rights-register.json), các chứng cứ P7/P8 hoặc asset nào.

## 1. Kết luận với mức độ chắc chắn tách biệt

| Điều đã kiểm tra | Kết luận có thể khẳng định | Điều **không thể** khẳng định |
| --- | --- | --- |
| Tập 16 car albums | **16×5=80** WebP nằm trong `assets/images/<vehicle-id>/` với đúng 5 tên góc máy; cả **80 PNG master** cùng tên đang tồn tại ở local. Mỗi album ánh xạ đúng một `VEHICLES.id` và một file GLB trong [`assets/models/manifest.json`](../assets/models/manifest.json). | Không chứng minh PNG được render từ **đúng byte GLB hiện tại** bằng một bản ghi render có ký hash/đúng thời điểm. |
| 45 WebP trong **9 album mới** | Tái mã hóa từ **PNG hiện có** qua Sharp `.webp({quality:90, alphaQuality:100})` cho **45/45 kết quả giống hệt từng byte (SHA-256)**; trùng cấu hình ở [`tools/render/shoot.mjs:23–27`](../tools/render/shoot.mjs). Đây là bằng chứng **byte-exact PNG→WebP**. | Không có checksum của cảnh render WebGPU hoặc ảnh chụp màn hình tại thời điểm tạo PNG; việc PNG được tạo từ GLB cụ thể là bằng chứng code-path + hình học phù hợp, chưa phải proof end-to-end. |
| 35 WebP trong **7 album cũ** | Toàn bộ **35/35** là `VP8L` (WebP **lossless**); tái mã hóa từ PNG hiện tại bằng Sharp quality90 **không** trùng SHA. Giải mã WebP và PNG ra **RGBA đủ 3840×2160 cũng không giống từng pixel** ở **35/35**. Các ảnh xuất hiện từ commit cũ trước script render hiện tại. | Không được gọi những file này là bản chuyển đổi byte-exact của **PNG master đang có**, cũng không suy ra chắc chắn chúng là ảnh stock hoặc tải từ web. Có thể là một thế hệ render/PNG khác; **chưa xác lập file/master và phiên bản model tại thời điểm tạo**. |
| 2 WebP garage | Trực quan cùng một cảnh garage, panorama và portrait có quan hệ crop rất mạnh; cả hai xuất hiện trong Git từ commit đầu, chỉ có chunk WebP `VP8` (không EXIF/XMP/ICC). | **Không tìm thấy** script tạo cảnh, PSD/Blend/prompt, ảnh gốc, URL tải, tác giả hoặc giấy phép. Không có căn cứ gắn ảnh này với script chụp GLB, stock library, ảnh AI hoặc một tác giả bên ngoài cụ thể. |
| Metadata/permissions | SHA-256 và kích thước của 80 car WebP khớp P5 register tại lúc audit; **82/82 WebP không có EXIF/XMP/ICC chunks** chứa thông tin sở hữu ở mức container. | Thiếu metadata **không** suy ra ảnh vô chủ; tồn tại trong Git **không** phải bằng chứng quyền phân phối. `0` quyền sử dụng công khai được cấp qua audit P9. |

**Phân loại toàn bộ 82 file:** `45 VERIFIED_CURRENT_PNG_TO_WEBP_SHA256` · `35 LIKELY_OLDER_RENDER_VARIANT_NOT_REPRODUCIBLE_FROM_CURRENT_PNG` · `2 UNKNOWN_CREATOR_AND_ORIGINAL`. Cả ba lớp đều **LEGAL_RIGHTS=UNVERIFIED**; không đánh dấu file nào `APPROVED`.

## 2. Chuỗi kỹ thuật mà repository mô tả

| Bước | Đường dẫn có thể mở và kiểm tra | Quan hệ dữ liệu |
| --- | --- | --- |
| Danh sách xe/model | [`src/data/vehicles.js:4–20`](../src/data/vehicles.js) | 16 `VEHICLES` gồm `id`, `file` GLB và `axis`; các trường `source` URL trang hãng chỉ là nguồn **thông số xe**, **không phải URL license của GLB/ảnh**. |
| Loader và cảnh render | [`tools/render/render.html:7–35`](../tools/render/render.html) | Three.js `WebGPURenderer`, `GLTFLoader`, Meshopt decoder; `RoomEnvironment` nội bộ + PMREM + 4 lights, camera Perspective 32°, canvas RGBA alpha; `3840×2160`. Không dùng ảnh garage làm background của ảnh xe trong code này. |
| Năm bố cục | [`tools/render/render.html:36–42,52–80`](../tools/render/render.html) | `__shoot(file,axis,noseBack)` tải `../../assets/models/${file}`, canh model bằng bounding box, xử lý axis/nose orientation, đặt camera theo tên/góc máy, render với `toDataURL('image/png')`. |
| Render & xuất WebP | [`tools/render/shoot.mjs:10–30`](../tools/render/shoot.mjs) | Puppeteer kết nối **localhost:8090**, tìm `VEHICLES.id`, ghi `assets/images/<id>/<pose>.png`, gọi Sharp quality90/alpha100 ghi `.webp`. `SHOT_IDS` có thể thay đổi danh sách; **mặc định chỉ 9 ID**. Không có log render được ghi tự động ra file có manifest chứng cứ. |
| Asset contract | [`assets/images/README.md:1–24`](../assets/images/README.md) | Mỗi xe 5 ảnh nền trong suốt, PNG master RGBA, WebP phục vụ web; đây là **yêu cầu workflow**, không phải chứng thư nguồn gốc/giấy phép. |
| Inventory + SHA | [`assets/models/manifest.json`](../assets/models/manifest.json), [`P5 rights register`](p5-asset-rights-register.json), [P9 JSON](p9-image-lineage.json) | Chứng minh file hiện có, kích thước và checksum; không ghi lại thời điểm GPU render, nguồn file/texture ban đầu hoặc chữ ký tác giả. |

Góc máy xác định từ script `render.html`:

| File PNG/WebP (đuôi giống nhau) | Camera azimuth | Elevation | Distance |
| --- | ---: | ---: | ---: |
| `01-front-three-quarter` | 35° | 12° | 7.2 |
| `02-near-front` | 12° | 7° | 6.2 |
| `03-side-profile` | 90° | 5° | 7.6 |
| `04-rear-three-quarter` | 145° | 12° | 7.2 |
| `05-signature` | 28° | 3° | 6.4 |

Script đặt `NOSE_BACK` cho `mclarenp1`, `porsche911`, `aventador`; `axis='x'` trong [`VEHICLES`](../src/data/vehicles.js) áp dụng cho `jesko25` và `porsche911`. Đây là **thông số lắp cảnh** tại source hiện tại, không đủ truy nguyên camera của 35 file thuộc batch cũ. Các URL hãng xe trong `VEHICLES.source` không được đưa vào hồ sơ rights như chứng cứ chủ sở hữu ảnh/model.

## 3. Bảng 16 album × 5 ảnh × GLB tương ứng

Trong mỗi hàng, `assets/images/<album>/` có **đủ cả** `01-front-three-quarter.webp`, `02-near-front.webp`, `03-side-profile.webp`, `04-rear-three-quarter.webp`, `05-signature.webp` và **5 PNG cùng stem**. Mỗi file cụ thể có hash, byte size, first commit và evidence ở [`p9-image-lineage.json`](p9-image-lineage.json) (`carRenders[]`). `GLB ánh xạ` là **đường dẫn mà script hiện tại sẽ tải**, không mặc định là cùng phiên bản model đã dùng tại lần render lịch sử.

| Album | GLB ánh xạ trong `assets/models/` | Sharp q90 exact / 5 | WebP hiện có | Commit đầu |
| --- | --- | ---: | --- | --- |
| `amgone` | `mercedes-amg_project-one.glb` | 0/5 | `VP8L` lossless, RGBA khác PNG hiện tại | `4c330ab` |
| `aventador` | `lamborghini_aventador.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `corvette` | `corvette_stingray.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `huayra` | `pagani_huayra_free.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `jesko25` | `2025_koenigsegg_jesko_attack_7376.glb` | 0/5 | `VP8L` lossless, RGBA khác PNG hiện tại | `4c330ab` |
| `laferrari` | `2014_ferrari_laferrari.glb` | 0/5 | `VP8L` lossless, RGBA khác PNG hiện tại | `4c330ab` |
| `mclaren765lt` | `mclaren-765lt___with_windows__v2.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `mclarenp1` | `mclaren_p1.glb` | 0/5 | `VP8L` lossless, RGBA khác PNG hiện tại | `4c330ab` |
| `paganiutopia` | `pagani_utopia_2023.glb` | 0/5 | `VP8L` lossless, RGBA khác PNG hiện tại | `4c330ab` |
| `porsche911` | `porsche_911_with_interior.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `porsche918` | `porsche_918_spyder_2015.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `revuelto` | `2024_lamborghini_revuelto.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `senna` | `mclaren_senna_free.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `sf90xx` | `2023_ferrari_sf90_xx_stradale.glb` | **5/5** | `VP8X/ALPH/VP8` lossy | `dbaaed6` |
| `tourbillon24` | `bugatti_tourbillon_2024.glb` | 0/5 | `VP8L` lossless, RGBA khác PNG hiện tại | `4c330ab` |
| `valkyrie` | `aston_martin_valkyrie.glb` | 0/5 | `VP8L` lossless, RGBA khác PNG hiện tại | `4c330ab` |

Đặc biệt: **9 album / 45 WebP** exact nằm đúng danh sách mặc định `SHOT_IDS` của [`shoot.mjs`](../tools/render/shoot.mjs). **7 album / 35 WebP** còn lại xuất hiện từ trước khi `shoot.mjs` được thêm vào Git. Có độ phù hợp với mô hình render 3D/5 bố cục và ảnh alpha, nhưng bằng chứng không phân biệt chắc chắn giữa *render bằng script cũ*, *PNG master cũ* hoặc *tài nguyên bên ngoài đã đổi tên*; không tự kết luận nhóm này được sinh bởi script hiện hành.

## 4. Timeline Git và độ bền chứng cứ

| Commit có thể xác nhận bằng Git local | Thời điểm commit +07 | Điều được log xác nhận |
| --- | --- | --- |
| `4c330ab45c31c295525c04d9d5fb95a13d825c72` | 14/11/2026 18:50:49 | Commit đầu chứa các album xe đời đầu (**35 WebP còn lại trong fleet hiện hành**) và **2 ảnh garage**. Có thêm các album `jesko23`, `tourbillon26` đã bị bỏ về sau. **Không** có `tools/render/shoot.mjs` trong commit này. |
| `dbaaed61146555cfe48d34ea91cac3c0412e00ca` | 15/11/2026 12:31:13 | Thêm `tools/render/render.html`, `tools/render/shoot.mjs` và 9 album xe mới (**45 WebP**), xóa nhóm trùng đời cũ. Các WebP trong 9 album này tái mã hóa exact từ PNG master hiện tại. |

Chạy đọc lịch sử không ghi vào Git: `git log --all --name-status -- tools/render assets/images assets/environment`; kiểm tra từng file: `git log --all --diff-filter=A -- <file>`. Commit tác giả chỉ xác minh **người đưa file vào repository**, không phải người vẽ/render/chủ quyền ảnh. **PNG masters không được Git theo dõi** ở revision kiểm tra (đối chiếu `git ls-files 'assets/images/**/*.png'`) dù hiện tồn tại ở working tree; một checkout Git độc lập chưa chắc có đủ ảnh để tái tạo 45 WebP.

Không tìm thấy log có timestamp/hashes ghi lại lệnh `SHOT_IDS=...`, session GPU, version exact GLB tại lúc chụp, download bill/URL hoặc giấy phép gốc trong hai commit này. Các tệp model hoặc renders có thể đã được thay trong môi trường local rồi mới commit. Vì vậy `SHA256(PNG→WebP)` chỉ chứng minh quan hệ giữa **master hiện có** và **WebP hiện có**, không tự chứng minh toàn bộ lịch sử tạo master.

## 5. Hai ảnh garage — khảo sát nguồn riêng, không tự nối với GLB

| File | Kích thước **thật** | Byte size | SHA-256 | Evidence |
| --- | --- | ---: | --- | --- |
| [`private_garage_1920x1080.webp`](../assets/environment/private_garage_1920x1080.webp) | **1672×941**, *không phải* 1920×1080 như tên | 354.550 B | `46288c9cc07a0a98db1e21b901f324f5f51fcd21cdb4a24924d7d05a511d4947` | Git commit `4c330ab`; `index.html` dùng ảnh cho preload/desktop/hero |
| [`private_garage_1080x1350.webp`](../assets/environment/private_garage_1080x1350.webp) | **1080×1350** | 230.852 B | `e296b9eac26e3ad7dddd211e30dd8bbe4a0e6dc66535022e9eeea3819709fdb6` | Git commit `4c330ab`; `index.html` dùng ở media query mobile |

Quan sát ảnh: cùng garage nội thất tối, 5 bays, trần nan và đèn tuyến tính; file portrait chọn vùng trung tâm. Kiểm tra crop tính toán: crop ảnh ngang vùng `(left=460, top=0, width=752, height=941)`, resize cả crop và ảnh dọc về `180×225`, mean absolute channel difference ≈ **3,691 trên miền 0–255**. Kết quả **ủng hộ mạnh quan hệ cùng cảnh/crop** nhưng không thể nhận dạng *file master gốc*, pipeline resize/compression chính xác hoặc *nguồn cấp phép*. Không thấy image EXIF/XMP/ICC chunks; chỉ `VP8` RIFF lossy. Render tool ở mục 2 **chỉ chụp xe**, không có thao tác tạo garage; `index.html` chỉ tham chiếu ảnh đã tồn tại. Tên file, hình nhìn giống ảnh 3D/AI, hoặc commit của người dùng **không phân biệt được** ảnh tự tạo, ảnh AI, ảnh thuê nghệ sĩ hay stock download.

**Hai file vẫn thiếu:** nguồn chính xác, author/owner, thời điểm tạo, original file, quyền commercial use, public display/redistribution/derivative, điều khoản và thông tin attribution. Không gán trang stock bất kỳ làm nguồn khi không có bằng chứng đối chiếu được với SHA/nội dung.

## 6. Đánh giá bằng chứng và việc còn phải truy nguồn

| Nhóm cần xác nhận | Chứng cứ nội bộ hiện có | Chứng cứ **còn thiếu** để công bố |
| --- | --- | --- |
| **45/80 ảnh xe chuyển đổi exact** | `PNG→Sharp q90 WebP` hash byte-exact; tên camera và target GLB đúng script, Git intro đồng thời với script | Proof render PNG từ đúng GLB/version, tác giả tạo ảnh, quyền GLB + texture/derivative/commercial/WebGL và attribution |
| **35/80 ảnh xe legacy lossless** | File commit cũ; WebP `VP8L`, 3840×2160 alpha, cùng 5 camera names/album, local PNG master cùng tên nhưng **khác pixel** | Master/historical script đúng thời điểm, lệnh render, hash GLB cũ, tác giả và nguồn license từng input; nếu không chứng minh, thay thế bằng ảnh có chain-of-title được phê duyệt |
| **2 ảnh garage** | Chỉ có byte SHA256/size và Git commit; dấu hiệu rất mạnh cặp crop | Original file/creator/source URL có bằng chứng, license cụ thể cho ảnh gốc và bản crop, quyền phát hành trên website |
| **16 GLB nguồn** | `VEHICLES.file` + GLB manifest SHA; các `asset.extras`/uploader/source metadata nếu tìm thấy bên trong file GLB chỉ là **manh mối truy nguồn** | Đúng URL của tác phẩm phiên bản đó, author/uploader hợp lệ, bản ghi license tại thời điểm tải, kiểm tra game-rip/provenance, quyền derivative/convert/self-host/commercial và ký duyệt độc lập; phối hợp audit GLB riêng của Prime |
| **Cảnh/material** | Three.js `RoomEnvironment`, PMREM, ánh sáng trong `render.html`, nhiều texture nằm trong GLB | Quyền đối với texture, thiết kế model, môi trường/thư viện và nhãn hiệu. License mã nguồn Three.js **không** tự truyền quyền tác giả lên model hoặc renders |

`docs/p5-asset-rights-register.json` là hồ sơ quyền theo từng asset; P9 **không** chỉnh trạng thái `UNVERIFIED`, không thêm reviewer/giấy phép giả. [P7 rights audit](p7-asset-audit.md) và [P5 public launch checklist](p5-public-launch-checklist.md) tiếp tục điều khiển G0/G4. Manufacturer `source:` URLs ở `VEHICLES` không phải giấy phép cho GLB và không được đưa vào cột `sourceRightsUrl`. **Nguồn tự tìm ra được lúc này là source code/ảnh trong repository có thể kiểm chứng**, không phải chứng từ cấp phép từ bên thứ ba.

## 7. Lặp lại kiểm tra an toàn (read-only)

```bash
cd /vibe-coding/VELANCE
node --version                          # Node24
git log --all --name-status -- tools/render assets/images assets/environment
git ls-files tools/render assets/images assets/environment

# Đối chiếu JSON đã ghi với bytes đang có; không re-render, không ghi file.
node --input-type=module <<'NODE'
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const data = JSON.parse(fs.readFileSync('docs/p9-image-lineage.json', 'utf8'));
assert.equal(data.carRenders.length, 80);
assert.equal(data.garage.length, 2);
for (const entry of [...data.carRenders, ...data.garage]) {
  const bytes = fs.readFileSync(entry.path.slice(1));
  assert.equal(bytes.length, entry.webpBytes ?? entry.bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),
    entry.webpSha256 ?? entry.sha256);
}
assert.equal(data.carRenders.filter(x => x.matchedExactSharpQuality90AlphaQuality100).length, 45);
assert.equal(data.carRenders.filter(x => x.webpCodec === 'VP8L_lossless').length, 35);
console.log('P9 82/82 SHA256 PASS; 45 exact encoding, 35 legacy VP8L');
NODE

git diff --check
```

P9 forensic chỉ xác nhận hiện trạng source được đọc ở thời điểm ghi audit. Không ngầm hợp pháp hóa ảnh, không tải lại nội dung từ nguồn không được xác minh, không công bố release mới và không chạm database. **Quyết định public: NO-GO** cho đến khi G0 xác thực đầy đủ quyền tài sản và các gate bảo mật/riêng tư/provider còn lại hoàn tất.
