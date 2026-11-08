# Retrospeksi platform Cerebrum — 2026-11-08

Permintaan owner (2026-11-08): *"lakukan retrospeksi terhadap semua fitur, logic dan semua ecosystem cloud platform cerebrum ini."*

Dokumen ini meninjau apa yang dibangun sejak 2026-11-01:
- bagian yang berjalan baik;
- masalah yang terjadi dan pelajarannya;
- risiko yang masih terbuka;
- urutan perbaikan yang disarankan.

Angka diambil dari D1 produksi dan repositori pada 2026-11-08 ±13:00 UTC.

## 1. Ringkasan

- **Arsitektur sudah lengkap dan sehat.** 12 layanan berjalan sehat di versi yang diharapkan, tanpa drift dan tanpa laporan kritis.
  - Semua berjalan di Cloudflare tanpa container: Workers, D1, R2, Durable Objects, Workflows, Access, Workers AI, Artifacts dan Dynamic Workers.
- **Keputusan inti terbukti.** Agent sudah 10 kali men-deploy sendiri lewat consensus, dan Policy Engine menahan 25 usulan lain.
  - Tidak ada satu pun rollback yang dibutuhkan.
  - Audit chain (2.271 event) selalu terverifikasi.
- **Kelemahan terbesar** ada di empat hal:
  1. noise dari agent;
  2. ketergantungan pada fitur Cloudflare yang masih beta;
  3. satu D1 untuk semua data;
  4. jalur deploy yang masih lewat GitHub.

  Semuanya bisa diperbaiki bertahap dan tercatat di §6–§7.

## 2. Peta ekosistem

| Lapisan | Komponen | Peran |
|---|---|---|
| Pintu masuk | `nexus.cryptophys.work` (Nexus, repo xauusd) + Cloudflare Access (Google, Microsoft, OTP) | Satu origin dan satu sesi login (ADR-0010). Nexus tidak diubah dari repo ini. |
| Operator | **Cerebrum Console** (`/console`, `cryptophys-console`) | Backend-for-frontend tanpa otoritas sendiri: meneruskan JWT pengguna ke 50 rute allow-list. Ada CSP ketat, CSRF, menu akun dan halaman fallback akses. |
| Control plane | Platform Registry, Policy Engine, Audit Ledger, Recovery Manager, Drift Detector, Deployment Orchestrator, Platform API | Registry layanan, keputusan kebijakan, audit berantai hash, pemulihan, deteksi drift, deploy dan rollback native, ringkasan. |
| AI | **AI Kernel** (SupervisorAgent DO, agent registry, syscall gate, consensus, owner notices, knowledge) | Agent tier 0–1 dan consensus ADR-0009 (mode `deploy`). Workers AI dibatasi 250 request/hari (free tier). |
| Sumber kode | GitHub (masih sumber kebenaran) → mirror ke **Forge** (Artifacts `cryptophys/platform`) | Fase 3 ADR-0012: Forge sudah menjalankan test, bundle dan pemindaian secret per commit. Paritas dengan GitHub CI 7/20. |
| Data | Satu D1 `cryptophys-control-plane` (34 migrasi), R2 `cryptophys-d1-backups` | Backup harian native dan GitHub on-demand, lifecycle 90 hari. |
| Eksternal (health only) | 4 Worker xauusd, `cryptophys-aether` | Hanya dipantau kesehatannya. Versinya tidak bisa diamati dari sini. |

## 3. Angka

| | |
|---|---|
| ADR | 12 (0001–0012) |
| Worker di repo | 11 (+ Signal Engine, sudah dinonaktifkan) |
| Migrasi D1 | 34 (0001–0033) |
| Test | 358 di Node; 351 per commit di Forge (Cloudflare) |
| Workflow GitHub | 17 |
| Commit sejak 2026-11-01 | 282 |
| Deploy lewat Orchestrator | 23 sukses, 0 gagal |
| Consensus `deploy_commit` | 10 dieksekusi, 25 ditahan Policy Engine, 6 lolos di masa shadow |
| Rollback | 0 |
| Observasi drift | 7.782, dengan 142 drifted (1,8%), semuanya sudah pulih |
| Audit event | 2.271, chain valid |
| Rencana pemulihan | 6 dari agent (5 selesai, 1 gagal); 56 "dinonaktifkan" adalah artefak smoke test deploy (§9) |
| Usulan knowledge (TP-028) | **0** |
| Akun platform | 1 (`user`) |

## 4. Yang berjalan baik

1. **Keamanan berlapis yang konsisten.**
   - Access ada di depan semua Worker, dan setiap Worker tetap memeriksa peran sendiri lewat `access.ts`.
   - Tidak ada shared secret antar-Worker: komunikasi antar-Worker lewat RPC dan service binding.
   - Console tidak menyimpan data peran.
   - Mengubah mode consensus ke atas butuh owner yang manusia; menurunkannya (rem) boleh oleh operator mana pun.
