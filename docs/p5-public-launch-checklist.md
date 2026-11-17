# VELANCE — P5 checklist phát hành công khai (GO/NO-GO)

**Bản handoff:** 17/11/2026. **Trạng thái quyết định: NO-GO / BLOCKED.** P4 extended `PASS_LOCAL` chứng minh các bài test được thực thi trên môi trường local và fixture; **không** cấp phép đưa website, assets, Ops hoặc telemetry lên Internet. Trong phạm vi handoff này **không deploy, không tạo cloud resources, không đăng ký domain, không commit/push và không kích hoạt CI production**.

## 1. Ngôn ngữ trạng thái và quy tắc phê duyệt

| Trạng thái | Ý nghĩa duy nhất |
| --- | --- |
| `VERIFIED_LOCAL` | Đã có kiểm thử/bằng chứng kiểm được trên loopback, fixture hoặc máy local; **chỉ đúng phạm vi đó**. Không mang nghĩa production đã đạt. |
| `BLOCKED` | Thiếu điều kiện tiên quyết mang tính chặn phát hành (pháp lý, riêng tư, bảo mật, quyền sở hữu, DR hoặc cấu hình bắt buộc chưa được phê duyệt). **Không GO** nếu còn dòng `BLOCKED`. |
| `NEEDS_PROVIDER_TEST` | Không thể chứng minh từ loopback; phải chọn provider/region/hardware, cấu hình thật và thử nghiệm có số đo. **Không GO** nếu gate bắt buộc còn trạng thái này. |

Quy trình nâng trạng thái: lưu **artifact truy vết** (report JSON/TAP, export policy, cấu hình as-code, signed approval, log test) và ghi owner/ngày/hash/revision; kiểm tra lại đúng môi trường triển khai; người phụ trách gate ký; Security/Legal/Privacy/Infrastructure/Product Owner ký quyết định cuối. **Không nâng `BLOCKED` thành `VERIFIED_LOCAL` chỉ vì bản cấu hình đã được viết mà chưa thực thi.** Các gate provider phải có kết quả provider thật và được ghi là hoàn tất trong biên bản nghiệm thu; bảng này vẫn chỉ dùng ba mã trạng thái kể trên.

**Evidence cốt lõi đã có:** [`P4 extended acceptance`](../tools/perf/results/p4-extended-acceptance.json) có `result: PASS_LOCAL`; [`P4 acceptance`](../tools/perf/results/p4-acceptance.json), [`P4 native TAP`](../tools/perf/results/p4-native-extended.tap), [`real virtual journeys`](../tools/perf/results/p4-real-asset-virtual-10-25-50-100.json), [`mixed soak`](../tools/perf/results/p4-mixed-soak-60s-3day.json), [`Chrome constrained`](../tools/perf/results/p4-browser-both-constrained.json), [`4 WebGPU tabs`](../tools/perf/results/p4-multitab-webgpu-4.json), [`4 WebGL2 tabs`](../tools/perf/results/p4-multitab-webgl2-4.json). Checklist chi phí/dung lượng: [P5 capacity-cost](p5-capacity-cost.md).

## 2. P4 đã chứng minh gì, chưa chứng minh gì

