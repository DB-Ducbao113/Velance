# VELANCE P8 — CI/CD an toàn, 0 VND local-first, KHÔNG triển khai

**Ngày:** 17/11/2026. **Phạm vi:** `.github/workflows/validate.yml`, scanner P8 do worker khác phụ trách (`tools/p8/security.mjs`), các native gates P5/P6/P7 và kiểm định immutable release chỉ trong thư mục tạm. Đây là **CI và dry-run**, **không phải CD lên Internet**. Không tạo dịch vụ có billing, không bật workflow phát hành, không thêm credential, không commit/push/merge/deploy. G0 vẫn **BLOCKED/NO-GO**, quyền công bố 96 assets chưa được kiểm chứng độc lập.

## 1. Kết cấu workflow và mô hình quyền

| Thành phần | Thiết kế trong `validate.yml` | Hạn chế/cảnh báo |
| --- | --- | --- |
| Trigger | `push` tới `main`, `feat/webgpu-carpaint`; `pull_request`; `workflow_dispatch` với hai cờ boolean **mặc định false**: `release_dry_run`, `gpu` | Không có `pull_request_target`, `workflow_run`, `schedule` hay trigger tự động tạo release. GitHub runner **chỉ chạy sau khi workflow/files được push lên repo và Actions được cho phép**. |
| Permissions | Workflow và từng job đều chỉ cấp `contents: read`. Checkout đặt `persist-credentials: false`, `fetch-depth: 1`, `lfs: false`, `submodules: false`. | Không dùng `id-token: write`, `packages: write`, `contents: write`, environment/protected deploy, repo secrets hoặc personal token. GitHub vẫn cung cấp GITHUB_TOKEN nội bộ cho action checkout với read-only permission. |
| Job overlap | `concurrency` theo workflow + PR number/ref; `cancel-in-progress: true` | Lần push/PR sau có thể hủy job cùng nhóm; bằng chứng của run cũ được giữ trong log GitHub theo retention của dịch vụ, không coi run bị hủy là PASS. |
| Runner | `validate` trên `ubuntu-latest`, Node.js **24**, job timeout **30 phút**; `gpu` dành cho `workflow_dispatch` có `gpu=true`, private self-hosted macOS/ARM64/GPU, timeout **20 phút** và `needs: validate`. | Không tự bật GPU qua push/PR. Không giả định máy tự quản có GPU label, Chrome, hoặc dependencies sẵn. Hạn mức Github-hosted Actions phụ thuộc loại repo, gói tài khoản và quy định nhà cung cấp; **không bảo đảm miễn phí vô hạn**. Runner self-hosted dùng máy/điện/mạng của Owner và cần kiểm soát PR/branch trust. |
| Actions | Chỉ dùng official `actions/checkout@v7`, `actions/setup-node@v7` với Node24; `package-manager-cache: false`. Không có `upload-artifact`, `cache` action, `deploy`, `pages`, `release`, `docker push`, AWS/GCP/Azure CLI. | **Hai version tham chiếu dạng `@v7` là mutable major tags**, *chưa* là full immutable commit SHA; review định kỳ và pin SHA **chỉ sau khi đối chiếu commit chính thức**. Không tự tạo/invent SHA để trông có vẻ an toàn. GitHub Actions/checkout và setup-node v7 chạy action runtime Node 24; runner phải hỗ trợ phiên bản action. |
| Npm install | `npm --prefix tools/optimize ci --ignore-scripts --no-audit --no-fund` sau security gate; dùng `package-lock.json`. | Giảm rủi ro lifecycle scripts, không đồng nghĩa kiểm toán chuỗi cung ứng hoàn chỉnh. `--no-audit` không thay cho dependency vulnerability scan/SBOM có policy. Không cấp registry publish token. |

**Quy tắc quan trọng:** không tự tạo thư mục `.env`, không đọc `/tools/ops/telemetry.db` thật, không tự sinh evidence `PASS` khi lệnh fail. Scanner và toàn bộ native gate có exit code khác 0 phải **làm job đỏ** (được chạy trực tiếp trong `bash` GitHub Actions với fail-fast mặc định; job không có `continue-on-error`). PR do fork gửi có thể chứa mã untrusted; không chạy workflow nhận secret hoặc tự động dùng self-hosted runner cho PR.

