import { env } from "../../config/env.js";
import { query, withTransaction } from "../../db/pool.js";
import { prepareParticipantPhoto, removeFiles, writeLocalOriginal, writePublicCopies } from "../../services/image.service.js";
import { istDateFolder, participantFolderName, photoObjectKey } from "../../services/participant-photo-keys.js";
import { deleteObject, ObjectExistsError, presignGetUrl, putObjectIfAbsent } from "../../services/s3.service.js";
import { logger } from "../../utils/logger.js";
import { badRequest, conflict, forbidden, notFound, AppError } from "../../utils/errors.js";
import { formatRegistrationNo, latinDigits, likeContains, likePrefix, parseRegistrationNo } from "../../utils/format.js";
import { assertBrowsable, cappedCount, cappedMeta, COUNT_CAP, paginate, sortSql } from "../../utils/pagination.js";
import { registrationWindow } from "../settings/settings.service.js";
import * as certificates from "../certificates/certificates.service.js";
import { certificateLink, certificateToken } from "../certificates/certificate.links.js";
import * as sms from "../sms/sms.queue.js";
import { clearGalleryCache, setWebsiteGalleryDisplay } from "../gallery/gallery.service.js";
import { enqueueRejectionEmails } from "./rejection-emails.js";

const NEAR_DUPLICATE_BITS = 6;
// Upper bound on the photos compared exactly per near-duplicate check (see findDuplicatePhoto)
const NEAR_DUPLICATE_CANDIDATES = 20_000;

const PHOTO_JOIN = "LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1";
// Only the duplicates / featured filters read the main photo; without them counts and neighbour lookups skip that join
const needsPhoto = (f) => f.duplicates === true || f.featured !== undefined;