| Gate / bằng chứng | Trạng thái | Điều có thể khẳng định | Không được suy ra |
| --- | --- | --- | --- |
| Release byte-immutable, manifest SHA-256, ETag/304, rollback ở P3 | `VERIFIED_LOCAL` | Test P3 + P4 trên preview `127.0.0.1`; checksum, cache header, exact route, snapshot và integrity | CDN origin ACL/cache key thực, TLS hoặc quyền phân phối public |
| SQLite seed 30 ngày và HTTP baseline | `VERIFIED_LOCAL` | Fixture 30.000 sessions/9 triệu samples, baseline 600 POST/60 giây hoàn tất, kiểm tra durability/DB integrity theo [`P4 acceptance`](../tools/perf/results/p4-acceptance.json) | 10 POST/s không đồng nghĩa 10 concurrent users; fixture không là production SLO |
| 100 POST/s overload | `VERIFIED_LOCAL` | 1.000 offered, 599 ACK, 401 HTTP 429 dự kiến do rate limiter; không lờ 429 đi | Thành công 1.000/1.000 ở tốc độ 100 POST/s |
| Mixed load + backup + crash recovery | `VERIFIED_LOCAL` | 60 giây local, accepted receipts durable, backup/restore fixture, fault injection theo raw JSON | Off-host encrypted backup, RPO/RTO thật, failover đa host |
| Chrome WebGPU/WebGL2 | `VERIFIED_LOCAL` | 3 paired A/B trên mạng emulated và các thử nghiệm 4 tab cùng một GPU có đủ 16 model, không lỗi trong gate định nghĩa | 100 browser contexts, điện thoại thật đa dòng, multi-region WAN, 24–72h soak |
| Real-asset virtual HTTP 10/25/50/100 | `VERIFIED_LOCAL` | Mỗi virtual HTTP client tải tuần tự 16 GLB + 5 WebP và conditional 304; profile 100 có 2.200/2.200 request hoàn tất, **tối đa 16 download đồng thời**, 0 incomplete 200 | **100 virtual HTTP clients ≠ 100 trình duyệt thật ≠ 100 download cùng lúc ≠ năng lực CDN phục vụ 100 concurrent real users** |

## 3. Gate P5 bắt buộc trước khi public

**Owner trong bảng là vai trò phải nhận trách nhiệm**, không phải xác nhận một cá nhân đã được chỉ định. Dòng nào chưa có tên người chịu trách nhiệm và bằng chứng ký duyệt vẫn chưa hoàn tất.

### A. Quyền tài sản, provenance và nội dung xuất bản

| ID | Gate nghiệm thu và điều kiện PASS | Bằng chứng bắt buộc khi chuyển trạng thái | Owner phải ký | Hiện tại |
| --- | --- | --- | --- | --- |
| **A01** | Kiểm tra **từng 16/16 GLB** qua danh mục đường dẫn + hash; truy xuất **tác giả/chủ thể cấp quyền/URL nguồn/phiên bản/điều khoản cụ thể**, tính hợp lệ của người upload; cho phép **commercial use** nếu có mục đích thương mại, sửa đổi/optimize/convert, **self-host**, phân phối bản GLB qua URL/WebGL và CDN edge, attribution, share-alike. Từ chối game-rip, nguồn không đủ chứng cứ, license “free download” mơ hồ. | Register từng GLB, URL legal terms/screenshot/date, file gốc và chain of title, ghi nghĩa vụ attribution, legal sign-off; đối chiếu asset SHA-256 manifest | Legal/IP + Content/3D Owner | `BLOCKED` |
| **A02** | Kiểm tra **80/80 editorial WebP renders**: từng ảnh link nguồn model, người tạo/render, texture/scene/HDRI, quyền làm derivative/redistribute/public display và brand usage. Asset tạo từ model không tự có quyền phân phối chỉ vì đã được render hoặc đổi định dạng. Kiểm tra **2 ảnh môi trường WebP** và mọi poster/thumbnail/logo/hero/icon/video khác thực sự sẽ public. | Danh mục 80 WebP và material lineage, per-file hash/author/permission, environment/scene rights, chứng từ commercial/public usage/attribution, legal sign-off | Legal/IP + Design/Content Owner | `BLOCKED` |
| **A03** | Các sản phẩm bên thứ ba (fonts, runtime/vendor JS, image libraries, textures, HDRI) đáp ứng điều khoản **phân phối, attribution, nguồn gốc và vulnerabilities**; ghi rõ nếu logo/trademark/car branding cần phép riêng hoặc phần trình bày phải có disclaimer. | Dependency/SBOM + third-party notice + trademark/brand assessment + ảnh minh họa không vi phạm quyền | Legal/IP + Engineering | `BLOCKED` |
| **A04** | Khóa bill of materials của đúng release định xuất bản: đối chiếu danh sách legal `APPROVED` với tất cả file public được phục vụ; bất kỳ media mới hoặc SHA đổi phải quay lại A01–A03. | Approved asset manifest gắn release hash + automated CI match + ký duyệt của Legal và Owner | Release Manager + Legal | `BLOCKED` |

