import { query } from "../db/pool.js";
import { logger } from "../utils/logger.js";

// Fire-and-forget: an audit failure must never break the admin action that triggered it.
export function audit(req, action, entity, entityId = null, meta = null) {
  query(
    "INSERT INTO audit_logs (admin_id, action, entity, entity_id, meta, ip_address) VALUES ($1, $2, $3, $4, $5, $6)",
    [req.admin?.id ?? null, action, entity, entityId === null ? null : String(entityId), meta, req.ip],
  ).catch((err) => logger.error({ err, action, entity }, "Audit log write failed"));
}