## 2. Quality gates: điều kiện được ghi PASS_LOCAL

Workflow chạy tuần tự các bước, và bước sau không chạy nếu bước bắt buộc trước đó lỗi:

1. **Node 24 + P8 security**: kiểm tra phiên bản Node, file scanner phải tồn tại và `node tools/p8/security.mjs --mode ci` phải exit 0. Fail closed nếu thiếu file, vi phạm chính sách hoặc parser lỗi. Worker-3 chịu trách nhiệm scanner: workflow **không** gán giả kết quả cho scanner chưa chạy.
2. **Optimization/supply-chain**: `npm ci` theo lockfile, native tests trong `tools/optimize`, GLB budgets và vendor file integrity `tools/vendor/verify.mjs`. `npm pack --dry-run --ignore-scripts` ở thư mục `packages/tsl-carpaint` chỉ in danh sách package, **không** `npm publish` và không upload binary.
3. **P5/P6/P7 local native**: `node tools/p5/check.mjs --mode native`, `node tools/p6/check.mjs --mode native`, `node tools/p7/check.mjs --mode native`. Chạy theo Node 24; các gate hiện có tự gọi kiểm thử P4/P3/P2 và kiểm tra G0 quyền file/hash, security negative routes, consent opt-in/withdrawal. Có thể có trùng regression để bảo toàn hợp đồng hiện có; ưu tiên tính đúng trước khi tối ưu thời gian runner.

   **Lưu ý sau khi chạy thực tế trên GitHub-hosted Ubuntu (17/11/2026):** bài P4 synthetic `3-day/900k-sample` có 20/20 ACK, backup được xác minh, 13 ACK trong lúc backup, SIGKILL/restart và SQLite integrity đều pass; tuy nhiên shared runner trả p95 ACK 237,73 ms (giới hạn nghiêm ngặt 150 ms), p99 335,56 ms (giới hạn 300 ms), khiến strict benchmark CLI exit 1. Ngưỡng `p4_mixed_soak.mjs` **giữ nguyên** và khi gọi trực tiếp vẫn trả lỗi nếu vượt giới hạn. Riêng regression `tools/perf/test/p4_mixed_soak.mjs` khi `CI=true`, với workload 900k rows, cho phép đánh dấu **chỉ bốn gate độ trễ phụ thuộc runner** là `SHARED_RUNNER_SLO_NOT_PROVEN` nếu toàn bộ gate tính đúng đắn, 100% ACK, RSS, backup overlap, fault recovery và SQLite durability đều pass. Không áp dụng ngoại lệ cho smoke test, các lỗi mạng/HTTP, mất dữ liệu, backup, recovery hoặc timeout. **CI xanh ở chế độ này không chứng minh đạt SLO p95/p99 production, cũng không thay thế P4 strict local performance acceptance riêng theo cấu hình máy đo đã định.**
4. **P8 native HTTP headers và security regression**: `node tools/p8/check.mjs --mode native` (Prime phụ trách aggregator) chạy lại P8 scanner, security header/CSP tests, policy-mutation tests và P7/P6 regressions. Đây là gate **bắt buộc**, không dùng `continue-on-error` để bỏ qua bất kỳ thất bại nào.
5. **Source/package syntax**: `node --check` với showroom UI/engine và TSL package. P7 có kiểm thử lazy-load, không bắt buộc headed Chrome trong PR CI.
6. **Optional manual ephemeral release dry-run**: *chỉ* nếu `workflow_dispatch` với `release_dry_run=true` và toàn bộ gate trước đã qua: `node tools/p8/release-dry-run.mjs` (script do Prime phụ trách) → `createSnapshot` vào thư mục tạm → `verifySnapshot` (SHA256 từng byte) → kiểm tra release/active pointer, đúng **16 GLB + 80 WebP biên tập + 2 WebP môi trường**, in metadata release ID và số file, xóa toàn bộ thư mục tạm trong `finally`. **Nếu script vắng mặt, job phải fail closed.**
7. **Optional manual GPU**: *chỉ* nếu `workflow_dispatch` với `gpu=true` **và** job `validate` đã pass, trên private self-hosted macOS GPU runner. Chạy HTTP server bind `127.0.0.1` cho `packages/tsl-carpaint/test/gpu.mjs`, tiếp theo `node tools/p7/browser_lazy.mjs` dùng **immutable local P3 release** và Chrome headed để kiểm tra P7 lazy-load/consent trên WebGPU/WebGL2. Dọn `QA_SHOTS` dưới `$RUNNER_TEMP`, **không upload screenshots**. `CHROME_PATH` có thể phải cấu hình khi Chrome không nằm ở đường dẫn mặc định của macOS; không tự động cài Chrome, không chạy GPU khi push/PR. Script `tools/perf/gpu_smoke.mjs` cũ đòi eager load 16 model **không còn được chạy** trong workflow này.