**Đối chiếu hiện tại:** P4 xác nhận file hiện diện và SHA-256 đúng; **không xác minh license/chain-of-title**. File đăng ký quyền đang được lập tại [`p5-asset-rights-register.json`](p5-asset-rights-register.json) với 16 GLB + 80 WebP ở mức **UNVERIFIED** theo handoff hiện tại của Prime. Register là **inventory bằng chứng thiếu**, không phải giấy phép. Nếu không có văn bản cấp phép cụ thể: **NO-GO**. Không sao chép tài sản chưa có quyền lên bucket public chỉ để chạy thử; dùng fixture do nhóm tạo/có quyền khi kiểm định provider.

### B. Domain, HTTPS, edge, CDN và origin tách biệt

| ID | Gate nghiệm thu và điều kiện PASS | Bằng chứng bắt buộc | Owner | Hiện tại |
| --- | --- | --- | --- | --- |
| **B01** | Chọn domain, chủ sở hữu DNS, region và hợp đồng; chứng thực domain, DNS/CAA, TLS certificate quản lý tự động, **HTTPS bắt buộc**, redirect HTTP→HTTPS, HSTS **sau khi** kiểm chứng đầy đủ, không mixed content. | Domain ownership, TLS scan/expiry/renewal drill, DNS record export, HTTPS redirect + negative tests trên staging thuộc quyền quản trị | Infrastructure + Security | `NEEDS_PROVIDER_TEST` |
| **B02** | **Origin không public trực tiếp**: static bucket/object ACL private, block public read/list, chỉ CDN service identity/OAC/OAI/signed request/mTLS hoặc mạng private được quyền fetch; mọi backup và Ops/DB không ở static origin. | Bucket/container ACL/IAM policy export; denied direct-origin/listing test; CDN allowed path test; private key/secret rotation | Security + Cloud Infra | `BLOCKED` |
| **B03** | `/r/<release-id>/...` chỉ định immutable SHA release, file allowlist, `Cache-Control: public, max-age=31536000, immutable`, Content-Type đúng, ETag theo representation; `/` latest pointer **307 no-store**, rollback không mixed release. Canonical path/query và cache key phải không tạo biến thể vô hạn; không cache cookie/user-specific, không serve hidden paths. | CDN rules-as-code, edge/origin access logs, GET/HEAD/304/200/404/403/negative security tests, rollback real PoP và purge/TTL proof | CDN/Delivery Lead + Security | `NEEDS_PROVIDER_TEST` |
| **B04** | WAF, DDoS, bot abuse, ingress/egress quotas, rate limits và cost alerts; kiểm tra hoạt động trong các region/PoP và fail-closed origin nếu edge bị bypass. Không kích hoạt rule chặn nhầm public asset một cách không đo. | WAF policy export, attack simulation có phê duyệt ở staging, edge error telemetry, policy tuning/exception process và incident drill | Security + CDN/SRE | `NEEDS_PROVIDER_TEST` |
| **B05** | Nguồn phát hành không bị lộ `.git`, `node_modules`, `/tools`, `/ops`, `telemetry.db`, WAL/SHM, backups, metadata nội bộ, source model gốc, PNG masters hoặc directory listing. Chặn bypass qua URL encoded traversal, path normalization, symlink và HEAD/Range tùy contract. | Negative matrix HTTP 403/404 qua CDN và direct origin, provider logs, scan path allowlist, config diff với P3 | Security + Delivery Lead | `NEEDS_PROVIDER_TEST` |

### C. Telemetry, Ops, nhận dạng và quyền riêng tư

