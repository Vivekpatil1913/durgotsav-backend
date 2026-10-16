import { env } from "../../config/env.js";
import { pool, query, withTransaction } from "../../db/pool.js";
import { AppError, badRequest, conflict, notFound } from "../../utils/errors.js";
import { paginate, pageMeta } from "../../utils/pagination.js";
import { STATUSES, TRANSITIONS, publicOptions } from "./award.constants.js";
import { acceptedExtensions, storeDocument, undoStored } from "./award.storage.js";

// ---------------------------------------------------------------- editions & window

const EDITION_PUBLIC = `id, year, title, title_en, tagline, tagline_en, nominations_enabled, nomination_opens_at,
  nomination_closes_at, scrutiny_starts_on, scrutiny_ends_on, closed_note, closed_note_en, prize_individual, prize_individual_en,
  prize_organization, prize_organization_en, content, content_en, max_upload_mb, max_documents, allow_video`;

export async function currentEdition() {
  const { rows } = await query("SELECT * FROM award_editions WHERE is_current LIMIT 1");
  if (!rows[0]) throw notFound("No award edition is configured");
  return rows[0];
}

async function editionFor(editionId) {
  if (!editionId) return currentEdition();
  const { rows } = await query("SELECT * FROM award_editions WHERE id = $1", [editionId]);
  if (!rows[0]) throw notFound("Award edition not found");
  return rows[0];
}

// { open, reason: 'open'|'not_started'|'closed'|'disabled', opensAt, closesAt }
export function nominationWindow(edition, now = new Date()) {
  const base = { opensAt: edition.nomination_opens_at, closesAt: edition.nomination_closes_at, forcedOpen: env.AWARD_FORCE_OPEN };
  if (env.AWARD_FORCE_OPEN) return { ...base, open: true, reason: "open" };
  if (!edition.nominations_enabled) return { ...base, open: false, reason: "disabled" };
  if (now < new Date(edition.nomination_opens_at)) return { ...base, open: false, reason: "not_started" };
  if (now > new Date(edition.nomination_closes_at)) return { ...base, open: false, reason: "closed" };
  return { ...base, open: true, reason: "open" };
}

export async function publicInfo() {
  const { rows } = await query(`SELECT ${EDITION_PUBLIC} FROM award_editions WHERE is_current LIMIT 1`);
  const edition = rows[0];
  if (!edition) throw notFound("No award edition is configured");
  const [committee, winners] = await Promise.all([
    query(`SELECT id, name, name_en, designation, designation_en FROM award_committee_members
           WHERE edition_id = $1 AND is_active AND deleted_at IS NULL ORDER BY sort_order, id`, [edition.id]),
    query(`SELECT id, year, category, name, name_en, description, description_en, photo FROM award_winners
           WHERE is_active AND deleted_at IS NULL ORDER BY year DESC NULLS LAST, sort_order, id`),
  ]);
  return {
    edition,
    status: nominationWindow(edition),
    committee: committee.rows,
    winners: winners.rows,
    options: publicOptions(),
    uploads: { extensions: acceptedExtensions(edition), max_mb: edition.max_upload_mb, max_files: edition.max_documents },
  };
}

// ---------------------------------------------------------------- submission

const insertRows = async (client, table, nominationId, cols, rows) => {
  for (const [i, row] of rows.entries()) {
    const values = cols.map((c) => row[c] ?? null);
    await client.query(
      `INSERT INTO ${table} (nomination_id, sort_order, ${cols.join(", ")})
       VALUES ($1, $2, ${cols.map((_, j) => `$${j + 3}`).join(", ")})`,
      [nominationId, i, ...values],
    );
  }
};

const referenceNo = (prefix, category, id) => `${prefix}-${category === "organization" ? "O" : "I"}-${String(id).padStart(6, "0")}`;

async function findBySubmission(submissionId) {
  const { rows } = await query(
    `SELECT n.id, n.reference_no, n.category, n.nominee_name, n.submitted_at, nm.mobile AS nominator_mobile
     FROM award_nominations n JOIN award_nominators nm ON nm.id = n.nominator_id WHERE n.submission_id = $1`,
    [submissionId],
  );
  return rows[0] ?? null;
}

const receipt = (row) => ({
  reference_no: row.reference_no, category: row.category, nominee_name: row.nominee_name, submitted_at: row.submitted_at,
});

/**
 * Saves a complete nomination in one transaction. `files` is the Map from inspectUploads().
 * A retried request with the same submission_id returns the stored receipt instead of a second record.
 */
