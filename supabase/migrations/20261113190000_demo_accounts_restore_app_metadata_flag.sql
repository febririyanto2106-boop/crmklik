-- Root cause of demo-mode writes not being blocked (found 2026-11-13):
-- `provisionDemoAccounts` (src/lib/demo/demo.functions.ts), the only code
-- path that creates/updates the three published demo accounts, has only
-- ever set `user_metadata.demo = true` — never `app_metadata.demo`, which is
-- the field `is_demo_session()` / `tg_block_demo_writes` actually check
-- (migration 20260922160000, deliberately app_metadata because user_metadata
-- is writable by the signed-in user themselves). So on every project where
-- these three accounts were created or recreated after that migration ran,
-- `app_metadata.demo` stayed at its default `false` and the trigger never
-- recognized the session as a demo session, silently letting every write
-- through. The provisioner is fixed in the same commit as this migration;
-- this is the one-time backfill for accounts that already exist.
UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"demo": true}'::jsonb
WHERE email IN ('user@demo.com', 'agent@demo.com', 'admin@demo.com');
