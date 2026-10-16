// Canonical list of modules that can appear in the permission matrix.
// This drives both the API catalogue endpoint and checkPermission middleware.
//
// Levels:
//   read   – view list + detail
//   write  – create / update (implies read)
//   delete – soft-delete / restore (implies write)

export const MODULES = [
  // ---- Overview ----
  { key: "dashboard",           label: "Dashboard",                           group: "Overview",      supportsWrite: false, supportsDelete: false },
  // ---- Participation ----
  { key: "registrations",       label: "Registrations",                       group: "Participation", supportsWrite: true,  supportsDelete: true  },
  { key: "registrations_photos",label: "Registration Photos",                 group: "Participation", supportsWrite: false, supportsDelete: false },
  { key: "moderation",          label: "Photo Moderation",                    group: "Participation", supportsWrite: true,  supportsDelete: false },
  { key: "moderation_bulk",     label: "Bulk Review Actions (select, verify, reject, duplicate)", group: "Participation", supportsWrite: false, supportsDelete: false, alwaysEditable: true },
  { key: "certificates",        label: "Certificates",                        group: "Participation", supportsWrite: true,  supportsDelete: false },
  { key: "reports",             label: "Reports & Export",                    group: "Participation", supportsWrite: true,  supportsDelete: false },
  // ---- Shivdurg Bhushan award ----
  { key: "shivdurg_award",        label: "Shivdurg Award Nominations (view, review, status, remarks, evidence)", group: "Shivdurg Award", supportsWrite: true, supportsDelete: false },
  { key: "shivdurg_award_config", label: "Shivdurg Award Settings (dates, content, committee, winners)",         group: "Shivdurg Award", supportsWrite: true, supportsDelete: false },
  // ---- Geography ----
  { key: "geography",           label: "Geography (Divisions / Districts / Talukas)", group: "Geography", supportsWrite: true, supportsDelete: true },
  // ---- Content ----
  { key: "website_gallery",     label: "Website Gallery (View & Manage Display)", group: "Content",       supportsWrite: true,  supportsDelete: false },
  { key: "website_gallery_bulk",label: "Website Gallery Selection (Select & Bulk Add/Remove)", group: "Content", supportsWrite: false, supportsDelete: false, alwaysEditable: true },
  { key: "forts",               label: "Forts",                               group: "Content",       supportsWrite: true,  supportsDelete: true  },
  { key: "content",             label: "Content (Events / Videos / Announcements / etc.)", group: "Content", supportsWrite: true, supportsDelete: true },
  // ---- System ----
  { key: "users",               label: "Admin Users",                         group: "System",        supportsWrite: true,  supportsDelete: true  },
  { key: "roles",               label: "Roles & Permissions",                 group: "System",        supportsWrite: true,  supportsDelete: false },
  { key: "settings",            label: "Settings",                            group: "System",        supportsWrite: true,  supportsDelete: false },
  { key: "audit_logs",          label: "Audit Logs",                          group: "System",        supportsWrite: false, supportsDelete: false },
];

// Check whether a permission map grants a specific level on a module.
// This is used by checkPermission (server side) and the AuthContext helper (client side).
// is_admin on the role bypasses this entirely — the middleware handles that short-circuit.
export function canDo(permissions, moduleKey, level) {
  const mp = permissions?.[moduleKey];
  if (!mp) return false;
  if (level === "read")   return Boolean(mp.read || mp.write || mp.delete);
  if (level === "write")  return Boolean(mp.write || mp.delete);
  if (level === "delete") return Boolean(mp.delete);
  return false;
}

// Returns the flat catalogue used by the permission-matrix UI endpoint.
export function permissionCatalogue() {
  return MODULES.map(({ key, label, group, supportsWrite, supportsDelete, alwaysEditable }) => ({
    key, label, group, supportsWrite, supportsDelete,
    ...(alwaysEditable ? { alwaysEditable: true } : {}),
  }));
}
