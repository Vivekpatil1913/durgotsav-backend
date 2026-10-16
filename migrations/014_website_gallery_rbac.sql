-- Migration 014: Website Gallery RBAC Permissions
-- Adds website_gallery and website_gallery_bulk to built-in roles

UPDATE roles
   SET permissions = permissions || '{
     "website_gallery": {"read": true, "write": true},
     "website_gallery_bulk": {"read": true},
     "moderation_bulk": {"read": true}
   }'::jsonb
 WHERE slug = 'super_admin';

UPDATE roles
   SET permissions = permissions || '{
     "website_gallery": {"read": true, "write": true},
     "website_gallery_bulk": {"read": true}
   }'::jsonb
 WHERE slug = 'admin';