| ID | Gate nghiệm thu và điều kiện PASS | Bằng chứng bắt buộc | Owner | Hiện tại |
| --- | --- | --- | --- | --- |
| **C01** | Public edge **chỉ** có tuyến telemetry đã phê duyệt: **exact `POST /api/telemetry`**, không chấp nhận alias, query-string, encoded bypass, GET/HEAD khác; JSON đúng content type/cap, no-store, reject 413/429/503 có chủ đích. **Không public** `/api/summary`, `/api/sessions`, `/api/sessions/:id`, `/health/ready`, `/metrics` hoặc bất kỳ `/ops` dashboard nào. | End-to-end edge→upstream routing config, deny-by-default tests từ Internet/staging, origin firewall/NAT proof, API negative matrix, 413/429/error logging | Backend Lead + Security + Delivery | `BLOCKED` |
| **C02** | Trang Ops/admin chỉ truy cập qua private network/VPN và **SSO + MFA + RBAC**, tối thiểu privilege, audit logs, session expiry, break-glass, không có public route nào bypass IdP. Backend DB/metrics/read APIs chỉ accessible nội bộ hoặc qua admin gateway, không dùng public static URL. | IdP tenant config, SSO/MFA/role/deny tests, secrets/access audit, staging external scan; log trường audit không chứa nhạy cảm | Security/IAM + SRE | `BLOCKED` |
| **C03** | Tường minh thông báo telemetry: thu thập gì, mục đích, opt-in/opt-out, consent lưu được/thu hồi được, không thu thập thông tin định danh không cần thiết; xác định data controller, lawful basis, quốc gia/vùng lưu trữ, DPA và yêu cầu quyền truy cập/xóa. Không dựa chỉ vào một flag front-end để coi như đã hoàn tất tuân thủ. | Privacy notice, consent UX và log consent test, data inventory/retention schedule, DPA, DPIA/legal review nếu áp dụng, deletion/export procedure | Privacy/DPO + Product + Legal | `BLOCKED` |
| **C04** | Quản lý dữ liệu vòng đời: giới hạn retention hợp lý cho sessions/samples/logs/metrics/receipts, yêu cầu xóa và thử xóa tận DB + backup lifecycle; không ghi request body, token, IP/UA PII vào logs mặc định. Bảo vệ secrets at rest/in transit, quyền DB, WAL/SQLite files. | Dữ liệu mẫu và cấu hình retention, test deletion/backup expiry, logging redaction scan, encryption key policy + access review | Privacy + SRE + Security | `BLOCKED` |

### D. Backup, phục hồi, quan sát và vận hành sự cố

| ID | Gate nghiệm thu và điều kiện PASS | Bằng chứng bắt buộc | Owner | Hiện tại |
| --- | --- | --- | --- | --- |
| **D01** | Backup **ngoài host**, encrypted in transit & at rest, key/IAM separation, không thể sửa/xóa từ credential runtime thông thường; retention có chủ sở hữu. Xác minh manifest SHA/SQLite integrity và xử lý mất/thiếu backup. | Cloud/object backup config, encryption/KMS policy, off-host access-denied/restore test, audit log, inventory retention và object-lock nếu yêu cầu | SRE/DBA + Security | `BLOCKED` |
| **D02** | Owner định nghĩa **RPO/RTO số cụ thể** và mức mất dữ liệu cho ACK; có diễn tập restore về isolated host, đo timestamp backup gần nhất, restored counts, SQLite integrity, khả năng tiếp tục traffic, failback và disaster recovery runbook. | Biên bản restore có thời lượng và RPO đo được, raw checks, owner approval; không dùng P2/P4 fixture restore làm RTO production | SRE + Product Owner | `BLOCKED` |
| **D03** | Monitoring tách CDN/edge/origin, telemetry, SQLite writer/reader, storage, CPU/RSS/event loop, backup lag/age, certificate expiry, 4xx/429/503/5xx, request p95/p99, cache **byte** hit ratio, origin fill/egress, throughput, cost/quota, real-user JS/browser errors. | Dashboard và alert-as-code, các ngưỡng do owner ký, synthetic probe nhiều vùng, kiểm tra alert **đã thực sự đến người trực** | SRE/Observability + Infra | `NEEDS_PROVIDER_TEST` |
| **D04** | On-call rotation, escalation, paging, runbook rollback, CDN cache poisoning/surge, outage/429/503, mất DB, disk full, credential leak, DDoS. Thực hiện ít nhất một diễn tập severity cao gồm thông báo stakeholder. | Lịch trực có tên, pager delivery test, incident simulation log, postmortem template, escalation contact và quyền dừng phát hành | SRE Lead + Security | `BLOCKED` |
| **D05** | Quota/cost guard: budget đã duyệt, cảnh báo egress/bucket/GET/backup/tier vượt ngưỡng, giới hạn tăng chi phí và cơ chế dừng bot/prefetch/abuse; đối chiếu giá thực provider. | Budget approval và báo giá thực; policy/anomaly alert; dashboard MB/GB split browser-facing và origin egress; đối chiếu [cost model](p5-capacity-cost.md) | FinOps/Procurement + Product Owner | `NEEDS_PROVIDER_TEST` |