const SELECT_LIST = `
  SELECT r.id, r.participant_type, r.name, r.organization_name, r.members_count, r.phone, r.whatsapp_number, r.email, r.country, r.city,
         r.status, r.review_note, r.reviewed_at, r.created_at, r.deleted_at, r.source, r.replica_notes,
         r.district_id, d.name_mr AS district, r.division_id, dv.name_mr AS division,
         r.taluka_id, t.name_mr AS taluka,
         r.fort_id, f.name_mr AS fort,
         p.id AS photo_id, p.thumb_path, p.image_path, p.is_featured, p.duplicate_of_photo_id, p.ai_score,
         c.certificate_no, c.durgveer_no, c.revoked_at AS certificate_revoked_at
  FROM registrations r
  LEFT JOIN districts d  ON d.id  = r.district_id
  LEFT JOIN divisions dv ON dv.id = r.division_id
  LEFT JOIN talukas t    ON t.id  = r.taluka_id
  LEFT JOIN forts f      ON f.id  = r.fort_id
  ${PHOTO_JOIN}
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
  // One division (the usual moderator) is an equality, so (division_id, status, created_at, id) reads its queue in order
  params.push(allowedDivisionIds.length === 1 ? allowedDivisionIds[0] : allowedDivisionIds);
  where.push(allowedDivisionIds.length === 1 ? `r.division_id = $${params.length}` : `r.division_id = ANY($${params.length}::int[])`);
}

// Throws 403 if the registration's division is outside the allowed scope.
export async function assertRegistrationScope(registrationId, allowedDivisionIds) {
  if (allowedDivisionIds === null) return;  // unrestricted
  const { rows } = await query("SELECT division_id FROM registrations WHERE id = $1", [registrationId]);
  if (!rows[0]) throw notFound("Registration not found");
  if (!allowedDivisionIds.includes(rows[0].division_id)) throw forbidden();
}

// ---------------------------------------------------------------- duplicate-photo helpers

// Probe keys for the near-duplicate search (migration 036, multi-index hashing): for each 16-bit band of the hash, the
// band itself and its 16 one-bit variants, as dhash_band_keys() indexes them (band i → i·65536 + value).
// A photo within NEAR_DUPLICATE_BITS (≤ 7) of `hex` shares at least one of these 68 keys.
export function dhashProbeKeys(hex) {
  const keys = [];
  for (let band = 0; band < 4; band++) {
    const value = parseInt(hex.slice(band * 4, band * 4 + 4), 16);
    keys.push(band * 65536 + value);
    for (let bit = 0; bit < 16; bit++) keys.push(band * 65536 + (value ^ (1 << bit)));
  }
  return keys;
}

/**
 * An earlier photo of another live registration that is the same file (sha256) or a near copy (dHash within
 * NEAR_DUPLICATE_BITS). Both lookups go through indexes, so the cost does not grow with the number of photos, and both
 * run on the pool before the registration's transaction opens. The near-copy candidates (photos sharing a band key) are
 * collected first — MATERIALIZED, so the planner cannot instead walk the table in id order hoping to meet a match — and
 * compared exactly afterwards. A band value that a great many photos share (flat sky, a plain wall) could make that set
 * large, so at most NEAR_DUPLICATE_CANDIDATES are compared; exact copies are always found, and an admin reviews every photo.
 */
async function findDuplicatePhoto(photo, registrationId) {
  const exact = await query(
    `SELECT p.id FROM registration_photos p
     JOIN registrations r ON r.id = p.registration_id AND r.deleted_at IS NULL
     WHERE p.sha256 = $1 AND p.registration_id <> $2
     ORDER BY p.id LIMIT 1`,
    [photo.sha256, registrationId],
  );
  if (exact.rows[0]) return exact.rows[0].id;
  const near = await query(
    `WITH candidates AS MATERIALIZED (
       SELECT p.id, p.registration_id, p.dhash FROM registration_photos p
       WHERE dhash_band_keys(p.dhash) && $1::int[] AND p.registration_id <> $3
       LIMIT ${NEAR_DUPLICATE_CANDIDATES})
     SELECT c.id FROM candidates c
     JOIN registrations r ON r.id = c.registration_id AND r.deleted_at IS NULL
     WHERE bit_count(('x' || c.dhash)::bit(64) # ('x' || $2)::bit(64)) <= $4
     ORDER BY c.id LIMIT 1`,
    [dhashProbeKeys(photo.dhash), photo.dhash, registrationId, NEAR_DUPLICATE_BITS],
  );
  return near.rows[0]?.id ?? null;
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

// Photos are stored before the registration's transaction opens (no connection or lock is held while a disk or S3
// write is slow). An original's number continues after the highest one in its S3 folder and in its registration — two
// index lookups — and IfNoneMatch never lets two uploads take the same key: on a clash the next number is tried.
// `after`: a number already used by this request (the first photo, while the second is stored).
async function uploadOriginalToS3(registration, prepared, after = 0) {
  const dateFolder = istDateFolder();
  const folder = participantFolderName(registration.name, registration.phone);
  const { rows } = await query(
    `SELECT GREATEST(
       (SELECT MAX(photo_no) FROM registration_photos WHERE storage_key LIKE $1),
       (SELECT MAX(photo_no) FROM registration_photos WHERE registration_id = $2), $3, 0)::int AS n`,
    [likePrefix(`${dateFolder}/${folder}/`), registration.id, after],
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

async function savePhoto(registration, prepared, written, after = 0) {
  const copies = await writePublicCopies(prepared);
  written.files.push(...copies.files);
  let original;
  if (env.PARTICIPANT_IMAGE_STORAGE === "s3") {
    original = await uploadOriginalToS3(registration, prepared, after);
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
  return {
    id: rows[0].id,
    registration_no: formatRegistrationNo(rows[0].id),
    status: rows[0].status,
    created_at: rows[0].created_at,
    token: certificateToken(rows[0].id),
    replayed: true,
  };
}

// ---------------------------------------------------------------- public

/**
 * files: [main photo, optional second photo]
 * The CAPTCHA was checked by the route. The registration waits (status pending) for an admin to check its photo and
 * details; its certificate is generated only on approval. Any number of registrations may use one mobile number.
 * Returned token: the participant's own status / certificate link (/c/<token>), also sent by SMS.
 */
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
  if (!file) throw badRequest("Please upload a photo of you with your fort replica", { photo: "Photo is required" });
  const { division_id } = await assertReferences(input);

  const prepared = await prepareParticipantPhoto(file);
  const prepared2 = file2 ? await prepareParticipantPhoto(file2) : null;
  if (prepared2 && prepared2.sha256 === prepared.sha256) {
    throw badRequest("Please choose two different photos", { photo_2: "Same as the first photo" });
  }
  // The registration number comes first (the photos' S3 metadata carries it); the photos are then stored and checked
  // for duplicates with no transaction open, and the transaction only inserts rows — it never waits on a disk or S3.
  // A number taken by a submission that fails is skipped, as after any rolled-back insert.
  const { rows: next } = await query("SELECT nextval('registrations_id_seq')::int AS id");
  const owner = { id: next[0].id, name: input.name, phone: input.phone };
  const written = newWritten();
  try {
    const photos = [];
    for (const [index, p] of [prepared, prepared2].entries()) {
      if (!p) continue;
      const photo = await savePhoto(owner, p, written, photos[0]?.photo.photo_no ?? 0);
      photos.push({ photo, position: index + 1, duplicateOf: await findDuplicatePhoto(photo, owner.id) });
    }
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO registrations
           (id, participant_type, name, organization_name, phone, email, country,
            district_id, division_id, taluka_id, city, fort_id, replica_notes,
            ip_address, user_agent, submission_id, members_count, whatsapp_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id, status, created_at`,
        [owner.id, input.participant_type ?? null, input.name, input.organization_name ?? null, input.phone,
          input.email ?? null, input.country || "India",
          input.country === "India" ? input.district_id : null,
          input.country === "India" ? (division_id ?? null) : null,
          input.country === "India" ? (input.taluka_id ?? null) : null,
          input.city ?? null, input.fort_id ?? null, input.replica_notes ?? null,
          meta.ip, meta.userAgent?.slice(0, 300) ?? null, input.submission_id ?? null,
          input.participant_type && input.participant_type !== "individual" ? (input.members_count ?? null) : null,
          input.whatsapp_number ?? null],
      );
      const registration = rows[0];
      // A new registration has no earlier photo to retire
      for (const { photo, position, duplicateOf } of photos) {
        await insertPhoto(client, registration.id, photo, duplicateOf, position, { retire: false });
      }
      // The acknowledgment SMS commits with the registration; the SMS worker sends it
      await sms.enqueue(client, "registration_ack", [{ id: registration.id, phone: input.phone }]);
      return {
        id: registration.id,
        registration_no: formatRegistrationNo(registration.id),
        status: registration.status,
        created_at: registration.created_at,
        token: certificateToken(registration.id),
      };
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
// "AND is_current" lets the unique current-slot index find that one row.
async function insertPhoto(client, registrationId, photo, duplicateOf, position = 1, { retire = true } = {}) {
  if (retire) {
    await client.query(
      "UPDATE registration_photos SET is_current = FALSE WHERE registration_id = $1 AND position = $2 AND is_current",
      [registrationId, position],
    );
  }
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
  const available = certificates.CERTIFIED_STATUSES.includes(r.status) && Boolean(r.certificate_no) && !r.certificate_revoked_at;
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
    certificate_available: available,
    certificate_no: available ? r.certificate_no : null,
    durgveer_no: available ? r.durgveer_no : null,
    token: certificateToken(r.id),
  };
}

