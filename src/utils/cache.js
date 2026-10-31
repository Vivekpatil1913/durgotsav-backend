import { logger } from "./logger.js";

/**
 * In-process cache for expensive read models (statistics), one entry per key:
 * - fresh (younger than ttlMs): returned as is;
 * - stale: returned at once while ONE refresh runs in the background (no visitor waits for an expired value);
 * - missing: computed once — concurrent callers share that computation instead of each running the query
 *   (no stampede of identical aggregations when many requests arrive together).
 * A failed refresh keeps the stale value (and waits retryMs before trying again, instead of re-running a failing query
 * on the next request); a failed first computation rejects and is retried by the next call.
 * A value older than maxStaleMs (a page nobody opened for a while) is not served at once: the caller waits for the
 * refresh, so a rarely opened admin page never shows hours-old figures. If that refresh fails, the old value is served.
 * maxEntries bounds the memory (the oldest key is dropped first).
 */
export function createCache({ ttlMs, maxEntries = 100, name = "cache", retryMs = 15_000, maxStaleMs = ttlMs * 10 }) {
  const entries = new Map();

  function get(key, compute) {
    let entry = entries.get(key);
    if (entry?.at !== undefined && Date.now() - entry.at < ttlMs) return Promise.resolve(entry.value);
    if (!entry) {
      entry = {};
      entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }
    if (!entry.pending) {
      const target = entry;
      target.pending = compute()
        .then(
          (value) => {
            target.value = value;
            target.at = Date.now();
            return value;
          },
          (err) => {
            if (target.at !== undefined) target.at = Date.now() - ttlMs + Math.min(retryMs, ttlMs);
            throw err;
          },
        )
        .finally(() => {
          target.pending = null;
        });
      // A background refresh of a stale value reports its own failure; callers already have the old value
      if (target.at !== undefined) target.pending.catch((err) => logger.warn({ err, cache: name, key }, "Cache refresh failed"));
    }
    if (entry.at === undefined) return entry.pending;
    if (Date.now() - entry.at < maxStaleMs) return Promise.resolve(entry.value);
    const old = entry.value;
    return entry.pending.then((value) => value, () => old);
  }

  // The cached value without ever waiting: null while nothing is cached yet (a computation starts in the background)
  function peek(key, compute) {
    const pending = get(key, compute);
    const entry = entries.get(key);
    if (entry?.at !== undefined) return entry.value;
    pending.catch((err) => logger.warn({ err, cache: name, key }, "Cache fill failed"));
    return null;
  }

  return { get, peek, clear: () => entries.clear() };
}

/**
 * Sorts rows in memory the way sortSql (utils/pagination.js) orders them in SQL: sorts[f.sort] = { cols, dir, nullsLast },
 * "alias.column" names read row.column. For small cached result sets that are paged in memory.
 */
export function sortRows(rows, sorts, f, fallback) {
  const s = sorts[f.sort] ?? sorts[fallback];
  const desc = (f.dir ?? s.dir) !== "asc";
  const fields = s.cols.split(", ").map((c) => c.split(".").pop());
  const collator = new Intl.Collator("mr", { numeric: true });
  const compare = (a, b) => {
    if (a == null || b == null) return a == null && b == null ? 0 : (a == null) === Boolean(s.nullsLast) ? 1 : -1;
    const order = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
    return desc ? -order : order;
  };
  return [...rows].sort((x, y) => {
    for (const field of fields) {
      const c = compare(x[field], y[field]);
      if (c) return c;
    }
    return 0;
  });
}