### E. CI, chất lượng, tải Internet và thay đổi release

| ID | Gate nghiệm thu và điều kiện PASS | Bằng chứng bắt buộc | Owner | Hiện tại |
| --- | --- | --- | --- | --- |
| **E01** | Pipeline CI có protected branches, review policy, secrets/permissions minimization, dependency/SBOM/known-vulnerability check, license scan, exact approved asset hash matching, Node native gates và release verify, security negative tests. Không đưa license-risk asset vào public artifacts. | Protected branch settings, immutable CI logs, signed build provenance/manifest, vulnerability policy, full P2/P3/P4 native report + legal gate | Eng Lead + DevSecOps + Legal | `BLOCKED` |
| **E02** | Chạy **thật** trên provider với cấu hình phù hợp: CDN PoP cache MISS/HIT theo byte, public TLS, origin egress, 429/503/timeout/5xx, p95/p99 journey, 24–72h soak, multi-region WAN/ISP, peak burst và backpressure; thu client/device ngoài máy origin. Không nội suy từ 16 local concurrent downloads. | Raw provider metrics theo PoP, hardware instance specs, load plan được phép + raw run logs, error budget, cost delta, test/rollout dates | Performance + CDN/Infra | `NEEDS_PROVIDER_TEST` |
| **E03** | Đo Chrome/iPhone/Android/desktop trên **thiết bị thật**: cold/warm, WebGPU/WebGL2/image fallback, 16 models, WebP, 4G/Wi-Fi, GPU memory, frame gap/CPU/battery, real-user consent/caching. Thử **100 independent real browser users** nếu đó là yêu cầu sản phẩm, bằng nhiều client hosts và kết nối thực có giới hạn; không chạy phá hủy provider. | Device matrix, CDP/trace/RUM, video/QA, P50/P95, viewport/accessibility results; đảm bảo quota và permission load test | Frontend QA + Performance + Product | `NEEDS_PROVIDER_TEST` |
| **E04** | Blue/green hoặc canary publish **chỉ khi đủ license**, rollout an toàn theo SHA release; latest pointer update atomic; negative test cache cũ; rollback giữ release trước; chạy test phục hồi 503/origin outage/partial upload trước khi public. | Signed deployment plan, staging canary, rollback drill log, CDN refresh/purge trace, artifact hash match, approval window | Release Manager + SRE + CDN | `NEEDS_PROVIDER_TEST` |
| **E05** | Dựng threat model và kiểm thử bảo mật độc lập: public exposure, upload/data exfiltration, CSRF/CORS, origin bypass, symlink/path traversal, WAF, rate limiter, secret leaks và lỗ hổng supply chain. Mọi lỗi critical/high chặn GO nếu chưa có exception được Security ký bằng văn bản. | Threat model, penetration test report, triage ticket, remediation/exception sign-off, rescan | Security Lead | `BLOCKED` |

## 4. Quy trình quyết định theo mốc có chữ ký