export async function resubmit(registrationInput, { phone, replica_notes }, file) {
  const r = await findOwned(registrationInput, phone);
  if (r.status !== "info_requested") throw conflict("This registration is not waiting for more information", "NOT_AWAITING_INFO");
  if (!file && !replica_notes) throw badRequest("Please upload a new photo or add a note");
  const prepared = file ? await prepareParticipantPhoto(file) : null;
  const written = newWritten();
  try {
    // Stored and checked before the transaction, like a new registration's photo
    const photo = prepared ? await savePhoto({ id: r.id, name: r.name, phone: r.phone }, prepared, written) : null;
    const duplicateOf = photo ? await findDuplicatePhoto(photo, r.id) : null;
    await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        "SELECT 1 FROM registrations WHERE id = $1 AND status = 'info_requested' FOR UPDATE", [r.id]);
      if (!rowCount) throw conflict("This registration is not waiting for more information", "NOT_AWAITING_INFO");
      if (photo) await insertPhoto(client, r.id, photo, duplicateOf);
      // Back in the review queue; a certificate comes only with the next approval
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
  if (f.from)             add("r.created_at >= ?::date", f.from);
  if (f.to)               add("r.created_at < (?::date + 1)", f.to);
  if (f.duplicates === true) where.push("p.duplicate_of_photo_id IS NOT NULL");
  if (f.featured === true) where.push("p.is_featured");
  if (f.featured === false) where.push("p.is_featured IS NOT TRUE");
  if (f.q) {
    // Every branch must be index-backed or the whole OR becomes a scan of every registration: a number searches the
    // registration number, mobile and WhatsApp (trigram indexes, migration 036); text searches name, email and
    // organisation (trigram indexes, migration 006). Contains-search needs 3 characters (a trigram); shorter numbers
    // only match a registration number.
    const q = latinDigits(f.q);
    const id = parseRegistrationNo(q);
    const idClause = id ? `r.id = ${Number(id)}` : null;
    const numeric = /^\d+$/.test(q);
    if (q.length < 3) {
      where.push(idClause ?? "FALSE");
    } else {
      params.push(likeContains(q));
      const like = `$${params.length}`;
      const branches = numeric
        ? [`r.phone LIKE ${like}`, `r.whatsapp_number LIKE ${like}`]
        : [`r.name ILIKE ${like}`, `r.email ILIKE ${like}`, `r.organization_name ILIKE ${like}`];
      where.push(`(${[...branches, idClause].filter(Boolean).join(" OR ")})`);
    }
  }
  // Division scope — always applied last; overrides any explicit division_id filter
  addDivisionScope(where, params, allowedDivisionIds);
  return { where: `WHERE ${where.join(" AND ")}`, params, search: Boolean(f.q) && latinDigits(f.q).length >= 3 };
}

