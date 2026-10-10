import { query, withTransaction } from "../../db/pool.js";
import { storeParticipantPhoto } from "../../services/image.service.js";
import { badRequest, conflict, notFound, AppError } from "../../utils/errors.js";
import { formatRegistrationNo, parseRegistrationNo } from "../../utils/format.js";
import { paginate, pageMeta } from "../../utils/pagination.js";
import { registrationWindow } from "../settings/settings.service.js";
import * as certificates from "../certificates/certificates.service.js";

// Two dHashes this close (out of 64 bits) are treated as "probably the same photo".
const NEAR_DUPLICATE_BITS = 6;

const SELECT_LIST = `
  SELECT r.id, r.participant_type, r.name, r.organization_name, r.phone, r.email, r.country, r.city,
         r.status, r.review_note, r.reviewed_at, r.created_at, r.deleted_at, r.source,
         r.district_id, d.name_mr AS district, r.fort_id, f.name_mr AS fort,
         p.id AS photo_id, p.thumb_path, p.image_path, p.is_featured, p.duplicate_of_photo_id, p.ai_score,
         c.certificate_no, c.revoked_at AS certificate_revoked_at
  FROM registrations r
  LEFT JOIN districts d ON d.id = r.district_id
  LEFT JOIN forts f ON f.id = r.fort_id
  LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current
  LEFT JOIN certificates c ON c.registration_id = r.id`;

const decorate = (row) => row && { ...row, registration_no: formatRegistrationNo(row.id) };

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

async function assertReferences({ district_id, fort_id }) {
  const [d, f] = await Promise.all([
    district_id ? query("SELECT 1 FROM districts WHERE id = $1", [district_id]) : { rowCount: 1 },
    fort_id ? query("SELECT 1 FROM forts WHERE id = $1 AND deleted_at IS NULL AND is_active", [fort_id]) : { rowCount: 1 },
  ]);
  if (!d.rowCount) throw badRequest("Please select a valid district", { district_id: "Invalid district" });
  if (!f.rowCount) throw badRequest("Please select a valid fort", { fort_id: "Invalid fort" });
}

// ---------------------------------------------------------------- public

export async function register(input, file, meta) {
  const window = await registrationWindow();
  if (!window.open) {
    throw new AppError(403, window.reason === "not_started" ? "Registration has not opened yet" : "Registration is closed", {
      code: "REGISTRATION_CLOSED",
      details: window,
    });
  }
  if (!file) throw badRequest("Please upload a photo of you with your fort replica", { photo: "Photo is required" });
  await assertReferences(input);

  const photo = await storeParticipantPhoto(file);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO registrations (participant_type, name, organization_name, phone, email, country, district_id, city,
                                  fort_id, replica_notes, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, status, created_at`,
      [input.participant_type, input.name, input.organization_name ?? null, input.phone, input.email ?? null,
        input.country || "India", input.country === "India" ? input.district_id : null, input.city ?? null,
        input.fort_id ?? null, input.replica_notes ?? null, meta.ip, meta.userAgent?.slice(0, 300) ?? null],
    );
    const registration = rows[0];
    const duplicateOf = await findDuplicatePhoto(client, photo, registration.id);
    await insertPhoto(client, registration.id, photo, duplicateOf);
    return {
      id: registration.id,
      registration_no: formatRegistrationNo(registration.id),
      status: registration.status,
      created_at: registration.created_at,
    };
  });
}

async function insertPhoto(client, registrationId, photo, duplicateOf) {
  await client.query("UPDATE registration_photos SET is_current = FALSE WHERE registration_id = $1", [registrationId]);
  await client.query(
    `INSERT INTO registration_photos (registration_id, original_path, image_path, thumb_path, width, height,
                                      size_bytes, mime_type, sha256, dhash, duplicate_of_photo_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [registrationId, photo.original_path, photo.image_path, photo.thumb_path, photo.width, photo.height,
      photo.size_bytes, photo.mime_type, photo.sha256, photo.dhash, duplicateOf],
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
    // reviewer notes are shown only where the participant must act on them
    note: ["info_requested", "rejected"].includes(r.status) ? r.review_note : null,
    submitted_at: r.created_at,
    reviewed_at: r.reviewed_at,
    thumb_path: r.thumb_path,
    certificate_available: r.status === "verified" && Boolean(r.certificate_no) && !r.certificate_revoked_at,
    certificate_no: r.certificate_revoked_at ? null : r.certificate_no,
  };
}

// PDF §7.3: Amrut may ask for more information — the participant answers with a new photo/notes.
export async function resubmit(registrationInput, { phone, replica_notes }, file) {
  const r = await findOwned(registrationInput, phone);
  if (r.status !== "info_requested") throw conflict("This registration is not waiting for more information", "NOT_AWAITING_INFO");
  if (!file && !replica_notes) throw badRequest("Please upload a new photo or add a note");
  const photo = file ? await storeParticipantPhoto(file) : null;
  await withTransaction(async (client) => {
    if (photo) await insertPhoto(client, r.id, photo, await findDuplicatePhoto(client, photo, r.id));
    await client.query(
      `UPDATE registrations SET status = 'pending', replica_notes = COALESCE($2, replica_notes) WHERE id = $1`,
      [r.id, replica_notes ?? null],
    );
  });
  return publicStatus(r.id, phone);
}

// ---------------------------------------------------------------- admin

const SORTS = { newest: "r.created_at DESC, r.id DESC", oldest: "r.created_at ASC, r.id ASC", name: "r.name ASC, r.id ASC" };

function buildFilters(f) {
  const where = [f.trashed ? "r.deleted_at IS NOT NULL" : "r.deleted_at IS NULL"];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.status) add("r.status = ?", f.status);
  if (f.district_id) add("r.district_id = ?", f.district_id);
  if (f.fort_id) add("r.fort_id = ?", f.fort_id);
  if (f.participant_type) add("r.participant_type = ?", f.participant_type);
  if (f.from) add("r.created_at >= ?::date", f.from);
  if (f.to) add("r.created_at < (?::date + 1)", f.to);
  if (f.duplicates === true) where.push("p.duplicate_of_photo_id IS NOT NULL");
  if (f.featured !== undefined) add("COALESCE(p.is_featured, FALSE) = ?", f.featured);
  if (f.q) {
    const id = parseRegistrationNo(f.q);
    params.push(`%${f.q}%`);
    const like = `$${params.length}`;
    const idClause = id ? ` OR r.id = ${Number(id)}` : "";
    where.push(`(r.name ILIKE ${like} OR r.phone LIKE ${like} OR r.email ILIKE ${like} OR r.organization_name ILIKE ${like}${idClause})`);
  }
  return { where: `WHERE ${where.join(" AND ")}`, params };
}

