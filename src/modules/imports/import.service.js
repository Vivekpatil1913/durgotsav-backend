/**
 * Bulk registration import: an uploaded sheet (Full Name, Mobile Number, District, Photo URL / Photo File Name) and
 * optional photo ZIP become approved registrations with certificates.
 *
 * The upload request only stores the files and creates a registration_imports row (202). The rows are then processed in
 * the background, in batches of IMPORT_BATCH_SIZE, by the process that received the files, one import at a time:
 *   1. validate each row (mandatory fields, 10-digit mobile, Maharashtra district, the admin's division scope);
 *   2. skip people already registered (same mobile number AND same name — one number may hold several registrations,
 *      as on the website) and repeats within the batch;
 *   3. fetch, check and store each photo exactly like a website upload (prepareParticipantPhoto + savePhoto: WebP copies
 *      and original to S3 or local storage, duplicate-photo check), IMPORT_PHOTO_CONCURRENCY at a time;
 *   4. one short transaction per batch: a bulk insert of the registrations as "verified" (approved) and their photos,
 *      then the certificates, certificate emails and SMS exactly as an admin's approval does (certificates.issueBatch,
 *      queueEmails, sms.enqueue). The background workers render and deliver them.
 * Counters and failed rows (with their reason) are written after every batch, so the admin panel shows progress and
 * the final report. Only one batch is in memory at a time, so a sheet of millions of rows runs in flat memory, and the
 * event loop is never held: parsing is streamed, image work runs on libuv's thread pool, and each batch yields.
 */
import fs from "node:fs/promises";
import { setImmediate as nextTick } from "node:timers/promises";
import { env } from "../../config/env.js";
import { query, withTransaction } from "../../db/pool.js";
import { prepareParticipantPhoto } from "../../services/image.service.js";
import { AppError, notFound } from "../../utils/errors.js";
import { formatRegistrationNo } from "../../utils/format.js";
import { logger } from "../../utils/logger.js";
import { certificateLink } from "../certificates/certificate.links.js";
import * as certificates from "../certificates/certificates.service.js";
import { wakeCertificateWorker } from "../certificates/certificate.worker.js";
import { clearGalleryCache } from "../gallery/gallery.service.js";
import { discardWritten, findDuplicatePhoto, newWritten, savedAfterAll, savePhoto } from "../registrations/registrations.service.js";
import * as sms from "../sms/sms.queue.js";
import { wakeSmsWorker } from "../sms/sms.worker.js";
import { ImportFileError, loadDistricts, NAME_MAX, normalizeMobile, normalizeName, personKey } from "./import.columns.js";
import { downloadPhoto, openPhotoZip, PhotoError } from "./import.photos.js";
import { countRows, readRows } from "./import.reader.js";

const HEARTBEAT_MS = 60_000;
// A 'queued' / 'processing' import whose heartbeat is older than this was cut off (server restart, crash)
const STALE_AFTER = "10 minutes";
// Failed rows shown in the import's detail (all of them are in the errors CSV)
const ERRORS_SHOWN = 200;

const clip = (text, max) => (text === null || text === undefined ? null : String(text).slice(0, max));

// ---------------------------------------------------------------- background runner

const pending = []; // imports waiting in this process
let active = null; // the import being processed
let heartbeat = null;

function beat() {
  const ids = [active?.id, ...pending.map((j) => j.id)].filter(Boolean);
  if (!ids.length) return;
  query("UPDATE registration_imports SET heartbeat_at = NOW() WHERE id = ANY($1::int[])", [ids])
    .catch((err) => logger.warn({ err }, "Import heartbeat not written"));
}

function enqueue(job) {
  pending.push(job);
  if (!heartbeat) {
    heartbeat = setInterval(beat, HEARTBEAT_MS);
    heartbeat.unref();
  }
  if (!active) void runNext();
}

