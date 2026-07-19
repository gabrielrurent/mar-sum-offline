# MAR SUM Offline (PWA)

Companion PWA offline untuk **Mechanic Activity Report PT SUM (ver 2)**.
Fork dari `mar-offline` (KMB), diadaptasi untuk model bisnis SUM.

- **Backend:** Google Apps Script copy V2 (`ApiService.handleApiPost`), kontrak POST `text/plain` JSON `{token, action, op_id, data}`.
- **Login:** token dari sheet `ApiTokens` (sama dgn web). Identitas selalu dari token.
- **Offline:** cache → antre (IndexedDB outbox) → sinkron. Idempoten via `op_id` + `ProcessedOps` (dedup, dicatat hanya bila sukses).
- **Peran:** mekanik = isi WO; L1/L2 = Buat WO + Approval + Override + Cancel; foreman = Buat WO saja.

Beda dari KMB: tanpa section/scope, tanpa job-katalog, `part_type` wajib (baru/repair/canibal), MTBF mati, tema biru, **override L1/L2 aktif**.

## Hosting
GitHub Pages → Settings → Pages → Branch `main` / root. Bump `CACHE` (sw.js) + `APP_VERSION` (app.js) bareng tiap rilis.