**Không có nhánh “release dry-run = phát hành”**. Bước dry-run có thể tạm sao chép các file media chưa được cấp phép vào disk private của runner để **kiểm tra hash**, nhưng **không đẩy lên artifact storage**. Chỉ in:

```json
{
  "result": "PASS_LOCAL_ONLY",
  "publicLaunch": "NO_GO",
  "uploadedAssets": 0,
  "cloudDeploymentPerformed": false
}
```

Dry-run hiện chỉ in JSON **metadata ra stdout**; không thêm model, WebP, screenshots, ZIP hay manifest đầy đủ vào step summary. Không có `actions/upload-artifact` ở bất kỳ job nào; không có container/image push, public GitHub Release hoặc GitHub Pages. Việc GitHub lưu **source checkout trong runner** và log việc test **không tương đương** cấp quyền phát hành assets: repository visibility và Git tracking của assets phải được Legal/G0 đánh giá riêng trước khi push.

## 3. Chạy tương đương ở local, không cần tài khoản cloud

Mọi lệnh chạy từ root `/vibe-coding/VELANCE`, **Node 24+**. Ví dụ Mac đã có Node v24.21.0 (điều chỉnh đường dẫn tùy máy):

```bash
export PATH="/Users/baobungbu/.nvm/versions/node/v24.21.0/bin:$PATH"
node --version

# P8 security scanner do worker-3 cung cấp; phải có file trước khi chạy.
node tools/p8/security.mjs --mode ci

# Optimization/vendor checks: không tạo hoặc đẩy model mới.
npm --prefix tools/optimize ci --ignore-scripts --no-audit --no-fund
npm --prefix tools/optimize test
node tools/optimize/budget.mjs
node tools/vendor/verify.mjs

# Native gates trên local fixture; không dùng telemetry DB thật.
node tools/p5/check.mjs --mode native
node tools/p6/check.mjs --mode native
node tools/p7/check.mjs --mode native
node tools/p8/check.mjs --mode native

# Syntax và metadata package, chỉ dry-run.
node --check src/engine/showroom.js
node --check src/ui/app.js
node --check packages/tsl-carpaint/src/index.js
node --check packages/tsl-carpaint/demo/app.js
(cd packages/tsl-carpaint && npm pack --dry-run --ignore-scripts)

git diff --check
```

**Không có local command nào tự publish.** Có thể chạy riêng `node tools/p8/release-dry-run.mjs` sau các native gates: script tạo/xóa snapshot ở `os.tmpdir()` mà không cần GitHub, với cùng giới hạn an toàn. Không chạy 100 virtual HTTP clients, headed Chrome, multi-region, 24h soak hoặc benchmark GPU trong mỗi push CI; chúng là bài tách riêng có điều phối và giới hạn tài nguyên.

### Hạn chế trong working tree hiện tại

`git status` tại thời điểm soạn P8 có nhiều file P5/P6/P7/P8 và historical fixtures/evidence **chưa được Git track**. Khi GitHub Actions checkout một revision chỉ gồm file đã commit, các path như `tools/p7/check.mjs`, `docs/p5-asset-rights-register.json` hoặc `tools/perf/results/p5-handoff-evidence.json` **có thể không tồn tại**; P7 native gate cố ý fail closed. **Chưa chạy được full GitHub-hosted CI để xác nhận PASS**; việc chạy được trên local working tree không đủ chứng minh chạy được trên một clean Git checkout. Đưa file vào revision là hoạt động riêng cần Owner/Legal duyệt, đặc biệt GLB/WebP chưa có quyền public và repository visibility.