// FROM … WHERE … of a list with these filters, for counting (the main-photo join only when a filter reads it)
const countFrom = (f, where) => `FROM registrations r ${needsPhoto(f) ? PHOTO_JOIN : ""} ${where}`;

/**
 * One page of the admin list, and how many records match (counting stops at COUNT_CAP; pages past it are not browsed).
 * A search is counted first: a narrow one (under the cap) is collected through the trigram indexes and only those rows
 * are sorted — the OFFSET 0 fence keeps the planner from instead walking the whole sort index hoping to meet matches.
 * A broad one has matches so dense that walking the sort index finds a page at once.
 */
export async function adminList(filters, allowedDivisionIds) {
  assertBrowsable(filters, "registrations");
  const { where, params, search } = buildFilters(filters, allowedDivisionIds);
  const { limit, offset } = paginate(filters);
  const order = `ORDER BY ${sortSql(SORTS, sortOf(filters), "created_at")} LIMIT ${limit} OFFSET ${offset}`;
  let rows;
  let count;
  if (search) {
    count = await cappedCount(query, countFrom(filters, where), params);
    const fenced = count.capped ? where : `WHERE r.id IN (SELECT r.id ${countFrom(filters, where)} OFFSET 0)`;
    ({ rows } = await query(`${SELECT_LIST} ${fenced} ${order}`, params));
  } else {
    [{ rows }, count] = await Promise.all([
      query(`${SELECT_LIST} ${where} ${order}`, params),
      cappedCount(query, countFrom(filters, where), params),
    ]);
  }
  return { data: rows.map(decorate), meta: cappedMeta(filters, count) };
}

/**
 * Previous / next record around `id` in an admin list (the review queue) with the same filters, sort and division
 * scope, plus the record's position. It works from the record's own sort key, so it also answers for a record that
 * has just left the list (reviewed): next is then the record that followed it. The sort key is read inside SQL,
 * keeping created_at's microseconds. prev / next are index lookups; the position and total are counted up to
 * COUNT_CAP (capped: "1 of 10,000+"; past the cap the position is unknown).
 */