async function runNext() {
  active = pending.shift() ?? null;
  if (!active) {
    clearInterval(heartbeat);
    heartbeat = null;
    return;
  }
  try {
    await runImport(active);
  } catch (err) {
    logger.error({ err, importId: active.id }, "Import runner failed");
  } finally {
    await Promise.all([active.sheetPath, active.zipPath].filter(Boolean).map((f) => fs.unlink(f).catch(() => {})));
    active = null;
    void runNext();
  }
}

/** Resolves once this process has no import running or waiting (tests, graceful shutdown). */
export async function idle() {
  while (active || pending.length) await new Promise((r) => setTimeout(r, 50));
}

/** Marks imports that stopped moving (their process restarted) as failed, so they do not show as running forever. */
export async function failStaleImports() {
  const mine = [active?.id, ...pending.map((j) => j.id)].filter(Boolean);
  await query(
    `UPDATE registration_imports
     SET status = 'failed', finished_at = NOW(),
         error = 'The import was interrupted (the server restarted). Rows imported before that are kept; download the failed rows / results and upload only the remaining rows again.'
     WHERE status IN ('queued', 'processing') AND heartbeat_at < NOW() - INTERVAL '${STALE_AFTER}' AND NOT (id = ANY($1::int[]))`,
    [mine],
  );
}

// ---------------------------------------------------------------- create

/**
 * sheet / zip: { path, originalname, type } of the uploaded files (already on disk). Returns the new import row; the
 * rows are processed in the background.
 */
