# Bulk registration import (Excel / CSV)

Admin → Registrations → **Bulk import** (or **Import Excel** on the Dashboard / Registrations page) uploads a sheet of
participants. Every valid row becomes an **approved** registration (`status = 'verified'`) with its certificate,
certificate email job and certificate-link SMS — the same path as an admin's approval.

Code: `src/modules/imports/` · Tests: `tests/import.test.js`

## Sheet format

The sample template (`GET /api/admin/registrations/imports/template.xlsx`) has the exact columns.

| Field | Accepted headers (case, spaces and a trailing `*` ignored) | Rule |
|---|---|---|
| Full Name | `Full Name`, `Full Name *`, `Name`, `नाव` | mandatory, 2–150 characters |
| Mobile Number | `Mobile Number`, `Mobile Number *`, `Mobile`, `Phone` | mandatory, 10 digits (`+91` / `0` / spaces removed) |
| District | `District`, `District *`, `Location`, `Location (District) *`, `जिल्हा` | mandatory, a Maharashtra district (English, Marathi or old name) |
| Photo URL | `Photo URL`, `Photo URL (Direct Link)`, `Photo`, `Image URL` | optional; direct image / S3 URL or Google Drive share link |
| Photo File Name | `Photo File Name`, `File Name` | optional; a file inside the uploaded `.zip` |

- A bracketed note in a header is ignored (`Location (District) *` → Location). Other columns (`Sr. No.`) are ignored.
- The **header row is found among the first 10 rows**, so blank rows or a title banner above it are fine.
- A Photo URL cell may hold clickable text: the **hyperlink target** is used (inserted links and `=HYPERLINK()`).
- Rows are read as text by streaming parsers (`.xlsx` and `.csv`); images pasted into the workbook are not read.

### Google Drive links

`drive.google.com/file/d/<ID>/view…`, `drive.google.com/open?id=<ID>` and `drive.google.com/uc?id=<ID>…` are turned
into `https://drive.google.com/uc?export=download&id=<ID>` and downloaded following redirects. The response must be an
image (`Content-Type: image/*`; untyped `application/octet-stream` bytes are accepted and then checked as images) of at
most `UPLOAD_MAX_MB` (20 MB). A Drive file that is not shared as *Anyone with the link* answers with an HTML sign-in page;
that row fails with *"Google Drive link is private or invalid — set file access to 'Anyone with the link'"*.

### Photo storage

Downloaded photos go through the same code as a website upload: checked and resized (`prepareParticipantPhoto`), with the
original and its WebP copies (the certificate uses `registration_photos.image_path`) in S3 (`PARTICIPANT_IMAGE_STORAGE=s3`,
see [image-storage.md](image-storage.md)) or in `storage/originals` and `uploads/registrations/…` (`local`). Outside
production, when S3 has no credentials, the import keeps them on local disk instead of failing every row; production
requires S3.

## Processing

`POST /api/admin/registrations/imports` (multipart: `file`, optional `photos` .zip, `send_sms`) stores the files in
`storage/imports/` and answers `202`. The API process that received them processes the rows in the background in
batches of `IMPORT_BATCH_SIZE` (one bulk insert and one transaction per batch). A person already registered with the
same name and mobile number is skipped (one number may hold several registrations, as on the website).

| Endpoint (`/api/admin/registrations/imports…`) | |
|---|---|
| `GET /` | recent imports with progress |
| `GET /:id` | one import, with the first 200 failed rows and reasons |
| `GET /:id/errors.csv` | all failed rows with reasons |
| `GET /:id/results.csv` | approved registrations with certificate number and link |
| `GET /template.xlsx` | sample sheet |

Permissions: viewing needs Registrations read; importing needs Registrations write **and** Bulk Review Actions
(`moderation_bulk`). Scoped moderators can only import districts of their divisions.

## Database — migration `042_registration_imports.sql`

- `registration_imports` — one row per upload: status (`queued` / `processing` / `completed` / `failed`), file names,
  `total_rows`, `processed_rows`, `imported_rows`, `failed_rows`, `error`, `created_by`, timestamps, `heartbeat_at`.
- `registration_import_errors` — failed rows: `row_no`, name, phone, district, `reason`.
- `registrations.import_id` (+ partial index) — the import that created a registration; `registrations.source` gains
  `'import'`.

Apply with `npm run db:migrate` (deploy.sh does). An import whose process restarts is marked failed after 10 minutes
without a heartbeat; rows imported before that are kept.

## Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `IMPORT_BATCH_SIZE` | 500 | rows per batch / transaction |
| `IMPORT_PHOTO_CONCURRENCY` | 4 | photos downloaded and resized at once |
| `IMPORT_SHEET_MAX_MB` | 200 | largest sheet |
| `IMPORT_ZIP_MAX_MB` | 2048 | largest photo archive (nginx `client_max_body_size` must allow uploads this large) |
| `IMPORT_ALLOW_PRIVATE_PHOTO_URLS` | false | allow photo URLs on private / loopback addresses (local testing only) |