export async function neighbors(id, filters, allowedDivisionIds) {
  const { rows: own } = await query("SELECT division_id FROM registrations WHERE id = $1", [id]);
  if (!own[0]) throw notFound("Registration not found");
  if (allowedDivisionIds !== null && !allowedDivisionIds.includes(own[0].division_id)) throw forbidden();

  const { where, params } = buildFilters(filters, allowedDivisionIds);
  const s = sortOf(filters);
  const { cols, dir } = SORTS[s.sort] ?? SORTS.created_at;
  const desc = (s.dir ?? dir) === "desc";
  params.push(id);
  const idParam = `$${params.length}`;
  const cursor = `(SELECT ${cols.replaceAll("r.", "c.")} FROM registrations c WHERE c.id = ${idParam})`;
  const order = (descending) => cols.split(", ").map((c) => `${c} ${descending ? "DESC" : "ASC"}`).join(", ");
  const from = countFrom(filters, where);
  const capped = (sql) => `(SELECT COUNT(*)::int FROM (SELECT 1 ${sql} LIMIT ${COUNT_CAP + 1}) s)`;
  const [next, prev, counts] = await Promise.all([
    query(`SELECT r.id ${from} AND (${cols}) ${desc ? "<" : ">"} ${cursor} ORDER BY ${order(desc)} LIMIT 1`, params),
    query(`SELECT r.id ${from} AND (${cols}) ${desc ? ">" : "<"} ${cursor} ORDER BY ${order(!desc)} LIMIT 1`, params),
    query(
      `SELECT EXISTS (SELECT 1 ${from} AND r.id = ${idParam}) AS in_list,
              ${capped(`${from} AND (${cols}) ${desc ? ">" : "<"} ${cursor}`)} AS before,
              ${capped(from)} AS total`,
      params,
    ),
  ]);
  const { in_list: inList, before, total } = counts.rows[0];
  return {
    id,
    prev_id: prev.rows[0]?.id ?? null,
    next_id: next.rows[0]?.id ?? null,
    // null when the record is no longer in the list (just reviewed, or changed by another admin), or lies past the cap
    position: inList && before < COUNT_CAP ? before + 1 : null,
    total: Math.min(total, COUNT_CAP),
    capped: total > COUNT_CAP,
  };
}

const EXPORT_BATCH = 1000;

/**
 * Every matching registration in list order, in batches. Each batch is its own short query that continues after the
 * last row of the one before (keyset on the sort columns, read from that row inside SQL), so a slow download holds no
 * connection, transaction or snapshot between batches, however long the file.
 */
export async function* adminExportStream(filters, allowedDivisionIds) {
  const { where, params } = buildFilters(filters, allowedDivisionIds);
  const s = sortOf(filters);
  const { cols, dir } = SORTS[s.sort] ?? SORTS.created_at;
  const desc = (s.dir ?? dir) === "desc";
  const order = sortSql(SORTS, s, "created_at");
  const after = `AND (${cols}) ${desc ? "<" : ">"} (SELECT ${cols.replaceAll("r.", "c.")} FROM registrations c WHERE c.id = $${params.length + 1})`;
  let last = null;
  for (;;) {
    const { rows } = await query(
      `${SELECT_LIST} ${where} ${last === null ? "" : after} ORDER BY ${order} LIMIT ${EXPORT_BATCH}`,
      last === null ? params : [...params, last],
    );
    if (rows.length) yield rows.map(decorate);
    if (rows.length < EXPORT_BATCH) return;
    last = rows[rows.length - 1].id;
  }
}