2. **Consensus dan Policy Engine sebagai rem.**
   - Batas deploy (1 per target per jam, 6 per 24 jam) benar-benar menahan usulan berlebih: 25 kali ditahan.
   - Masa shadow (2026-11-06 → 07) memberi data sebelum otonomi dinyalakan.
3. **Audit yang bisa dipercaya.** Setiap mutasi penting ditulis bersama event audit secara atomik, dan chain hash selalu valid.
4. **Rollback tanpa GitHub (fase 2).**
   - Rollback native lewat Deployments API: klaim satu kali di Durable Object, ditandatangani HMAC, hanya pada menit aman, dengan restore otomatis bila gagal.
   - Notifikasi owner pindah ke cron Worker dan email `alerts@notify.cryptophys.work`.
5. **Test yang jujur.**
   - Test berjalan terhadap migrasi D1 yang nyata.
   - Tidak ada test yang di-skip.
   - Test yang sama kini juga berjalan di Cloudflare: snapshot Artifacts → esbuild-wasm → Dynamic Workers, 351/351 dalam ±53 detik.
6. **Deploy yang aman.** Setiap deploy diverifikasi live (health, versi, smoke lewat Access) dan otomatis di-rollback bila gagal. Deploy juga dihindarkan dari menit cron.

## 5. Masalah yang terjadi dan pelajarannya