`tools/p8/security.mjs --mode ci` do worker-3 phụ trách; `tools/p8/release-dry-run.mjs` do Prime phụ trách. **Không giả định** script đã pass khi chưa chạy hoặc chưa có đủ file tại thời điểm checkout. Không bypass scanner bằng `if`, `|| true`, `continue-on-error` hay default xanh khi file thiếu.

## 4. Failure handling / checkpoint

| Tình huống | Hành vi bắt buộc | Quyền ra quyết định |
| --- | --- | --- |
| P8 scanner phát hiện public secret, dangerous workflow permissions hoặc file leak | `exit != 0`; job đỏ, **không** chạy dry-run | Security/DevSecOps điều tra và sửa chính sách |
| Thiếu P8 script, P7 evidence, dependency lockfile hoặc mẫu rights | Job đỏ; không xóa gate để làm xanh | Engineering/Prime xác minh revision hợp lệ; Legal xét nội dung được commit |
| SHA/budget/permission asset mismatch | Job đỏ; không tự optimize/chuyển quyền asset; không upload artifact để debug | Legal/Content Owner + Release Manager |
| Browser/GPU test manual fail sau thay đổi lazy-load | Ghi FAIL; cập nhật fixture test ở task được phê duyệt riêng; không suy diễn từ native PASS | QA/Frontend Owner |
| GitHub Actions minutes, runner quota hoặc CI billing không phù hợp | **Dừng remote Actions** và dùng lệnh local trước khi phát sinh chi phí ngoài ngân sách | Owner/FinOps. Quota **phụ thuộc plan và repo visibility**; không hứa 0 đồng cho remote CI |
| Muốn phát hành thật | **KHÔNG** thực hiện bởi workflow này; G0–G4 license, privacy, provider TLS/WAF/SSO, offhost backup/restore, cost approval còn chặn | Product Owner + Legal + Security + Privacy + SRE ký GO riêng |

## 5. Bằng chứng và trạng thái bàn giao

- Source policy: [`.github/workflows/validate.yml`](../.github/workflows/validate.yml), [P7 acceptance](p7-acceptance.md), [P6 acceptance](p6-acceptance.md), [P5 public launch checklist](p5-public-launch-checklist.md).
- Evidence local *kỹ thuật* trước P8: [`P4 extended acceptance`](../tools/perf/results/p4-extended-acceptance.json) = `PASS_LOCAL`; [`P7 asset audit`](p7-asset-audit.md) = G0 `BLOCKED`, 0/96 rights approved, 2 environment WebP quyền còn thiếu. Bằng chứng P4 cũ thuộc immutable release ID cũ, không chứng minh hiệu năng revision hiện thời.
- **Kết quả local trên working tree tại thời điểm P8:** `node tools/p8/security.mjs --mode ci` → `PASS_LOCAL`, 0 policy violations, 26 lệnh CI đã kiểm tra; `node tools/p8/check.mjs --mode native` → `PASS_LOCAL_NATIVE`, P8 mutation/header **12/12** tests, P7 native pass, P6/P4/P3/P2 nested regression pass; `node tools/p5/check.mjs --mode native` → PASS (không chạy `--mode evidence`, release SHA lịch sử chưa được đối chiếu); `node tools/p8/release-dry-run.mjs` → `PASS_LOCAL_ONLY`, 126 static files, 16 GLB/80 WebP/2 environment, database metadata unchanged, 0 upload/deploy. `npm --prefix tools/optimize test` 3/3 pass, vendor 16 checksums pass, asset budget pass, `npm pack --dry-run` 4 package files không xuất bản. YAML parser Ruby parse pass; `git diff --check` pass. **Không gọi đây là CI GitHub-hosted PASS**.
- Phân loại: **workflow và P8 runtime đã kiểm định local**; **GitHub-hosted execution chỉ được xác minh sau khi có clean Git revision gồm các file cần thiết, không phải hiện tại**; **public launch = NO-GO**. `github.workflow` log/summary chỉ là bằng chứng CI nếu workflow chạy thực sự; tài liệu không tuyên bố chưa xảy ra đã xảy ra.

**Kết luận:** CI đóng vai trò *fail-closed kiểm tra trên một checkout*, không phải đường cấp phép IP hoặc CD. Không có action upload screenshot, không đưa 96 asset chưa duyệt lên GitHub artifact, không tự động tạo deployment hoặc phát sinh tài nguyên hạ tầng có phí từ repo code.
