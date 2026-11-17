# VELANCE P7 — Local acceptance và external release blockers

P7 tập trung **G0 asset inventory**, **G1 telemetry opt-in privacy-by-default**, **P7.2 cold-load optimization** và **P7.3 zero-cost loopback staging**. `config/p6/private-staging.json` tiếp tục `deployEnabled=false`, `publicLaunchAuthorized=false`. P7 **không** triển khai CDN cloud, IdP, domain, backup offsite, WAN soak hay public release. Toàn bộ ngân sách hạ tầng mới là **0 đồng**, không thẻ/billing/trial. Xem [phương án miễn phí](p7-free-only.md).

## Kiểm thử

```bash
node tools/p7/rights.mjs --out tools/perf/results/p7-rights-audit-20261117.json
node tools/p7/check.mjs --mode native
node tools/p7/free-staging.mjs --mode smoke
node tools/p6/check.mjs --mode native
node tools/p7/browser_lazy.mjs --out tools/perf/results/p7-lazy-browser-20261117-samplingfix.json
node tools/p7/check.mjs --mode evidence \
  --browser tools/perf/results/p7-lazy-browser-20261117-samplingfix.json \
  --out tools/perf/results/p7-local-acceptance-20261117-samplingfix.json
git diff --check
```

Tất cả evidence JSON được viết **create-only**; chạy lại với tên khác, không ghi đè raw logs. Không dùng `tools/ops/telemetry.db`; test fixture trong `os.tmpdir()`. Node24 required; Chrome 157 headed dùng Puppeteer Core nếu có. P7 native checks về G0 chỉ đối chiếu SHA/inventory và thiếu provenance; `PASS_LOCAL` **không** cấp license hay cho phép phát hành.

## G0–G4 sau P7 local

| Gate | Evidence P7 local | Chưa đạt / phụ thuộc |
| --- | --- | --- |
| G0 | 16 GLB/80 WebP source SHA + full release manifest và excluded-source scope | **0/96 approved** và 2 environment WebPs chưa đăng ký; legal chain-of-title, brand, font/vendor, lineage và ký duyệt |
| G1 | Default opt-out telemetry, opt-in/withdrawal UI, protected collector requests; HTTP local deny regression P6 | Privacy notice/owner, retention/deletion/consent audit server, WAF/TLS, Ops SSO/MFA/RBAC, encrypted off-host recovery |
| G2 | Demand-load browser Chrome WebGPU/WebGL2 trên Mac M5, raw transfer bytes; zero-cost private staging chỉ trên loopback với fixture synthetic | Real provider CDN, origin ACL, 24–72h soak, WAN/multi-region, real mobile devices |
| G3 | Node24 native CI check, local immutable release integration, historical local backup test | Provider canary/rollback, off-host encrypted restore independent host, signed CI provenance, delivered alerts/oncall |
| G4 | **NO-GO** | Legal + Security + Privacy + SRE + Product Owner approvals, all mandatory gates passed |

**Quan trọng:** thay đổi JS/frontend làm đổi immutable source release ID; P4 historical chỉ chứng minh bản hash cũ. P7 browser report phải tham chiếu SHA mới và được so khớp trong `tools/p7/check.mjs --mode evidence --browser ...`. Không sửa các kết quả P4 cũ để tạo cảm giác P7 đã pass.

**Triển khai cloud:** P7.3–P7.5 đang chờ provider/region/domain, budget và account permissions. Chỉ dùng synthetic/user-owned licensed assets cho private staging. Không xây Kubernetes hay DB cluster phức tạp trước khi có số liệu cần HA; SQLite vẫn có SPOF single-writer và backup/failover phải kiểm định độc lập.