| Kejadian | Penyebab | Perbaikan | Pelajaran |
|---|---|---|---|
| `render-d1-config.sh` menulis `\n` literal | `printf '%s\\n'` (dari PR validator) | Diperbaiki, plus test regresi | Skrip deploy butuh test hermetik. Validator juga bisa salah. |
| Deploy Forge pertama gagal | Nama field commit Artifacts berbeda dari asumsi | Rollback otomatis, lalu parsing ketat (#214, #215) | Verifikasi live dan rollback otomatis bekerja. Jangan menebak skema API beta. |
| Shim test ikut di-bundle sebagai kode | Glob `[[rules]]` Wrangler dicocokkan ke specifier import | Glob diperbaiki, plus cek di CI (5 modul teks) dan guard runtime | Perilaku tool harus diuji di CI, bukan hanya dibaca dari dokumentasi. |
| 8 peringatan drift berulang (02:30–04:30) | Secret Worker diganti → versi baru tanpa tag | Pulih setelah deploy bertag. Drift Detector kini melapor sekali per episode (perbaikan berikutnya). | Mengganti secret = versi baru. Secrets Store (backlog fase 4) menghilangkan masalah ini. |
| 56 rencana pemulihan dinonaktifkan | **Koreksi (§9):** bukan draf AI. Semua dibuat lalu dinonaktifkan oleh smoke test `deploy-control-plane.yml` pada tiap deploy. Draf AI yang nyata hanya 6 (5 selesai, 1 gagal). | Smoke test jangan menulis data bisnis produksi (§9.2) | Data uji harus bisa dibedakan dari data produksi. |
| Policy menolak deploy Policy Engine 16× | Batas laju plus retry agent | Retry setelah 1 jam (#188) | Batas laju bekerja, tetapi agent perlu backoff yang sopan. |
| Push ke branch tertimpa | `ops-dispatch` force-push ke branch kerja | Script deploy menunggu dan tidak push saat deploy berjalan | Jalur ops sebaiknya tidak memakai branch kerja (lihat §7). |
| Peralihan via Switch account | Logout Access tidak punya redirect | Halaman `/console/switch-account` (#223) | Uji alur login dengan akun nyata. Smoke test service token tidak menangkapnya. |
| Usulan knowledge = 0 | Producer Aether menulis angka 3+ digit di teks bebas, dan validator (#198) menolak | Perlu perubahan di repo Aether | Kontrak producer–consumer lintas repo perlu test bersama. |
| Review Codex tidak berjalan | Kuota habis | — | Review kedua bergantung pada layanan pihak ketiga. AI review di Forge (ADR-0012 §2.3) perlu dipercepat. |

## 6. Risiko dan utang teknis (urut prioritas)

1. **Satu D1 untuk semua.** Registry, audit, consensus, drift, knowledge, akun dan Forge ada di satu database.
   - Ada backup harian, Time Travel dan restore yang kritis (owner).
   - Tetapi tabel volume tinggi (`drift_observations` 7.782 baris dalam 7 hari) tumbuh paling cepat.
   - Retensi (TP-021) perlu dicek terhadap tabel baru: `forge_check_runs` dan `forge_ci_reports`.
2. **Fitur beta.** Artifacts, Dynamic Workers dan Secrets Store masih beta. Forge saat ini hanya informatif, jadi dampaknya terbatas. Sebelum fase 4 (deploy dari Forge), jalur fallback GitHub harus tetap ada sampai paritas 20/20 dan shadow 10 deploy.
3. **Readiness tidak menuntut migrasi terbaru.**
   - `REQUIRED_MIGRATION` masih `0029`, sementara migrasi sudah sampai `0033`. Akibatnya Worker yang membutuhkan tabel Forge bisa "ready" sebelum migrasinya ada.
   - Mitigasi saat ini: urutan deploy (control plane dulu).
   - Lebih baik readiness per Worker dipasang ke migrasi yang benar-benar dibutuhkan.
4. **Cakupan Access satu aplikasi.** Akun `user` lolos edge Access ke semua Worker. Batasnya adalah cek peran di tiap Worker (keputusan owner 2026-11-07). Bisa dipecah menjadi aplikasi Access sendiri untuk Nexus bila jumlah pengguna bertambah.
5. **Jalur deploy dan rollback masih bergantung pada GitHub Actions** (`CLOUDFLARE_API_TOKEN` di GitHub). Fase 4–5 ADR-0012 memindahkannya.
6. **Noise agent.** 32 peringatan auditor dan 26 dari Policy Engine dalam 3 hari, sebagian besar informatif.
   - Drift sudah dideduplikasi.
   - Pola yang sama layak diterapkan ke auditor ("Governance warning" berulang) dan ke laporan veto Policy Engine.
7. **Dokumen SSOT.** `CLAUDE.md` merujuk `docs/SSOT.md` yang tidak ada. Topologi saat ini tersebar di ADR 0008–0012 dan `docs/`, jadi satu halaman topologi terkini diperlukan.
8. **Kontrak dengan Aether.** Validator knowledge kini ketat. Producer Aether harus menyesuaikan teks `paramCandidates()` (tanpa angka 3+ digit di teks bebas), atau usulan knowledge akan tetap 0.

## 7. Rekomendasi (urutan kerja)

| # | Pekerjaan | Pemilik | Fase |
|---|---|---|---|
| 1 | Merge dan deploy dedup notifikasi drift | agent (siap) | sekarang |
| 2 | Terapkan pola "sekali per episode" ke auditor dan veto Policy Engine | agent | **selesai**: auditor hanya melapor jika alasan baru, hitungan naik, atau setelah 6 jam; Policy Engine melapor penolakan identik sekali per jam |
| 3 | Retensi | — | **dicek**: `drift_observations` sudah 90 hari (owner, 2026-11-05). Tabel Forge kecil (satu baris per commit). Retensi baru berarti menghapus data, jadi butuh keputusan owner. |
| 4 | Readiness per Worker berdasarkan migrasi yang dibutuhkan | agent | **selesai**: Forge menuntut 0031–0033 |
| 5 | Halaman topologi tunggal `docs/SSOT.md` (dirujuk `CLAUDE.md`) | agent | **selesai** |
| 6 | Perbaikan wording producer Aether (`paramCandidates`) | validator/owner repo Aether | segera |
| 7 | Type-check dan build Console di Forge (R2 package cache), lalu AI review | agent | fase 3 |
| 8 | Paritas 20/20, lalu deploy dari Forge dalam shadow 10 deploy | agent | fase 4 |
| 9 | Secrets Store untuk `CF_DEPLOY_TOKEN`, `GH_ACTIONS_TOKEN`, `ACCESS_GROUPS_TOKEN` | owner (store, secret), agent (kode) | fase 4 |
| 10 | Jalur ops terpisah dari branch kerja (atau langsung dari Forge) | agent | fase 4 |
| 11 | Cut-over: arsipkan GitHub, cabut token CI | owner | fase 5 |

## 8. Prinsip yang tetap dipegang

- **Hanya advisory:** tanpa trading, tanpa dana, tanpa level harga.
- **Tidak melemahkan apa pun:** auth, Access dan test tidak pernah dilonggarkan. Test tidak pernah di-skip.
- **Wewenang owner:** semua secret dan kredensial dibuat owner. Penghapusan data dan tindakan yang tidak bisa dibatalkan selalu lewat owner.
- **Rem selalu bisa dipakai:** mode `shadow` dan kill switch tersedia setiap saat.

## 9. Hardening: yang seharusnya sudah tidak dipakai (2026-11-08)

Permintaan owner: *"hardening, fitur atau menu apa yang seharusnya sudah tidak dipakai."* Audit kode, konfigurasi, workflow dan data produksi pada 2026-11-08 13:40 UTC.

### 9.1 Siap dipensiunkan sekarang (keputusan owner, karena tidak bisa dibatalkan)

| Item | Bukti | Tindakan |
|---|---|---|
| Worker `cryptophys-home` (Cerebrum lama) | Retired sejak ADR-0010 (2026-11-06); hanya redirect ke Nexus. Masih di-deploy (`f05e1b3`), masih di `PLATFORM_WORKERS` Access, binding `SVC_HOME` di Drift Detector, unit deploy di Orchestrator, allow-list rollback, `deploy-home.yml`. | Setelah minggu redirect (13 Nov): `retire-worker.yml` (kritis), hapus custom domain `home.cryptophys.work`, hapus unit/binding/workflow. |
| Custom domain `console.cryptophys.work` + `LEGACY_HOSTS` | Redirect 301 ke `/console/`; smoke test deploy Console masih memverifikasinya. | Hapus domain dan redirect setelah minggu redirect; sederhanakan smoke test. |
| IdP one-time PIN | Fallback saat Google/Microsoft belum ada. Keduanya kini aktif. | Owner mencabut OTP dari `allowed_idps` di Zero Trust. OTP paling rawan phishing. |

### 9.2 Yang menulis data produksi padahal hanya uji

| Item | Bukti | Tindakan |
|---|---|---|
| Smoke test `deploy-control-plane.yml` membuat lalu menonaktifkan rencana pemulihan | 56 baris `recovery_plans` (status `disabled`, dibuat token CI), 68 `policy.decision` dan 982 observasi drift `manual` dari token CI. Halaman Recovery di Console menampilkan 56 rencana palsu. | Tandai sintetis (prefix/`metadata.synthetic`) dan sembunyikan dari Console dan laporan, atau verifikasi lifecycle Workflow lewat jalur baca saja. Hapus 56 baris lama = keputusan owner. |

### 9.3 Rute dan menu Console yang tidak terpakai

| Rute / menu | Bukti | Tindakan |
|---|---|---|
| `recovery.execute_start` (START) | Tidak dirujuk halaman mana pun; 6 eksekusi yang ada semua dimulai `ai:recovery-manager`. | Hapus dari `UI_ROUTES` dan allow-list. |
| `recovery.execute_finish` (FINISH) | Hanya untuk rencana yang dimulai manual (legacy); saat ini 0 rencana `executing`. | Hapus bersama START. |
| `recovery.create` (CREATE PLAN manual) | 0 rencana dibuat manusia di produksi; semua dari agent atau smoke test. | Pertahankan sebagai jalur darurat, tetapi jadikan approver-only. |
| `kernel.principal_add/remove`, `/mcp` untuk agent eksternal (TP-009) | `agent_principals` = 0, 0 panggilan agent eksternal. | Pertahankan `/mcp` (dipakai operator), sembunyikan tombol principal sampai ada agent eksternal. |
| `registry.desired_version` (VERSION) dan `registry.upsert` (UPDATE) | Operator biasa dapat mengubah versi yang diharapkan dan metadata layanan; itu memicu drift dan usulan redeploy. | Jadikan approver-only. |

### 9.4 Workflow GitHub yang tumpang tindih atau menunggu pensiun

| Workflow | Status | Tindakan |
|---|---|---|
| `rollback-worker.yml` | 0 run; rollback native sudah dikonfigurasi (`CF_DEPLOY_TOKEN`). ADR-0012 mensyaratkan pensiun setelah jalur native pernah berjalan. | Uji satu rollback native terkontrol, lalu hapus. |
| `request-platform-api-deployment.yml` | Jalur manual lama; Orchestrator kini men-dispatch `deploy-platform-api.yml` lewat consensus. | Hapus bersama allow-list ops-dispatch. |
| `validate.yml` | Duplikasi type-check dengan `validate-control-plane.yml`. | Gabungkan. |
| `d1-backup.yml` | Hanya on-demand; backup harian sudah native di Recovery Manager. | Pensiun di fase 5. |
| Langkah "Remove the retired ORCHESTRATOR_SHARED_SECRET" | Secret sudah lama hilang. | Pertahankan hanya cek fail-closed bahwa secret tidak ada; hapus langkah penghapusan. |

### 9.5 Permukaan yang bisa dikecilkan di fase 4

| Item | Catatan |
|---|---|
| `workers_dev = true` di semua Worker | Setiap Worker punya hostname `*.workers.dev` (di belakang Access). Hanya Console/Nexus yang butuh host publik; Worker internal dipanggil lewat service binding. Verifikasi deploy masih lewat workers.dev, jadi matikan setelah smoke check pindah ke Orchestrator/Drift Detector (ADR-0012 §3). |
| `GH_ACTIONS_TOKEN`, cek `ci_green` dari GitHub, dispatch workflow | Pergi bersama fase 4–5. |
| `POST /v1/forge/import` | Sekali pakai, sudah dijalankan (1 event). Hapus setelah cut-over. |
| Deskripsi agent `signal-analyst` | Masih menyebut Signal Engine yang sudah pensiun (TP-017 memindahkannya ke xauusd). Perbaiki teks di migrasi berikutnya. |