// Other registrations of the same mobile number shown in the detail view (the rest are counted, up to SAME_PHONE_COUNTED)
const SAME_PHONE_SHOWN = 20;
const SAME_PHONE_COUNTED = 1000;

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
  const [photos, certificate, samePhone, samePhoneCount, history, smsRows] = await Promise.all([
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
    // One number may hold any number of registrations: the newest few, and how many there are (index (phone, id))
    query(
      `SELECT id, name, status, created_at FROM registrations
       WHERE phone = $1 AND id <> $2 AND deleted_at IS NULL ORDER BY id DESC LIMIT ${SAME_PHONE_SHOWN}`,
      [rows[0].phone, id],
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM registrations
       WHERE phone = $1 AND id <> $2 AND deleted_at IS NULL LIMIT ${SAME_PHONE_COUNTED + 1}) s`,
      [rows[0].phone, id],
    ),
    query(
      `SELECT l.action, l.meta, l.created_at, a.name AS admin_name FROM audit_logs l
       LEFT JOIN admins a ON a.id = l.admin_id
       WHERE l.entity = 'registration' AND l.entity_id = $1 ORDER BY l.id DESC LIMIT 50`,
      [String(id)],
    ),
    sms.smsHistory(id),
  ]);
  const cert = certificate.rows[0] ?? null;
  return {
    ...decorate(rows[0]),
    photos: await Promise.all(photos.rows.map((p) => withOriginalUrl({
      ...p,
      duplicate_of_registration_no: p.duplicate_of_registration_id ? formatRegistrationNo(p.duplicate_of_registration_id) : null,
    }))),
    certificate: cert,
    // the participant's own page (what the SMS sends): status now, certificate once approved
    participant_link: rows[0].deleted_at ? null : certificateLink(id),
    same_phone_registrations: samePhone.rows.map(decorate),
    same_phone_total: Math.min(samePhoneCount.rows[0].n, SAME_PHONE_COUNTED),
    same_phone_capped: samePhoneCount.rows[0].n > SAME_PHONE_COUNTED,
    history: history.rows,
    sms: smsRows,
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
  const reviewed = await withTransaction(async (client) => {
    // Lock in id order, so overlapping bulk reviews by two admins wait for each other instead of deadlocking.
    // The locked rows' current status tells which approvals are new.
    const { rows: before } = await client.query(
      "SELECT id, status, review_note FROM registrations WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids]);
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
       RETURNING id, phone`,
      [ids, status, action === "verify" || action === "reset" ? null : note ?? (action === "mark_duplicate" ? DUPLICATE_NOTE : null), adminId],
    );
    const changed = rows.map((r) => r.id);
    if (certificates.CERTIFIED_STATUSES.includes(status)) {
      // Approval generates the certificate (the next दुर्गवीर number; one revoked earlier is reinstated with its number)
      // and queues its email and SMS in this same transaction. The background workers render, email and text it.
      await certificates.issueBatch(client, changed, adminId);
      await certificates.queueEmails(client, changed, adminId); // never twice for one certificate
      const wasVerified = new Set(before.filter((r) => r.status === "verified").map((r) => r.id));
      await sms.enqueue(client, "certificate_link", rows.filter((r) => !wasVerified.has(r.id)));
    } else {
      // Pending, rejected, duplicate, info requested: no valid certificate, and nothing about one may still go out
      await certificates.revokeForRegistrations(client, changed, adminId, `Registration ${status}${note ? `: ${note}` : ""}`);
      await sms.cancelQueued(client, changed);
      if (action === "reject" || action === "mark_duplicate") {
        // Only rows that change (a featured photo): no needless row versions for the rest of the photo history
        await client.query(
          "UPDATE registration_photos SET is_featured = FALSE WHERE registration_id = ANY($1::int[]) AND is_featured",
          [changed],
        );
      }
      if (action === "reject") {
        // The participant is told why, with a link to register again: queued with the rejection, sent by the worker.
        // Rejecting again sends a new notice only when the reason changed.
        const earlier = new Map(before.map((r) => [r.id, r]));
        const told = (id) => earlier.get(id)?.status === "rejected" && earlier.get(id)?.review_note === (note ?? null);
        await enqueueRejectionEmails(client, changed.filter((id) => !told(id)), adminId);
      }
    }
    return changed;
  });
  // A photo may have joined or left the public gallery (approval, rejection): its cached counts are re-read
  clearGalleryCache();
  return reviewed;
}

export async function update(id, fields, allowedDivisionIds) {
  await assertRegistrationScope(id, allowedDivisionIds);
  const { division_id } = await assertReferences(fields);
  const values = { ...fields };
  if ("district_id" in fields) {
    // The division follows the district: it decides which moderators see the registration (division scope)
    if (allowedDivisionIds !== null && !allowedDivisionIds.includes(division_id)) {
      throw forbidden("That district belongs to a division outside your access");
    }
    values.division_id = division_id;
  }
  const keys = Object.keys(values);
  if (!keys.length) return adminDetail(id, allowedDivisionIds);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  // A taluka belongs to the old district; it is cleared when the district really changes
  if ("district_id" in fields) sets.push(`taluka_id = CASE WHEN district_id IS DISTINCT FROM $${keys.indexOf("district_id") + 2} THEN NULL ELSE taluka_id END`);
  const { rowCount } = await query(`UPDATE registrations SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => values[k])]);
  if (!rowCount) throw notFound("Registration not found");
  // The gallery is filtered by district and fort
  if ("district_id" in fields || "fort_id" in fields) clearGalleryCache();
  return adminDetail(id, allowedDivisionIds);
}

// Shows / hides photos in the public gallery (the drawer's star): the same rules and locking as the Website Gallery
// page — only a live, approved registration's photo can be shown, and a scoped moderator changes only their divisions'.
export const setFeatured = (photoIds, featured, allowedDivisionIds = null) =>
  setWebsiteGalleryDisplay(photoIds, featured, allowedDivisionIds);

export async function softDelete(id, allowedDivisionIds) {
  await assertRegistrationScope(id, allowedDivisionIds);
  const { rowCount } = await query("UPDATE registrations SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (!rowCount) throw notFound("Registration not found");
  clearGalleryCache();
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
  clearGalleryCache();
}
