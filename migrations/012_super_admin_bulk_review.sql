-- moderation_bulk is an explicit permission (is_admin does not bypass it). Grant it to the built-in
-- Super Admin role by default so bulk review keeps working; it can still be switched off on the Roles page.
UPDATE roles
   SET permissions = permissions || '{"moderation_bulk": {"read": true}}'::jsonb
 WHERE slug = 'super_admin' AND NOT (permissions ? 'moderation_bulk');
