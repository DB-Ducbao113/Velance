# VELANCE P6 — Local acceptance vs provider gates

## Phạm vi

P6 không viết lại P2–P5; triển khai security negative tests và provider-neutral fail-closed staging contract, tài liệu security/privacy/DR/operations, CI native test step và evidence script.

## Chạy nghiệm thu

```bash
node tools/p6/check.mjs --mode native
node tools/p6/check.mjs --mode evidence --out tools/perf/results/p6-local-acceptance.json
git diff --check
```

Chỉ chấm `PASS_LOCAL` sau khi script chạy thành công và report đã tồn tại. Evidence script so current prepared source release SHA với P4 historical: nếu SHA khác thì trường `currentSourceMatchesP4FullBrowserEvidence=false` và cần GPU/full-load rerun trước khi suy luận hiệu suất. Script không thay trạng thái `publicLaunch=BLOCKED`, không provision cloud, không sửa real DB, không tạo public bucket hoặc deploy.

## G0–G4

| Gate | Kết quả local được phép ghi | Bằng chứng vẫn thiếu |
| --- | --- | --- |
| G0 | File/hash inventory 96 asset match (0 approved) | Quyền public của 16 GLB,80 WebP +environment/brand/third-party và Legal signoff |
| G1 | HTTP deny route negative matrix, optional telemetry cap/headers; static release | Provider private origin, TLS, WAF, SSO/MFA/RBAC, consent opt-in, retention, offhost encrypted backups |
| G2 | P4 simulated local benchmark historical, P6 security fixture | Real CDN WAN multi-region, 24–72h soak, real devices, 100 independent browsers nếu requirement |
| G3 | P6 source CI native gate (không tự deploy) và P3 local rollback historical | Clean CI artifact/signed provenance, provider canary/rollback, restore RPO/RTO, alert delivery to on-call |
| G4 | **NO-GO** | Tất cả reviewer/owner signoff, mandatory provider/legal gates verified |

`PASS_LOCAL` là kết quả kiểm thử nội bộ, không có nghĩa ứng dụng đã được bảo vệ bởi gateway hay được phép public. Public Production: `NO-GO` cho tới khi G4 được phê duyệt riêng.
