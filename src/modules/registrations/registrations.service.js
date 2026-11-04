import { EDITION_YEAR_MR } from "../../config/edition.js";
import { env } from "../../config/env.js";
import { pool, query, withTransaction } from "../../db/pool.js";
import { prepareParticipantPhoto, removeFiles, writeLocalOriginal, writePublicCopies } from "../../services/image.service.js";
import { emailLayout, escapeHtml, sendMail } from "../../services/mail.service.js";
import { istDateFolder, participantFolderName, photoObjectKey } from "../../services/participant-photo-keys.js";
import { deleteObject, ObjectExistsError, presignGetUrl, putObjectIfAbsent } from "../../services/s3.service.js";
import { logger } from "../../utils/logger.js";
import { badRequest, conflict, forbidden, notFound, AppError } from "../../utils/errors.js";
import { formatRegistrationNo, parseRegistrationNo } from "../../utils/format.js";
import { paginate, pageMeta, sortSql } from "../../utils/pagination.js";
import { registrationWindow } from "../settings/settings.service.js";
import * as certificates from "../certificates/certificates.service.js";
import { verifyParticipantPhotoWithAI } from "../../services/ai-moderation.service.js";

const NEAR_DUPLICATE_BITS = 6;

const SELECT_LIST = `
  SELECT r.id, r.participant_type, r.name, r.organization_name, r.members_count, r.phone, r.whatsapp_number, r.email, r.country, r.city,
         r.status, r.review_note, r.reviewed_at, r.created_at, r.deleted_at, r.source,
         r.district_id, d.name_mr AS district, r.division_id, dv.name_mr AS division,
         r.taluka_id, t.name_mr AS taluka,
         r.fort_id, f.name_mr AS fort,
         p.id AS photo_id, p.thumb_path, p.image_path, p.is_featured, p.duplicate_of_photo_id, p.ai_score,
         c.certificate_no, c.revoked_at AS certificate_revoked_at
  FROM registrations r
  LEFT JOIN districts d  ON d.id  = r.district_id
  LEFT JOIN divisions dv ON dv.id = r.division_id
  LEFT JOIN talukas t    ON t.id  = r.taluka_id
  LEFT JOIN forts f      ON f.id  = r.fort_id
  LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1
  LEFT JOIN certificates c ON c.registration_id = r.id`;

const decorate = (row) => row && { ...row, registration_no: formatRegistrationNo(row.id) };

// ---------------------------------------------------------------- division scope helper

// Appends a division scope clause to a WHERE builder.
// allowedDivisionIds: null = all; [] = none; number[] = specific IDs.
function addDivisionScope(where, params, allowedDivisionIds) {
  if (allowedDivisionIds === null || allowedDivisionIds === undefined) return;
  if (allowedDivisionIds.length === 0) {
    where.push("FALSE");   // user has no divisions — return no records
    return;
  }
  params.push(allowedDivisionIds);
  where.push(`r.division_id = ANY($${params.length}::int[])`);
}

// Throws 403 if the registration's division is outside the allowed scope.
async function assertRegistrationScope(registrationId, allowedDivisionIds) {
  if (allowedDivisionIds === null) return;  // unrestricted
  const { rows } = await query("SELECT division_id FROM registrations WHERE id = $1", [registrationId]);
  if (!rows[0]) throw notFound("Registration not found");
  if (!allowedDivisionIds.includes(rows[0].division_id)) throw forbidden();
}

// ---------------------------------------------------------------- duplicate-photo helpers

async function findDuplicatePhoto(client, photo, registrationId) {
  const { rows } = await client.query(
    `SELECT p.id FROM registration_photos p
     JOIN registrations r ON r.id = p.registration_id AND r.deleted_at IS NULL
     WHERE p.registration_id <> $4
       AND (p.sha256 = $1
        OR bit_count(('x' || p.dhash)::bit(64) # ('x' || $2)::bit(64)) <= $3)
     ORDER BY (p.sha256 = $1) DESC, p.id
     LIMIT 1`,
    [photo.sha256, photo.dhash, NEAR_DUPLICATE_BITS, registrationId],
  );
  return rows[0]?.id ?? null;
}