export async function createImport({ sheet, zip, sendSms, adminId, allowedDivisionIds }) {
  const { rows } = await query(
    `INSERT INTO registration_imports (file_name, zip_name, send_sms, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [clip(sheet.originalname, 255), zip ? clip(zip.originalname, 255) : null, sendSms, adminId],
  );
  enqueue({
    id: rows[0].id,
    sheetPath: sheet.path,
    sheetType: sheet.type,
    zipPath: zip?.path ?? null,
    sendSms,
    adminId,
    allowedDivisionIds,
  });
  return decorateImport(rows[0]);
}

// ---------------------------------------------------------------- processing

async function runImport(job) {
  await query("UPDATE registration_imports SET status = 'processing', started_at = NOW(), heartbeat_at = NOW() WHERE id = $1", [job.id]);
  let zip = null;
  let imported = 0;
  try {
    zip = job.zipPath ? await openPhotoZip(job.zipPath) : null;
    const total = await countRows(job.sheetPath, job.sheetType);
    await query("UPDATE registration_imports SET total_rows = $2, heartbeat_at = NOW() WHERE id = $1", [job.id, total]);
    const ctx = { job, zip, districts: await loadDistricts() };
    let batch = [];
    for await (const row of readRows(job.sheetPath, job.sheetType)) {
      batch.push(row);
      if (batch.length >= env.IMPORT_BATCH_SIZE) {
        imported += await processBatch(ctx, batch);
        batch = [];
        await nextTick(); // let requests in between batches
      }
    }
    if (batch.length) imported += await processBatch(ctx, batch);
    await query("UPDATE registration_imports SET status = 'completed', finished_at = NOW() WHERE id = $1", [job.id]);
    logger.info({ importId: job.id, total, imported }, "Registration import completed");
  } catch (err) {
    const known = err instanceof ImportFileError || err instanceof PhotoError;
    if (!known) logger.error({ err, importId: job.id }, "Registration import stopped");
    await query(
      "UPDATE registration_imports SET status = 'failed', finished_at = NOW(), error = $2 WHERE id = $1",
      [job.id, clip(known ? err.message : `The import stopped: ${err.message}`, 500)],
    ).catch((e) => logger.error({ err: e, importId: job.id }, "Import status not written"));
  } finally {
    zip?.close();
    // Approved registrations count in the public statistics and gallery filters
    if (imported) clearGalleryCache();
  }
}

// Outside production, an S3 bucket without credentials (a developer machine) must not fail every row: the import then
// keeps originals on local disk (storage/originals), as PARTICIPANT_IMAGE_STORAGE=local does. Production needs S3.
let s3Unavailable = false;
async function storePhoto(owner, prepared, written) {
  const local = env.PARTICIPANT_IMAGE_STORAGE !== "s3" || (s3Unavailable && !env.isProd);
  try {
    return await savePhoto(owner, prepared, written, 0, local ? "local" : "s3");
  } catch (err) {
    if (local || env.isProd || err.code !== "S3_CREDENTIALS_UNAVAILABLE") throw err;
    s3Unavailable = true;
    logger.warn("Import: S3 has no credentials — photo originals are kept on local disk (development only)");
    // The photo is stored again, all of it on local disk
    await discardWritten(written);
    written.files.length = 0;
    written.keys.length = 0;
    return savePhoto(owner, prepared, written, 0, "local");
  }
}

// Runs fn over items, at most `limit` at a time
async function eachLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function photoReason(err) {
  if (err instanceof PhotoError) return err.message;
  // prepareParticipantPhoto's checks (not an image, too small, too many pixels)
  if (err instanceof AppError) return `Photo: ${err.message.replace("The uploaded file is", "the file is")}`;
  return `Photo could not be stored (${err.code ?? err.message})`;
}

/** Validates, de-duplicates and saves one batch of rows. Returns how many were imported. */
async function processBatch(ctx, rows) {
  const { job, zip, districts } = ctx;
  const failures = [];
  const fail = (row, reason) => failures.push({ row, reason });
  const candidates = [];
  const seen = new Set();

  // 1. Row rules
  for (const row of rows) {
    const name = normalizeName(row.name);
    if (!name) { fail(row, "Full Name is missing"); continue; }
    if (name.length < 2) { fail(row, "Full Name must have at least 2 characters"); continue; }
    if (name.length > NAME_MAX) { fail(row, `Full Name is longer than ${NAME_MAX} characters`); continue; }
    if (!row.phone) { fail(row, "Mobile Number is missing"); continue; }
    const phone = normalizeMobile(row.phone);
    if (!phone) { fail(row, `Mobile Number "${row.phone}" is not a valid 10-digit mobile number`); continue; }
    if (!row.district) { fail(row, "District is missing"); continue; }
    const district = districts.find(row.district);
    if (!district) { fail(row, `District "${row.district}" is not a Maharashtra district`); continue; }
    if (job.allowedDivisionIds && !job.allowedDivisionIds.includes(district.division_id)) {
      fail(row, `District "${row.district}" is outside the divisions you manage`);
      continue;
    }
    let source = null;
    if (row.photoFile && zip) source = { file: row.photoFile };
    else if (row.photoUrl) source = { url: row.photoUrl };
    else if (row.photoFile) { fail(row, "Photo File Name is given but no ZIP file of photos was uploaded"); continue; }
    const key = personKey(phone, name);
    if (seen.has(key)) { fail(row, "Repeats an earlier row of this sheet (same name and mobile number)"); continue; }
    seen.add(key);
    candidates.push({ row, name, phone, district, source, key });
  }

  // 2. Already registered: same mobile number and same name (index (phone, id))
  let fresh = candidates;
  if (candidates.length) {
    const { rows: existing } = await query(
      "SELECT id, phone, name FROM registrations WHERE phone = ANY($1::varchar[]) AND deleted_at IS NULL ORDER BY id",
      [[...new Set(candidates.map((c) => c.phone))]],
    );
    const taken = new Map();
    for (const r of existing) if (!taken.has(personKey(r.phone, r.name))) taken.set(personKey(r.phone, r.name), r.id);
    fresh = candidates.filter((c) => {
      const id = taken.get(c.key);
      if (id) fail(c.row, `Already registered with this name and mobile number (${formatRegistrationNo(id)})`);
      return !id;
    });
  }

  // 3. Registration numbers, then photos (stored before the transaction, as on the website)
  if (fresh.length) {
    const { rows: ids } = await query("SELECT nextval('registrations_id_seq')::int AS id FROM generate_series(1, $1)", [fresh.length]);
    fresh.forEach((c, i) => { c.id = ids[i].id; });
    await eachLimit(fresh.filter((c) => c.source), env.IMPORT_PHOTO_CONCURRENCY, async (c) => {
      c.written = newWritten();
      try {
        const bytes = c.source.url ? await downloadPhoto(c.source.url) : await zip.read(c.source.file);
        const prepared = await prepareParticipantPhoto({
          buffer: bytes, size: bytes.length, originalname: c.source.file ?? c.source.url.split(/[?#]/)[0].split("/").pop(),
        });
        c.photo = await storePhoto({ id: c.id, name: c.name, phone: c.phone }, prepared, c.written);
        c.duplicateOf = await findDuplicatePhoto(c.photo, c.id);
      } catch (err) {
        c.error = photoReason(err);
        await discardWritten(c.written);
      }
    });
  }
  for (const c of fresh) if (c.error) fail(c.row, c.error);
  const ok = fresh.filter((c) => !c.error);

  // 4. One transaction: registrations (approved), photos, certificates, certificate email + SMS
  let imported = 0;
  if (ok.length) {
    try {
      await saveBatch(job, ok);
      imported = ok.length;
    } catch (err) {
      if (await savedAfterAll("SELECT 1 FROM registrations WHERE id = $1", [ok[0].id])) {
        imported = ok.length; // the COMMIT reply was lost, the rows are there
      } else {
        logger.error({ err, importId: job.id }, "Import batch not saved");
        await Promise.all(ok.map((c) => c.written && discardWritten(c.written)));
        for (const c of ok) fail(c.row, `Not saved: database error (${err.code ?? err.message})`);
      }
    }
    if (imported) {
      wakeCertificateWorker();
      if (job.sendSms) wakeSmsWorker();
    }
  }

  await recordProgress(job.id, rows.length, imported, failures);
  return imported;
}

async function saveBatch(job, ok) {
  await withTransaction(async (client) => {
    // A batch is a few bulk statements, but certificates and queues touch indexes on large tables
    await client.query("SET LOCAL statement_timeout = '5min'");
    await client.query(
      `INSERT INTO registrations
         (id, participant_type, name, phone, country, district_id, division_id, status, reviewed_by, reviewed_at, source, import_id)
       SELECT u.id, NULL, u.name, u.phone, 'India', u.district_id, u.division_id, 'verified', $6::int, NOW(), 'import', $7::int
       FROM UNNEST($1::int[], $2::text[], $3::text[], $4::int[], $5::int[]) AS u(id, name, phone, district_id, division_id)
       ORDER BY u.id`,
      [ok.map((c) => c.id), ok.map((c) => c.name), ok.map((c) => c.phone),
        ok.map((c) => c.district.id), ok.map((c) => c.district.division_id), job.adminId, job.id],
    );
    const withPhoto = ok.filter((c) => c.photo);
    if (withPhoto.length) {
      const col = (fn) => withPhoto.map((c) => fn(c.photo, c));
      await client.query(
        `INSERT INTO registration_photos
           (registration_id, original_path, image_path, thumb_path, width, height, size_bytes, mime_type, sha256, dhash,
            duplicate_of_photo_id, storage, storage_key, photo_no, original_name, position)
         SELECT u.*, 1 FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::text[],
                                   $9::text[], $10::text[], $11::int[], $12::text[], $13::text[], $14::int[], $15::text[]) AS u`,
        [col((p, c) => c.id), col((p) => p.original_path ?? null), col((p) => p.image_path), col((p) => p.thumb_path),
          col((p) => p.width), col((p) => p.height), col((p) => p.size_bytes), col((p) => p.mime_type),
          col((p) => p.sha256), col((p) => p.dhash), col((p, c) => c.duplicateOf ?? null), col((p) => p.storage),
          col((p) => p.storage_key ?? null), col((p) => p.photo_no ?? null), col((p) => clip(p.original_name, 255))],
      );
    }
    // Exactly what an admin's approval does (registrations.review, action "verify")
    const ids = ok.map((c) => c.id);
    await certificates.issueBatch(client, ids, job.adminId);
    await certificates.queueEmails(client, ids, job.adminId);
    if (job.sendSms) await sms.enqueue(client, "certificate_link", ok.map((c) => ({ id: c.id, phone: c.phone })));
  });
}

async function recordProgress(importId, processed, imported, failures) {
  if (failures.length) {
    await query(
      `INSERT INTO registration_import_errors (import_id, row_no, name, phone, district, reason)
       SELECT $1::int, u.* FROM UNNEST($2::int[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u`,
      [importId, failures.map((f) => f.row.rowNo), failures.map((f) => clip(f.row.name, 200)),
        failures.map((f) => clip(f.row.phone, 40)), failures.map((f) => clip(f.row.district, 120)),
        failures.map((f) => clip(f.reason, 300))],
    );
  }
  await query(
    `UPDATE registration_imports
     SET processed_rows = processed_rows + $2, imported_rows = imported_rows + $3, failed_rows = failed_rows + $4, heartbeat_at = NOW()
     WHERE id = $1`,
    [importId, processed, imported, failures.length],
  );
}

// ---------------------------------------------------------------- read

const IMPORT_SELECT = `
  SELECT i.*, a.name AS created_by_name FROM registration_imports i LEFT JOIN admins a ON a.id = i.created_by`;

function decorateImport(row) {
  const percent = row.status === "completed" ? 100
    : row.total_rows ? Math.min(99, Math.floor((row.processed_rows / row.total_rows) * 100)) : 0;
  return { ...row, percent };
}

export async function listImports({ limit = 20 } = {}) {
  await failStaleImports();
  const { rows } = await query(`${IMPORT_SELECT} ORDER BY i.id DESC LIMIT $1`, [limit]);
  return rows.map(decorateImport);
}

export async function getImport(id) {
  await failStaleImports();
  const { rows } = await query(`${IMPORT_SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw notFound("Import not found");
  const { rows: errors } = await query(
    `SELECT row_no, name, phone, district, reason FROM registration_import_errors
     WHERE import_id = $1 ORDER BY row_no, id LIMIT ${ERRORS_SHOWN}`,
    [id],
  );
  return { ...decorateImport(rows[0]), errors, errors_shown: errors.length };
}

export async function assertImport(id) {
  const { rowCount } = await query("SELECT 1 FROM registration_imports WHERE id = $1", [id]);
  if (!rowCount) throw notFound("Import not found");
}

const EXPORT_BATCH = 1000;

/** Failed rows of an import, in sheet order, in batches (keyset on id, so a slow download holds no connection). */
export async function* errorRows(importId) {
  let last = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT id, row_no, name, phone, district, reason FROM registration_import_errors
       WHERE import_id = $1 AND id > $2 ORDER BY id LIMIT ${EXPORT_BATCH}`,
      [importId, last],
    );
    if (rows.length) yield rows;
    if (rows.length < EXPORT_BATCH) return;
    last = rows[rows.length - 1].id;
  }
}

/** Registrations an import created, with their certificate, in batches (index registrations_import_idx). */
export async function* resultRows(importId) {
  let last = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT r.id, r.name, r.phone, r.status, d.name_en AS district, c.certificate_no, c.durgveer_no, c.revoked_at
       FROM registrations r
       LEFT JOIN districts d ON d.id = r.district_id
       LEFT JOIN certificates c ON c.registration_id = r.id
       WHERE r.import_id = $1 AND r.id > $2 AND r.deleted_at IS NULL ORDER BY r.id LIMIT ${EXPORT_BATCH}`,
      [importId, last],
    );
    if (rows.length) {
      yield rows.map((r) => ({
        ...r,
        registration_no: formatRegistrationNo(r.id),
        certificate_link: r.certificate_no && !r.revoked_at ? certificateLink(r.id) : "",
      }));
    }
    if (rows.length < EXPORT_BATCH) return;
    last = rows[rows.length - 1].id;
  }
}