export async function adminList(filters) {
  const { where, params } = buildFilters(filters);
  const { limit, offset } = paginate(filters);
  const [{ rows }, count] = await Promise.all([
    query(`${SELECT_LIST} ${where} ORDER BY ${SORTS[filters.sort]} LIMIT ${limit} OFFSET ${offset}`, params),
    query(`SELECT COUNT(*)::int AS total FROM registrations r
           LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current ${where}`, params),
  ]);
  return { data: rows.map(decorate), meta: pageMeta(filters, count.rows[0].total) };
}

export async function adminExportRows(filters) {
  const { where, params } = buildFilters(filters);
  const { rows } = await query(`${SELECT_LIST} ${where} ORDER BY ${SORTS[filters.sort]} LIMIT 50000`, params);
  return rows.map(decorate);
}

export async function adminDetail(id) {
  const { rows } = await query(
    `SELECT r.*, d.name_mr AS district, f.name_mr AS fort, a.name AS reviewed_by_name
     FROM registrations r
     LEFT JOIN districts d ON d.id = r.district_id
     LEFT JOIN forts f ON f.id = r.fort_id
     LEFT JOIN admins a ON a.id = r.reviewed_by
     WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound("Registration not found");
  const [photos, certificate, samePhone, history] = await Promise.all([
    query(
      `SELECT p.id, p.image_path, p.thumb_path, p.width, p.height, p.size_bytes, p.is_current, p.is_featured,
              p.ai_score, p.created_at, p.duplicate_of_photo_id, dp.registration_id AS duplicate_of_registration_id,
              dp.thumb_path AS duplicate_thumb_path
       FROM registration_photos p
       LEFT JOIN registration_photos dp ON dp.id = p.duplicate_of_photo_id
       WHERE p.registration_id = $1 ORDER BY p.is_current DESC, p.id DESC`,
      [id],
    ),
    query("SELECT * FROM certificates WHERE registration_id = $1", [id]),
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
    photos: photos.rows,
    certificate: certificate.rows[0] ?? null,
    same_phone_registrations: samePhone.rows.map(decorate),
    history: history.rows,
  };
}

const ACTION_STATUS = { verify: "verified", reject: "rejected", request_info: "info_requested", reset: "pending" };

// Returns ids that were verified in this call so the caller can send notifications after commit.
export async function review(ids, action, note, adminId) {
  const status = ACTION_STATUS[action];
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE registrations
       SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = NOW()
       WHERE id = ANY($1::int[]) AND deleted_at IS NULL
       RETURNING id`,
      [ids, status, action === "verify" || action === "reset" ? null : note ?? null, adminId],
    );
    const changed = rows.map((r) => r.id);
    if (action === "verify") {
      for (const id of changed) await certificates.issue(client, id, adminId);
    } else {
      // A certificate already issued is revoked when the registration leaves "verified" (PDF §7.7)
      await certificates.revokeForRegistrations(client, changed, adminId, `Registration ${status}${note ? `: ${note}` : ""}`);
      if (action === "reject") {
        await client.query(
          "UPDATE registration_photos SET is_featured = FALSE WHERE registration_id = ANY($1::int[])",
          [changed],
        );
      }
    }
    return changed;
  });
}

export async function update(id, fields) {
  await assertReferences(fields);
  const keys = Object.keys(fields);
  if (!keys.length) return adminDetail(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`); // keys come from the zod schema whitelist
  const { rowCount } = await query(`UPDATE registrations SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
  if (!rowCount) throw notFound("Registration not found");
  return adminDetail(id);
}

export async function setFeatured(photoIds, featured) {
  // Only photos of verified registrations may appear in the public gallery
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

export async function softDelete(id) {
  const { rowCount } = await query("UPDATE registrations SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (!rowCount) throw notFound("Registration not found");
}

export async function restore(id) {
  const { rowCount } = await query("UPDATE registrations SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL", [id]);
  if (!rowCount) throw notFound("Registration not found in trash");
}