async function assertReferences({ district_id, taluka_id, fort_id }) {
  const [d, t, f] = await Promise.all([
    district_id ? query("SELECT division_id FROM districts WHERE id = $1", [district_id]) : { rowCount: 1, rows: [] },
    taluka_id   ? query("SELECT 1 FROM talukas WHERE id = $1 AND district_id = $2 AND deleted_at IS NULL", [taluka_id, district_id ?? null]) : { rowCount: 1 },
    fort_id     ? query("SELECT 1 FROM forts WHERE id = $1 AND deleted_at IS NULL AND is_active", [fort_id]) : { rowCount: 1 },
  ]);
  if (!d.rowCount) throw badRequest("Please select a valid district", { district_id: "Invalid district" });
  if (!t.rowCount) throw badRequest("Please select a valid taluka", { taluka_id: "Invalid taluka" });
  if (!f.rowCount) throw badRequest("Please select a valid fort", { fort_id: "Invalid fort" });
  return { division_id: d.rows[0]?.division_id ?? null };
}

// ---------------------------------------------------------------- photo storage

async function uploadOriginalToS3(client, registration, prepared) {
  const dateFolder = istDateFolder();
  const folder = participantFolderName(registration.name, registration.phone);
  const prefix = `${dateFolder}/${folder}/`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1)), pg_advisory_xact_lock(hashtext($2))",
    [`s3-folder:${prefix}`, `registration-photos:${registration.id}`]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(photo_no), 0)::int AS n FROM registration_photos
     WHERE starts_with(storage_key, $1) OR registration_id = $2`,
    [prefix, registration.id],
  );
  for (let number = rows[0].n + 1, attempt = 0; ; number++, attempt++) {
    const { key, fileName } = photoObjectKey({ dateFolder, folder, number, ext: prepared.ext });
    try {
      await putObjectIfAbsent({
        key,
        body: prepared.buffer,
        contentType: prepared.content_type,
        metadata: { "registration-id": String(registration.id), "photo-no": String(number), sha256: prepared.sha256 },
      });
      return { storage: "s3", storage_key: key, photo_no: number, file_name: fileName };
    } catch (err) {
      if (err instanceof ObjectExistsError && attempt < 20) continue;
      throw err;
    }
  }
}

async function savePhoto(client, registration, prepared, written) {
  const copies = await writePublicCopies(prepared);
  written.files.push(...copies.files);
  let original;
  if (env.PARTICIPANT_IMAGE_STORAGE === "s3") {
    original = await uploadOriginalToS3(client, registration, prepared);
    written.keys.push(original.storage_key);
  } else {
    const local = await writeLocalOriginal(prepared);
    written.files.push(local.file);
    original = { storage: "local", original_path: local.original_path };
  }
  return {
    ...original,
    image_path: copies.image_path,
    thumb_path: copies.thumb_path,
    width: prepared.width,
    height: prepared.height,
    size_bytes: prepared.size_bytes,
    mime_type: prepared.content_type,
    original_name: prepared.original_name,
    sha256: prepared.sha256,
    dhash: prepared.dhash,
  };
}

const newWritten = () => ({ files: [], keys: [] });

async function discardWritten(written) {
  await removeFiles(written.files);
  for (const key of written.keys) {
    await deleteObject(key).catch((err) => logger.error({ key, code: err.code }, "S3: could not remove an orphaned upload"));
  }
}

async function findBySubmission(submissionId, phone) {
  const { rows } = await query("SELECT id, phone, status, created_at FROM registrations WHERE submission_id = $1", [submissionId]);
  if (!rows[0]) return null;
  if (rows[0].phone !== phone) throw conflict("This form was already submitted. Please reload the page and try again", "SUBMISSION_REUSED");
  return { id: rows[0].id, registration_no: formatRegistrationNo(rows[0].id), status: rows[0].status, created_at: rows[0].created_at, replayed: true };
}

// ---------------------------------------------------------------- public

// files: [main photo, optional second photo]
export async function register(input, files, meta) {
  const window = await registrationWindow();
  if (!window.open) {
    throw new AppError(403, window.reason === "not_started" ? "Registration has not opened yet" : "Registration is closed", {
      code: "REGISTRATION_CLOSED",
      details: window,
    });
  }
  if (input.submission_id) {
    const existing = await findBySubmission(input.submission_id, input.phone);
    if (existing) return existing;
  }
  const [file, file2] = files;
  if (!file) throw badRequest("Please upload a selfie with your fort replica or a photograph of the fort replica", { photo: "Photo is required" });
  const { division_id } = await assertReferences(input);

  const prepared = await prepareParticipantPhoto(file);
  const prepared2 = file2 ? await prepareParticipantPhoto(file2) : null;
  if (prepared2 && prepared2.sha256 === prepared.sha256) {
    throw badRequest("Please choose two different photos", { photo_2: "Same as the first photo" });
  }
  // AI Moderation check on participant fort photo (Gemini)
  let aiResult = { isValid: false, aiUnavailable: true };
  try {
    aiResult = await verifyParticipantPhotoWithAI(prepared.buffer);
  } catch (err) {
    logger.warn({ err: err.message }, "AI moderation error, safely falling back to manual admin review");
  }

  // Option 2 (100% Safe): Never block registration.
  // If AI approves -> automatically verified + instant certificate download.
  // If AI rejects, fails, times out, or quota exhausted -> fallback to 'pending' (original manual admin review).
  const aiVerified = Boolean(aiResult?.isValid && !aiResult?.aiUnavailable);

  const written = newWritten();
  try {
    return await withTransaction(async (client) => {
      let rows;
      if (aiVerified) {
        // AI approved → insert as 'verified' with review note
        ({ rows } = await client.query(
          `INSERT INTO registrations
             (participant_type, name, organization_name, phone, email, country,
              district_id, division_id, taluka_id, city, fort_id, replica_notes,
              ip_address, user_agent, submission_id, members_count, whatsapp_number,
              status, reviewed_at, review_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, 'verified', NOW(), $18)
           RETURNING id, status, created_at`,
          [input.participant_type, input.name, input.organization_name ?? null, input.phone,
            input.email ?? null, input.country || "India",
            input.country === "India" ? input.district_id : null,
            input.country === "India" ? (division_id ?? null) : null,
            input.country === "India" ? (input.taluka_id ?? null) : null,
            input.city ?? null, input.fort_id ?? null, input.replica_notes ?? null,
            meta.ip, meta.userAgent?.slice(0, 300) ?? null, input.submission_id ?? null,
            input.participant_type === "individual" ? null : (input.members_count ?? null),
            input.whatsapp_number ?? null,
            aiResult.reason || "AI Verified"],
        ));
      } else {
        // Fallback: AI rejected, quota exhausted, or unavailable → insert as 'pending' (original flow, admin will review)
        const pendingNote = (!aiResult?.isValid && !aiResult?.aiUnavailable && aiResult?.reason)
          ? `AI तपासणी: ${aiResult.reason}`
          : null;
        ({ rows } = await client.query(
          `INSERT INTO registrations
             (participant_type, name, organization_name, phone, email, country,
              district_id, division_id, taluka_id, city, fort_id, replica_notes,
              ip_address, user_agent, submission_id, members_count, whatsapp_number,
              status, review_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, 'pending', $18)
           RETURNING id, status, created_at`,
          [input.participant_type, input.name, input.organization_name ?? null, input.phone,
            input.email ?? null, input.country || "India",
            input.country === "India" ? input.district_id : null,
            input.country === "India" ? (division_id ?? null) : null,
            input.country === "India" ? (input.taluka_id ?? null) : null,
            input.city ?? null, input.fort_id ?? null, input.replica_notes ?? null,
            meta.ip, meta.userAgent?.slice(0, 300) ?? null, input.submission_id ?? null,
            input.participant_type === "individual" ? null : (input.members_count ?? null),
            input.whatsapp_number ?? null,
            pendingNote],
        ));
      }

      const registration = rows[0];
      const owner = { id: registration.id, name: input.name, phone: input.phone };
      for (const [index, p] of [prepared, prepared2].entries()) {
        if (!p) continue;
        const photo = await savePhoto(client, owner, p, written);
        await insertPhoto(client, registration.id, photo, await findDuplicatePhoto(client, photo, registration.id), index + 1);
      }

      if (aiVerified) {
        // Issue certificate immediately and return download link
        await certificates.issue(client, registration.id, null);
        const certRes = await client.query("SELECT certificate_no, durgveer_no FROM certificates WHERE registration_id = $1", [registration.id]);
        const cert = certRes.rows[0];
        return {
          id: registration.id,
          registration_no: formatRegistrationNo(registration.id),
          status: "verified",
          certificate_no: cert?.certificate_no,
          durgveer_no: cert?.durgveer_no,
          phone: input.phone,
          download_url: `/api/certificates/download?registration=${encodeURIComponent(formatRegistrationNo(registration.id))}&phone=${encodeURIComponent(input.phone)}`,
          created_at: registration.created_at,
        };
      } else {
        // Pending — original flow: admin approves, then certificate + SMS sent automatically
        return {
          id: registration.id,
          registration_no: formatRegistrationNo(registration.id),
          status: registration.status,
          created_at: registration.created_at,
        };
      }
    });
  } catch (err) {
    await discardWritten(written);
    if (err.code === "23505" && err.constraint === "registrations_submission_id_key") {
      const existing = await findBySubmission(input.submission_id, input.phone);
      if (existing) return existing;
    }
    throw err;
  }
}

// Makes `photo` the current one in its slot (1 = main, 2 = second view), retiring whatever was there.
async function insertPhoto(client, registrationId, photo, duplicateOf, position = 1) {
  await client.query("UPDATE registration_photos SET is_current = FALSE WHERE registration_id = $1 AND position = $2", [registrationId, position]);
  await client.query(
    `INSERT INTO registration_photos
       (registration_id, original_path, image_path, thumb_path, width, height,
        size_bytes, mime_type, sha256, dhash, duplicate_of_photo_id,
        storage, storage_key, photo_no, original_name, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [registrationId, photo.original_path ?? null, photo.image_path, photo.thumb_path, photo.width, photo.height,
      photo.size_bytes, photo.mime_type, photo.sha256, photo.dhash, duplicateOf,
      photo.storage, photo.storage_key ?? null, photo.photo_no ?? null, photo.original_name ?? null, position],
  );
}