| Checkpoint | Quyền quyết định | Điều kiện đóng | Kết quả đang có |
| --- | --- | --- | --- |
| **G0 — Freeze inventory** | Asset/Content Owner + Legal/IP | Inventory khớp SHA public release, **16/16 GLB + 80/80 WebP** và asset môi trường/brand khác có giấy phép cụ thể; công bố notice đúng | `BLOCKED`: hiện chỉ có file/hash inventory, chưa có quyền public được xác nhận |
| **G1 — Approval bảo mật và data** | Security/IAM + Privacy/DPO | B02, C01–C04, D01–D02, E05 đóng; deny public APIs/Ops và thông tin riêng tư, backup/restore diễn tập đúng policy | `BLOCKED`: thiếu cấu hình provider và signed compliance |
| **G2 — Provider staging verification** | Infra/CDN + Performance + SRE | B01/B03–B05, D03/D05, E02/E03 kết quả thực qua WAN với quota/budget; tải, delay, bytes, 4xx/5xx và monitoring pass | `NEEDS_PROVIDER_TEST`: P4 chỉ local |
| **G3 — Release integrity + rollback** | Release Manager + Eng Lead + SRE | E01/E04 pass và audit được; signed SHA, canary, restore/rollback, báo cáo no-data-leak, tất cả alerts đã tới on-call | `BLOCKED` đến khi pipeline và chính sách quyền hoàn tất |
| **G4 — Final GO/NO-GO** | **Product Owner có thẩm quyền** sau Legal + Security + Privacy + SRE sign-off | Tất cả gate bắt buộc có bằng chứng hiện hành và **không còn `BLOCKED` hoặc `NEEDS_PROVIDER_TEST`**; ký thời điểm, release ID, domain, owner và rollback trigger | **NO-GO** |

**Không có cơ chế “local PASS ⇒ automatic deploy”.** Người ra quyết định phải lưu biên bản gồm họ tên/vai trò, thời gian UTC, release ID/hash, link artifact signed, giá provider và giới hạn rủi ro được chấp nhận. Chỉ sau **G4 GO** mới có lệnh triển khai riêng; handoff P5 hiện tại **không cấp lệnh**.

## 5. Bộ hồ sơ cần nộp cho buổi duyệt P5

| Hồ sơ | Nơi lưu / nguồn kiểm chứng | Người nộp | Trạng thái |
| --- | --- | --- | --- |
| Nghiệm thu kỹ thuật P4 và raw workload | [`p4-extended-acceptance.json`](../tools/perf/results/p4-extended-acceptance.json), các report nguồn nêu ở mục 1 và [`docs/p4-acceptance.md`](p4-acceptance.md) | Engineering/QA | `VERIFIED_LOCAL` |
| Asset rights register + link chứng cứ | [`p5-asset-rights-register.json`](p5-asset-rights-register.json) **chưa chứng minh quyền**; hợp đồng/URL và ký Legal phải bổ sung | Legal/Content | `BLOCKED` |
| Dự báo egress/origin/storage/cost | [`p5-capacity-cost.md`](p5-capacity-cost.md); điền giá thật, forecast, region, request rates, cache hit | FinOps/Infra | `NEEDS_PROVIDER_TEST` |
| Sơ đồ edge/origin/API/SSO và config thật | IaC/policy export, deny test matrix, WAF rules, firewall, DNS/TLS | Infra/Security | `BLOCKED` |
| Privacy + incident + DR | Consent notice, retention, DPA, off-host backup evidence, on-call, RPO/RTO diễn tập | Privacy/SRE | `BLOCKED` |
| Production-like load matrix, user devices | Browser device/WAN test reports, actual PoP measurements and rollback drill | Performance/QA/SRE | `NEEDS_PROVIDER_TEST` |
| Phê duyệt cuối cùng | Biên bản GO/NO-GO ký G0–G4, snapshot release ID và rollback owner | Product Owner | **NO-GO** |

**Kết luận hiện tại:** `PASS_LOCAL` là **bằng chứng năng lực kiểm thử nội bộ**, không phải giấy phép IP, cam kết dịch vụ hay chứng nhận vận hành công khai. **Public launch đang bị chặn.** Không thay đổi source/release/database, không commit/push/deploy trong handoff này.