export async function submitNomination(v, files, edition, meta) {
  const existing = await findBySubmission(v.submission_id);
  if (existing) {
    if (existing.nominator_mobile !== v.nominator_mobile) throw conflict("Invalid submission");
    return { replayed: true, ...receipt(existing) };
  }

  const window = nominationWindow(edition);
  if (!window.open) {
    throw new AppError(403, window.reason === "not_started"
      ? "नामनिर्देशन अद्याप सुरू झालेले नाही."
      : "नामनिर्देशनाची मुदत संपली आहे / नामनिर्देशन सध्या बंद आहे.", { code: "NOMINATIONS_CLOSED" });
  }

  const { rowCount } = await query(
    "SELECT 1 FROM talukas t JOIN districts d ON d.id = t.district_id WHERE t.id = $1 AND d.id = $2 AND t.deleted_at IS NULL AND d.deleted_at IS NULL",
    [v.taluka_id, v.district_id],
  );
  if (!rowCount) throw badRequest("Please select a valid district and taluka", { taluka_id: "जिल्हा व तालुका निवडा" });

  // Every uploaded file must belong to exactly one evidence entry, and vice versa
  const referenced = new Set(v.documents.map((d) => d.file_field).filter(Boolean));
  for (const field of referenced) if (!files.has(field)) throw badRequest("A selected file did not arrive. Please attach it again.", { [field]: "File missing" });
  for (const field of files.keys()) if (!referenced.has(field)) throw badRequest("Invalid upload", { [field]: "Unexpected file" });
  if (v.documents.length > edition.max_documents) {
    throw badRequest(`जास्तीत जास्त ${edition.max_documents} पुरावे जोडता येतात`, { documents: "Too many entries" });
  }

  const written = [];
  try {
    const saved = await withTransaction(async (client) => {
      const nominator = await client.query(
        "INSERT INTO award_nominators (full_name, mobile) VALUES ($1, $2) RETURNING id", [v.nominator_name, v.nominator_mobile]);
      const workOther = v.work_categories.includes("other") ? v.work_category_other : null;
      const ins = await client.query(
        `INSERT INTO award_nominations (
           edition_id, nominator_id, category, submission_id, nominee_name, mobile, email, address, district_id, taluka_id,
           work_started_year, work_categories, work_category_other,
           declaration_place, declaration_date, declaration_name, declaration_accepted_at, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),$17,$18)
         ON CONFLICT (submission_id) DO NOTHING
         RETURNING id, submitted_at`,
        [edition.id, nominator.rows[0].id, v.category, v.submission_id, v.nominee_name, v.mobile, v.email, v.address,
          v.district_id, v.taluka_id, v.work_started_year, v.work_categories, workOther,
          v.declaration_place, v.declaration_date, v.declaration_name, meta.ip ?? null, meta.userAgent?.slice(0, 400) ?? null],
      );
      // A concurrent duplicate request won the race: roll this one back and return its receipt
      if (!ins.rows[0]) throw Object.assign(new Error("replay"), { replay: true });
      const { id, submitted_at } = ins.rows[0];
      const reference = referenceNo(edition.reference_prefix, v.category, id);
      await client.query("UPDATE award_nominations SET reference_no = $2 WHERE id = $1", [id, reference]);
      await client.query(
        "INSERT INTO award_nomination_status_history (nomination_id, from_status, to_status, remarks, ip_address) VALUES ($1, NULL, 'submitted', $2, $3)",
        [id, "Submitted online", meta.ip ?? null],
      );

      if (v.category === "individual") {
        await client.query(
          `INSERT INTO award_individual_nominees
             (nomination_id, full_name, father_or_husband_name, date_of_birth, conservation_work, lectures_awareness, external_references)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, v.nominee_name, v.father_or_husband_name, v.date_of_birth, v.conservation_work, v.lectures_awareness ?? null, v.external_references ?? null],
        );
      } else {
        await client.query(
          `INSERT INTO award_organization_nominees
             (nomination_id, org_type, org_type_other, established_on, established_year, registration_no, registration_date,
              registration_authority, pan, website, pincode, conservation_details, research_documentation, research_tools,
              youth_participation, volunteer_count, media_publicity, distinctive_features)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [id, v.org_type, v.org_type === "other" ? v.org_type_other : null, v.established_on ?? null,
            v.established_year ?? Number(v.established_on.slice(0, 4)), v.registration_no ?? null, v.registration_date ?? null,
            v.registration_authority ?? null, v.pan ?? null, v.website_url ?? null, v.pincode, v.conservation_details,
            v.research_documentation ?? null, [...new Set(v.research_tools)], v.youth_participation ?? null,
            v.volunteer_count ?? null, v.media_publicity ?? null, v.distinctive_features],
        );
        await insertRows(client, "award_nomination_officials", id, ["name", "designation", "email", "mobile", "address"], v.officials);
      }

      await insertRows(client, "award_nomination_activities", id, ["title", "fort_name", "work_type", "period", "details", "beneficiaries"], v.activities);
      await insertRows(client, "award_nomination_publications", id, ["title", "pub_type", "publisher", "year", "details"], v.publications);
      await insertRows(client, "award_nomination_honours", id, ["title", "awarded_by", "year", "details"], v.honours);

      for (const [i, d] of v.documents.entries()) {
        const file = d.file_field ? files.get(d.file_field) : null;
        const stored = file ? await storeDocument(file, { year: edition.year, reference }, written) : null;
        await client.query(
          `INSERT INTO award_nomination_documents
             (nomination_id, sort_order, title, doc_type, description, external_url, storage, storage_key, original_name, mime_type, size_bytes, sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, i, d.title ?? null, d.doc_type ?? null, d.description ?? null, d.external_url ?? null,
            stored?.storage ?? null, stored?.storage_key ?? null, file?.originalName ?? null, file?.mime ?? null, file?.size ?? null, file?.sha256 ?? null],
        );
      }
      return { replayed: false, reference_no: reference, category: v.category, nominee_name: v.nominee_name, submitted_at };
    });
    clearStatsCache();
    return saved;
  } catch (err) {
    await undoStored(written);
    if (err.replay) {
      const row = await findBySubmission(v.submission_id);
      if (row) return { replayed: true, ...receipt(row) };
    }
    throw err;
  }
}

// Applicant-side confirmation: reference + the nominator's (or nominee's) mobile. Review stages stay internal.
export async function publicLookup(reference, mobile) {
  const { rows } = await query(
    `SELECT n.reference_no, n.category, n.nominee_name, n.status, n.submitted_at, e.title AS award_title
     FROM award_nominations n
     JOIN award_nominators nm ON nm.id = n.nominator_id
     JOIN award_editions e ON e.id = n.edition_id
     WHERE upper(n.reference_no) = upper($1) AND (nm.mobile = $2 OR n.mobile = $2)`,
    [reference.trim(), mobile],
  );
  if (!rows[0]) throw notFound("No nomination matches this reference number and mobile number");
  const { status, ...rest } = rows[0];
  return { ...rest, status: status === "submitted" ? "submitted" : "under_review" };
}

// ---------------------------------------------------------------- admin: list / stats / detail

// Each sort matches an index from migration 017; tie-breaks run in the same direction so the index scans backwards too
const SORTS = {
  submitted_at: (d) => `n.submitted_at ${d}, n.id ${d}`,
  nominee_name: (d) => `n.nominee_name ${d}, n.id ${d}`,
  reference_no: (d) => `n.id ${d}`,
  status: (d) => `n.status ${d}, n.submitted_at DESC, n.id DESC`,
  district: (d) => `d.name_mr ${d}, n.id ${d}`,
};
const orderBy = (f) => SORTS[f.sort](f.dir === "asc" ? "ASC" : "DESC");

// Trigram indexes need at least 3 characters; shorter search text is ignored instead of scanning every row
export const MIN_SEARCH = 3;

// Every condition is on award_nominations alone, so the count can skip the joins
function buildFilters(f, editionId) {
  const where = ["n.edition_id = $1"];
  const params = [editionId];
  const add = (sql, value) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (f.category) add("n.category = ?", f.category);
  if (f.status) add("n.status = ?", f.status);
  if (f.district_id) add("n.district_id = ?", f.district_id);
  if (f.taluka_id) add("n.taluka_id = ?", f.taluka_id);
  // @> (not = ANY) so the GIN index on work_categories is used
  if (f.work_category) add("n.work_categories @> ARRAY[?]::text[]", f.work_category);
  if (f.from) add("n.submitted_at >= (?::date)::timestamp AT TIME ZONE 'Asia/Kolkata'", f.from);
  if (f.to) add("n.submitted_at < ((?::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'", f.to);
  const q = f.q?.trim();
  if (q && q.length >= MIN_SEARCH) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    // Each branch hits its own trigram index (BitmapOr); nominator matches resolve to ids first
    where.push(`(n.reference_no ILIKE ${p} OR n.nominee_name ILIKE ${p} OR n.mobile ILIKE ${p} OR n.email ILIKE ${p}
                 OR n.nominator_id = ANY(ARRAY(SELECT id FROM award_nominators WHERE full_name ILIKE ${p} OR mobile ILIKE ${p})))`);
  }
  return { sql: `WHERE ${where.join(" AND ")}`, params, search: Boolean(q && q.length >= MIN_SEARCH) };
}

// With a search, the planner tends to walk the sort index and test every row against the ILIKEs (seconds at 1M rows).
// The OFFSET 0 fence makes it collect the matches from the trigram indexes first, then sort only those.
const listFrom = ({ sql, search }) => `
  FROM ${search ? `(SELECT * FROM award_nominations n ${sql} OFFSET 0) n` : "award_nominations n"}${LIST_JOINS}
  ${search ? "" : sql}`;

const LIST_JOINS = `
  JOIN award_nominators nm ON nm.id = n.nominator_id
  JOIN districts d ON d.id = n.district_id
  JOIN talukas t ON t.id = n.taluka_id`;

const LIST_COLUMNS = `n.id, n.reference_no, n.category, n.nominee_name, n.mobile, n.email, n.status, n.submitted_at,
  n.work_categories, n.work_started_year, n.district_id, n.taluka_id, d.name_mr AS district, t.name_mr AS taluka,
  nm.full_name AS nominator_name, nm.mobile AS nominator_mobile`;

// An exact COUNT(*) over millions of rows on every page view is the slowest part of a list, so counting stops here.
// Pages past it can't be browsed: admins narrow the filters or export instead, as in any large search UI.
export const COUNT_CAP = 10_000;

// Counts matches up to `cap` and reports whether there are more
async function cappedCount(sql, params, cap) {
  const { rows } = await query(`SELECT COUNT(*)::int AS total FROM (SELECT 1 FROM award_nominations n ${sql} LIMIT ${cap + 1}) s`, params);
  return { total: Math.min(rows[0].total, cap), capped: rows[0].total > cap };
}

export async function adminList(f) {
  const edition = await editionFor(f.edition_id);
  const filters = buildFilters(f, edition.id);
  const { sql, params } = filters;
  const { limit, offset } = paginate(f);
  if (offset >= COUNT_CAP) {
    throw badRequest(`Only the first ${COUNT_CAP.toLocaleString("en-IN")} matches can be browsed. Narrow the filters or search to see more.`);
  }
  const page = (from) => query(`SELECT ${LIST_COLUMNS} ${from} ORDER BY ${orderBy(f)} LIMIT ${limit} OFFSET ${offset}`, params);
  let rows;
  let count;
  if (filters.search) {
    // Count first: a narrow search (under the cap) is collected via the trigram indexes and sorted (fenced); a broad one
    // has matches so dense that walking the sort index finds a page quickly, while collecting them all would not.
    count = await cappedCount(sql, params, COUNT_CAP);
    rows = await page(listFrom({ ...filters, search: !count.capped }));
  } else {
    [rows, count] = await Promise.all([page(listFrom(filters)), cappedCount(sql, params, COUNT_CAP)]);
  }
  return {
    data: rows.rows,
    meta: { ...pageMeta(f, count.total), capped: count.capped },
    edition: { id: edition.id, year: edition.year, title: edition.title },
  };
}

// Row limits per export format (null = no limit). Excel stops at 1,048,576 rows; a PDF table past a few thousand rows
// is unreadable and slow to lay out. CSV streams any size.
export const EXPORT_LIMITS = { csv: null, xlsx: 1_000_000, pdf: 5_000 };
const EXPORT_BATCH = 2_000;

/** Resolves the edition and rejects the export before any bytes are sent if it would exceed `maxRows`. */
export async function exportPrecheck(f, maxRows) {
  const edition = await editionFor(f.edition_id);
  if (maxRows) {
    const { sql, params } = buildFilters(f, edition.id);
    const { capped } = await cappedCount(sql, params, maxRows);
    if (capped) throw badRequest(`This export is limited to ${maxRows.toLocaleString("en-IN")} nominations. Narrow the filters or export CSV.`);
  }
  return edition;
}

/**
 * Reads the filtered rows through a server-side cursor in batches, so memory stays flat however many rows match.
 * `onBatch` is awaited before the next fetch (backpressure). Returns the number of rows read.
 */
export async function streamExportRows(f, edition, onBatch) {
  const filters = buildFilters(f, edition.id);
  const client = await pool.connect();
  let sent = 0;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`DECLARE award_export NO SCROLL CURSOR FOR SELECT ${LIST_COLUMNS} ${listFrom(filters)} ORDER BY ${orderBy(f)}`, filters.params);
    for (;;) {
      const { rows } = await client.query(`FETCH ${EXPORT_BATCH} FROM award_export`);
      if (rows.length) await onBatch(rows);
      sent += rows.length;
      if (rows.length < EXPORT_BATCH) break;
    }
    await client.query("COMMIT");
    return sent;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Dashboard aggregates scan the whole edition, so repeated dashboard loads share one result for a short while.
// Writes in this process clear it; other app instances catch up within STATS_TTL.
const STATS_TTL = 30_000;
const statsCache = new Map();
export const clearStatsCache = () => statsCache.clear();

export async function stats(editionId) {
  const edition = await editionFor(editionId);
  const hit = statsCache.get(edition.id);
  if (hit && Date.now() - hit.at < STATS_TTL) return hit.value;
  const value = await computeStats(edition);
  statsCache.set(edition.id, { at: Date.now(), value });
  return value;
}

async function computeStats(edition) {
  const [byStatus, byDistrict, byWork, daily] = await Promise.all([
    query(`SELECT category, status, COUNT(*)::int AS count FROM award_nominations WHERE edition_id = $1 GROUP BY category, status`, [edition.id]),
    query(`SELECT d.name_mr AS name, COUNT(*)::int AS count FROM award_nominations n JOIN districts d ON d.id = n.district_id
           WHERE n.edition_id = $1 GROUP BY d.name_mr ORDER BY count DESC, name LIMIT 10`, [edition.id]),
    query(`SELECT category, w AS key, COUNT(*)::int AS count FROM award_nominations, unnest(work_categories) w
           WHERE edition_id = $1 GROUP BY category, w ORDER BY count DESC`, [edition.id]),
    query(`SELECT to_char(submitted_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
           FROM award_nominations WHERE edition_id = $1 GROUP BY day ORDER BY day`, [edition.id]),
  ]);
  const totals = { total: 0, individual: 0, organization: 0, ...Object.fromEntries(Object.keys(STATUSES).map((s) => [s, 0])) };
  for (const r of byStatus.rows) {
    totals.total += r.count;
    totals[r.category] += r.count;
    totals[r.status] += r.count;
  }
  return {
    edition: { id: edition.id, year: edition.year, title: edition.title },
    window: nominationWindow(edition),
    totals,
    by_district: byDistrict.rows,
    by_work: byWork.rows,
    daily: daily.rows,
  };
}

export async function adminDetail(id) {
  const { rows } = await query(
    `SELECT n.*, nm.full_name AS nominator_name, nm.mobile AS nominator_mobile, d.name_mr AS district, d.name_en AS district_en,
            t.name_mr AS taluka, t.name_en AS taluka_en, e.year AS edition_year, e.title AS edition_title
     FROM award_nominations n
     JOIN award_nominators nm ON nm.id = n.nominator_id
     JOIN award_editions e ON e.id = n.edition_id
     JOIN districts d ON d.id = n.district_id
     JOIN talukas t ON t.id = n.taluka_id
     WHERE n.id = $1`,
    [id],
  );
  const n = rows[0];
  if (!n) throw notFound("Nomination not found");
  const byNomination = (table, cols = "*") =>
    query(`SELECT ${cols} FROM ${table} WHERE nomination_id = $1 ORDER BY sort_order, id`, [id]).then((r) => r.rows);
  const [detail, officials, activities, publications, honours, documents, history, remarks] = await Promise.all([
    query(`SELECT * FROM ${n.category === "organization" ? "award_organization_nominees" : "award_individual_nominees"} WHERE nomination_id = $1`, [id]),
    byNomination("award_nomination_officials"),
    byNomination("award_nomination_activities"),
    byNomination("award_nomination_publications"),
    byNomination("award_nomination_honours"),
    // storage_key / sha256 stay server-side; the UI asks for a file by document id
    byNomination("award_nomination_documents",
      "id, title, doc_type, description, external_url, original_name, mime_type, size_bytes, (storage_key IS NOT NULL) AS has_file, created_at"),
    query(`SELECT h.id, h.from_status, h.to_status, h.remarks, h.created_at, a.name AS admin_name
           FROM award_nomination_status_history h LEFT JOIN admins a ON a.id = h.admin_id
           WHERE h.nomination_id = $1 ORDER BY h.created_at, h.id`, [id]),
    query(`SELECT r.id, r.body, r.created_at, a.name AS admin_name
           FROM award_nomination_remarks r LEFT JOIN admins a ON a.id = r.admin_id
           WHERE r.nomination_id = $1 ORDER BY r.created_at DESC, r.id DESC`, [id]),
  ]);
  const { ip_address, user_agent, submission_id, ...header } = n;
  const out = {
    ...header,
    details: detail.rows[0] ?? {},
    officials, activities, publications, honours, documents,
    history: history.rows,
    remarks: remarks.rows,
    allowed_transitions: TRANSITIONS[n.status] ?? [],
    meta: { ip_address, user_agent },
  };
  if (n.category === "individual" && out.details.date_of_birth) out.details.age = ageOn(out.details.date_of_birth, n.submitted_at);
  return out;
}

// Completed years between date of birth (YYYY-MM-DD) and a reference date
export function ageOn(dob, at = new Date()) {
  const ref = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(at));
  const [y, m, d] = dob.split("-").map(Number);
  const [ry, rm, rd] = ref.split("-").map(Number);
  return ry - y - (rm < m || (rm === m && rd < d) ? 1 : 0);
}

export async function documentForDownload(nominationId, documentId) {
  const { rows } = await query(
    `SELECT d.id, d.storage, d.storage_key, d.original_name, d.mime_type, d.size_bytes, n.reference_no
     FROM award_nomination_documents d JOIN award_nominations n ON n.id = d.nomination_id
     WHERE d.id = $2 AND d.nomination_id = $1`,
    [nominationId, documentId],
  );
  if (!rows[0]?.storage_key) throw notFound("No file attached to this evidence entry");
  return rows[0];
}

// ---------------------------------------------------------------- admin: workflow

export async function changeStatus(id, to, remarks, adminId, ip) {
  try {
    const changed = await withTransaction(async (client) => {
      const { rows } = await client.query("SELECT id, status, category FROM award_nominations WHERE id = $1 FOR UPDATE", [id]);
      const n = rows[0];
      if (!n) throw notFound("Nomination not found");
      if (n.status === to) throw badRequest(`Already ${STATUSES[to].en}`);
      if (!(TRANSITIONS[n.status] ?? []).includes(to)) {
        throw badRequest(`Cannot move from ${STATUSES[n.status].en} to ${STATUSES[to].en}`, { status: "Transition not allowed" });
      }
      if (to === "not_selected" && !remarks) throw badRequest("Please give a reason", { remarks: "Required" });
      await client.query("UPDATE award_nominations SET status = $2, status_changed_at = NOW() WHERE id = $1", [id, to]);
      await client.query(
        `INSERT INTO award_nomination_status_history (nomination_id, from_status, to_status, remarks, admin_id, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, n.status, to, remarks ?? null, adminId, ip ?? null],
      );
      return { from: n.status, to, category: n.category };
    });
    clearStatsCache();
    return changed;
  } catch (err) {
    if (err?.code === "23505" && err?.constraint === "uq_award_nominations_winner") {
      throw conflict("A winner has already been selected in this category for this award year. Move that nomination back first.", "WINNER_EXISTS");
    }
    throw err;
  }
}

export async function addRemark(id, body, adminId) {
  const { rowCount } = await query("SELECT 1 FROM award_nominations WHERE id = $1", [id]);
  if (!rowCount) throw notFound("Nomination not found");
  const { rows } = await query(
    "INSERT INTO award_nomination_remarks (nomination_id, admin_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at", [id, adminId, body]);
  return rows[0];
}

// ---------------------------------------------------------------- admin: configuration

export async function adminConfig() {
  const edition = await currentEdition();
  return { ...edition, status: nominationWindow(edition) };
}

export async function updateConfig(input, adminId) {
  const edition = await currentEdition();
  const cols = Object.keys(input);
  const values = cols.map((c) => (c === "content" || c === "content_en" ? JSON.stringify(input[c]) : input[c]));
  await query(
    `UPDATE award_editions SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_by = $${cols.length + 2} WHERE id = $1`,
    [edition.id, ...values, adminId],
  );
  return adminConfig();
}