async function findOwned(registrationInput, phone) {
  const id = parseRegistrationNo(registrationInput);
  if (!id) throw badRequest("Registration number is invalid", { registration: "Invalid registration number" });
  const { rows } = await query(`${SELECT_LIST} WHERE r.id = $1 AND r.phone = $2 AND r.deleted_at IS NULL`, [id, phone]);
  if (!rows[0]) throw notFound("No registration found for this registration number and mobile number");
  return decorate(rows[0]);
}

export async function publicStatus(registrationInput, phone) {
  const r = await findOwned(registrationInput, phone);
  return {
    registration_no: r.registration_no,
    name: r.name,
    district: r.district,
    fort: r.fort,
    status: r.status,
    note: ["info_requested", "rejected", "duplicate"].includes(r.status) ? r.review_note : null,
    submitted_at: r.created_at,
    reviewed_at: r.reviewed_at,
    thumb_path: r.thumb_path,
    certificate_available: r.status === "verified" && Boolean(r.certificate_no) && !r.certificate_revoked_at,
    certificate_no: r.certificate_revoked_at ? null : r.certificate_no,
  };
}

export async function resubmit(registrationInput, { phone, replica_notes }, file) {
  const r = await findOwned(registrationInput, phone);
  if (r.status !== "info_requested") throw conflict("This registration is not waiting for more information", "NOT_AWAITING_INFO");
  if (!file && !replica_notes) throw badRequest("Please upload a new photo or add a note");
  const prepared = file ? await prepareParticipantPhoto(file) : null;
  const written = newWritten();
  try {
    await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        "SELECT 1 FROM registrations WHERE id = $1 AND status = 'info_requested' FOR UPDATE", [r.id]);
      if (!rowCount) throw conflict("This registration is not waiting for more information", "NOT_AWAITING_INFO");
      if (prepared) {
        const photo = await savePhoto(client, { id: r.id, name: r.name, phone: r.phone }, prepared, written);
        await insertPhoto(client, r.id, photo, await findDuplicatePhoto(client, photo, r.id));
      }
      await client.query(
        `UPDATE registrations SET status = 'pending', replica_notes = COALESCE($2, replica_notes) WHERE id = $1`,
        [r.id, replica_notes ?? null],
      );
    });
  } catch (err) {
    await discardWritten(written);
    throw err;
  }
  return publicStatus(r.id, phone);
}

// ---------------------------------------------------------------- admin

// Admin list orders by column. Every column runs in one direction, so a row tuple compares like the ORDER BY (see
// neighbors). Each has an index (migrations 001, 006 and 031); all columns are NOT NULL.
const SORTS = {
  created_at: { cols: "r.created_at, r.id", dir: "desc" },
  registration_no: { cols: "r.id", dir: "desc" },
  name: { cols: "r.name, r.id", dir: "asc" },
  phone: { cols: "r.phone, r.id", dir: "asc" },
  status: { cols: "r.status, r.created_at, r.id", dir: "asc" },
};
// The older named orders, still accepted (the review queue and saved links use them)
const SORT_ALIASES = { newest: { sort: "created_at", dir: "desc" }, oldest: { sort: "created_at", dir: "asc" } };
const sortOf = (f) => SORT_ALIASES[f.sort] ?? { sort: f.sort, dir: f.dir };

function buildFilters(f, allowedDivisionIds) {
  const where = [f.trashed ? "r.deleted_at IS NOT NULL" : "r.deleted_at IS NULL"];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.status)           add("r.status = ?",           f.status);
  if (f.district_id)      add("r.district_id = ?",      f.district_id);
  if (f.division_id)      add("r.division_id = ?",      f.division_id);
  if (f.taluka_id)        add("r.taluka_id = ?",        f.taluka_id);
  if (f.fort_id)          add("r.fort_id = ?",          f.fort_id);
  if (f.participant_type) add("r.participant_type = ?",  f.participant_type);
  // Indian days, as the admin sees them, whatever the database's time zone
  if (f.from)             add("r.created_at >= (?::date)::timestamp AT TIME ZONE 'Asia/Kolkata'", f.from);
  if (f.to)               add("r.created_at < ((?::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'", f.to);
  if (f.duplicates === true) where.push("p.duplicate_of_photo_id IS NOT NULL");
  if (f.featured !== undefined) add("COALESCE(p.is_featured, FALSE) = ?", f.featured);
  if (f.q) {
    const id = parseRegistrationNo(f.q);
    params.push(`%${f.q}%`);
    const like = `$${params.length}`;
    const idClause = id ? ` OR r.id = ${Number(id)}` : "";
    where.push(`(r.name ILIKE ${like} OR r.phone LIKE ${like} OR r.whatsapp_number LIKE ${like} OR r.email ILIKE ${like} OR r.organization_name ILIKE ${like}${idClause})`);
  }
  // Division scope — always applied last; overrides any explicit division_id filter
  addDivisionScope(where, params, allowedDivisionIds);
  return { where: `WHERE ${where.join(" AND ")}`, params };
}

// FROM … WHERE … of a list with these filters, for counting (the main-photo join only when a filter reads it)
const countFrom = (f, where) => `FROM registrations r ${needsPhoto(f) ? PHOTO_JOIN : ""} ${where}`;


export async function adminList(filters, allowedDivisionIds) {
  const { where, params } = buildFilters(filters, allowedDivisionIds);
  const { limit, offset } = paginate(filters);
  const [{ rows }, count] = await Promise.all([
    query(`${SELECT_LIST} ${where} ORDER BY ${sortSql(SORTS, sortOf(filters), "created_at")} LIMIT ${limit} OFFSET ${offset}`, params),
    query(
      `SELECT COUNT(*)::int AS total FROM registrations r
       LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1 ${where}`,
      params,
    ),
  ]);
  return { data: rows.map(decorate), meta: pageMeta(filters, count.rows[0].total) };
}

/**
 * Previous / next record around `id` in an admin list (the review queue) with the same filters, sort and division
 * scope, plus the record's position. It works from the record's own sort key, so it also answers for a record that
 * has just left the list (reviewed): next is then the record that followed it. The sort key is read inside SQL,
 * keeping created_at's microseconds. prev / next are index lookups; only the position needs a count.
 */
export async function neighbors(id, filters, allowedDivisionIds) {
  await assertRegistrationScope(id, allowedDivisionIds);
  const exists = await query("SELECT 1 FROM registrations WHERE id = $1", [id]);
  if (!exists.rowCount) throw notFound("Registration not found");

  const { where, params } = buildFilters(filters, allowedDivisionIds);
  const s = sortOf(filters);
  const { cols, dir } = SORTS[s.sort] ?? SORTS.created_at;
  const desc = (s.dir ?? dir) === "desc";
  params.push(id);
  const idParam = `$${params.length}`;
  const cursor = `(SELECT ${cols.replaceAll("r.", "c.")} FROM registrations c WHERE c.id = ${idParam})`;
  const order = (descending) => cols.split(", ").map((c) => `${c} ${descending ? "DESC" : "ASC"}`).join(", ");
  const from = `FROM registrations r
    LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1 ${where}`;
  const [next, prev, counts] = await Promise.all([
    query(`SELECT r.id ${from} AND (${cols}) ${desc ? "<" : ">"} ${cursor} ORDER BY ${order(desc)} LIMIT 1`, params),
    query(`SELECT r.id ${from} AND (${cols}) ${desc ? ">" : "<"} ${cursor} ORDER BY ${order(!desc)} LIMIT 1`, params),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE (${cols}) ${desc ? ">" : "<"} ${cursor})::int AS before,
              COALESCE(BOOL_OR(r.id = ${idParam}), FALSE) AS in_list
       ${from}`,
      params,
    ),
  ]);
  const { total, before, in_list: inList } = counts.rows[0];
  return {
    id,
    prev_id: prev.rows[0]?.id ?? null,
    next_id: next.rows[0]?.id ?? null,
    // null when the record is no longer in the list (just reviewed, or changed by another admin)
    position: inList ? before + 1 : null,
    total,
  };
}

export async function* adminExportStream(filters, allowedDivisionIds) {
  const { where, params } = buildFilters(filters, allowedDivisionIds);
  const sort = sortSql(SORTS, sortOf(filters), "created_at");
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`DECLARE export_cur NO SCROLL CURSOR FOR ${SELECT_LIST} ${where} ORDER BY ${sort}`, params);
    while (true) {
      const { rows } = await client.query("FETCH FORWARD 500 FROM export_cur");
      if (!rows.length) break;
      yield rows.map(decorate);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function adminDetail(id, allowedDivisionIds) {
  await assertRegistrationScope(id, allowedDivisionIds);
  const { rows } = await query(
    `SELECT r.*, d.name_mr AS district, dv.name_mr AS division, f.name_mr AS fort, a.name AS reviewed_by_name
     FROM registrations r
     LEFT JOIN districts d  ON d.id  = r.district_id
     LEFT JOIN divisions dv ON dv.id = r.division_id
     LEFT JOIN forts f      ON f.id  = r.fort_id
     LEFT JOIN admins a     ON a.id  = r.reviewed_by
     WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound("Registration not found");
  const [photos, certificate, samePhone, history] = await Promise.all([
    query(
      `SELECT p.id, p.image_path, p.thumb_path, p.width, p.height, p.size_bytes, p.is_current, p.is_featured,
              p.ai_score, p.created_at, p.duplicate_of_photo_id, dp.registration_id AS duplicate_of_registration_id,
              p.storage, p.storage_key, p.photo_no, p.mime_type, p.original_name, p.position,
              dp.thumb_path AS duplicate_thumb_path, dr.name AS duplicate_of_registration_name
       FROM registration_photos p
       LEFT JOIN registration_photos dp ON dp.id = p.duplicate_of_photo_id
       LEFT JOIN registrations dr ON dr.id = dp.registration_id
       WHERE p.registration_id = $1 ORDER BY p.is_current DESC, p.position, p.id DESC`,
      [id],
    ),
    query(
      `SELECT c.*, j.status AS email_status, j.last_error AS email_error FROM certificates c
       LEFT JOIN certificate_email_jobs j ON j.certificate_id = c.id WHERE c.registration_id = $1`,
      [id],
    ),
    query(
      `SELECT id, name, status, created_at FROM registrations
       WHERE phone = $1 AND id <> $2 AND deleted_at IS NULL ORDER BY id`,
      [rows[0].phone, id],
    ),
    query(
      `SELECT l.action, l.meta, l.created_at, a.name AS admin_name FROM audit_logs l
       LEFT JOIN admins a ON a.id = l.admin_id
       WHERE l.entity = 'registration' AND l.entity_id = $1 ORDER BY l.id DESC LIMIT 50`,
      [String(id)],
    ),
  ]);
  return {
    ...decorate(rows[0]),
    photos: await Promise.all(photos.rows.map((p) => withOriginalUrl({
      ...p,
      duplicate_of_registration_no: p.duplicate_of_registration_id ? formatRegistrationNo(p.duplicate_of_registration_id) : null,
    }))),
    certificate: certificate.rows[0] ?? null,
    same_phone_registrations: samePhone.rows.map(decorate),
    history: history.rows,
  };
}

const originalFileName = (key) => key.split("/").pop();

async function withOriginalUrl(photo) {
  if (photo.storage !== "s3" || !photo.storage_key) return { ...photo, original_url: null };
  try {
    const signed = await presignGetUrl(photo.storage_key, { filename: originalFileName(photo.storage_key) });
    return { ...photo, original_url: signed.url, original_url_expires_at: signed.expires_at };
  } catch (err) {
    return { ...photo, original_url: null, original_error: err.code ?? "S3_UNAVAILABLE" };
  }
}

export async function photoOriginalUrl(registrationId, photoId, allowedDivisionIds) {
  await assertRegistrationScope(registrationId, allowedDivisionIds);
  const { rows } = await query(
    "SELECT storage, storage_key FROM registration_photos WHERE id = $1 AND registration_id = $2",
    [photoId, registrationId],
  );
  if (!rows[0]) throw notFound("Photo not found");
  if (rows[0].storage !== "s3" || !rows[0].storage_key) throw notFound("This photo's original is not stored in S3");
  return presignGetUrl(rows[0].storage_key, { filename: originalFileName(rows[0].storage_key) });
}

const ACTION_STATUS = { verify: "verified", reject: "rejected", request_info: "info_requested", mark_duplicate: "duplicate", reset: "pending" };
// Shown to the participant on their status page when an admin marks a duplicate without a custom note.
const DUPLICATE_NOTE = "हे छायाचित्र दुसऱ्या नोंदणीत आधीच वापरले आहे. एकच छायाचित्र पुन्हा वापरता येणार नाही.";

export async function review(ids, action, note, adminId, allowedDivisionIds) {
  const status = ACTION_STATUS[action];
  return withTransaction(async (client) => {
    // Lock in id order, so overlapping bulk reviews by two admins wait for each other instead of deadlocking
    await client.query("SELECT 1 FROM registrations WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids]);
    // Scope: only update registrations the admin has access to
    const divClause = allowedDivisionIds === null
      ? ""
      : allowedDivisionIds.length === 0
        ? "AND FALSE"
        : `AND division_id = ANY(ARRAY[${allowedDivisionIds.map(Number).join(",")}]::int[])`;
    const { rows } = await client.query(
      `UPDATE registrations
       SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = NOW()
       WHERE id = ANY($1::int[]) AND deleted_at IS NULL ${divClause}
       RETURNING id`,
      [ids, status, action === "verify" || action === "reset" ? null : note ?? (action === "mark_duplicate" ? DUPLICATE_NOTE : null), adminId],
    );
    const changed = rows.map((r) => r.id);
    if (action === "verify") {
      await certificates.issueBatch(client, changed, adminId);
      // Same transaction: a verified registration always has its certificate email queued (and never twice)
      await certificates.queueEmails(client, changed, adminId);
    } else {
      await certificates.revokeForRegistrations(client, changed, adminId, `Registration ${status}${note ? `: ${note}` : ""}`);
      if (action === "reject" || action === "mark_duplicate") {
        await client.query(
          "UPDATE registration_photos SET is_featured = FALSE WHERE registration_id = ANY($1::int[])",
          [changed],
        );
      }
    }
    return changed;
  });
}

const BUTTON_STYLE = "display:inline-block;background:#c2641c;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none";

function rejectionEmail(r, window) {
  const regNo = formatRegistrationNo(r.id);
  const closes = window.closesAt
    ? ` (नोंदणी ${new Date(window.closesAt).toLocaleDateString("mr-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })} पर्यंत सुरू आहे)`
    : "";
  const again = window.open
    ? `<p><b>आपण पुन्हा सहभागी होऊ शकता.</b> वरील कारण लक्षात घेऊन, आपण व आपली दुर्ग प्रतिकृती दोन्ही स्पष्ट दिसतील असे नवीन, मूळ छायाचित्र काढा आणि पुन्हा नोंदणी करा${closes}.</p>
       <p><a href="${env.SITE_URL}/participate" style="${BUTTON_STYLE}">पुन्हा नोंदणी करा</a></p>`
    : "<p>नोंदणीचा कालावधी संपला असल्याने आता नवीन नोंदणी करता येणार नाही. अधिक माहितीसाठी कृपया आमच्याशी संपर्क साधा.</p>";
  return {
    to: r.email,
    subject: `अमृत दुर्गोत्सव ${EDITION_YEAR_MR} — आपली नोंदणी ${regNo} अमान्य`,
    html: emailLayout(
      `<p>नमस्कार ${escapeHtml(r.name)},</p>
       <p>दुर्गोत्सव ${EDITION_YEAR_MR} मध्ये सहभाग नोंदविल्याबद्दल धन्यवाद. आपल्या नोंदणीतील छायाचित्राची पडताळणी केली असता ते स्वीकारता आले नाही, त्यामुळे ही नोंदणी अमान्य करण्यात आली आहे.</p>
       <p>नोंदणी क्रमांक: <b>${regNo}</b></p>
       <p style="background:#fdecea;border-left:4px solid #b3261e;padding:12px 16px;border-radius:8px"><b>कारण:</b><br>${escapeHtml(r.review_note).replace(/\n/g, "<br>")}</p>
       ${again}
       <p style="font-size:13px;color:#6b5743">नोंदणीची स्थिती येथे पाहा: <a href="${env.SITE_URL}/certificate?registration=${regNo}">${regNo}</a></p>`,
    ),
  };
}

// Emails the admin's rejection reason to each participant, with a link to register again. Runs after the review
// committed; it never throws, so a mail failure is logged and does not undo the rejection.
export async function emailRejections(ids) {
  try {
    const [{ rows }, window] = await Promise.all([
      query(
        `SELECT id, name, email, review_note FROM registrations
         WHERE id = ANY($1::int[]) AND status = 'rejected' AND email IS NOT NULL AND deleted_at IS NULL`,
        [ids],
      ),
      registrationWindow(),
    ]);
    for (const r of rows) {
      await sendMail(rejectionEmail(r, window))
        .catch((err) => logger.error({ err, registrationId: r.id }, "Rejection email failed"));
    }
  } catch (err) {
    logger.error({ err, ids }, "Rejection emails failed");
  }
}

export async function update(id, fields, allowedDivisionIds) {
  await assertRegistrationScope(id, allowedDivisionIds);
  const { division_id: _ } = await assertReferences(fields);
  const keys = Object.keys(fields);
  if (!keys.length) return adminDetail(id, allowedDivisionIds);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const { rowCount } = await query(`UPDATE registrations SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
  if (!rowCount) throw notFound("Registration not found");
  return adminDetail(id, allowedDivisionIds);
}

export async function setFeatured(photoIds, featured) {
  const { rows } = await query(
    `UPDATE registration_photos p SET is_featured = $2
     FROM registrations r
     WHERE p.id = ANY($1::int[]) AND r.id = p.registration_id AND p.is_current
       AND ($2 = FALSE OR r.status = 'verified')
     RETURNING p.id`,
    [photoIds, featured],
  );
  return rows.map((r) => r.id);
}

export async function softDelete(id, allowedDivisionIds) {
  await assertRegistrationScope(id, allowedDivisionIds);
  const { rowCount } = await query("UPDATE registrations SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (!rowCount) throw notFound("Registration not found");
}

export async function restore(id, allowedDivisionIds) {
  // Restore: check scope against the trashed record (deleted_at IS NOT NULL)
  if (allowedDivisionIds !== null) {
    const { rows } = await query("SELECT division_id FROM registrations WHERE id = $1 AND deleted_at IS NOT NULL", [id]);
    if (!rows[0]) throw notFound("Registration not found in trash");
    if (!allowedDivisionIds.includes(rows[0].division_id)) throw forbidden();
  }
  const { rowCount } = await query("UPDATE registrations SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL", [id]);
  if (!rowCount) throw notFound("Registration not found in trash");
}