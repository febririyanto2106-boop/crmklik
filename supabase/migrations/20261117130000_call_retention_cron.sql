-- Nightly call-retention sweep.
--
-- Deletes call recordings and transcripts older than each workspace's policy
-- in data_retention_policies. Registered through the existing Vault-backed
-- helper so the URL and the x-cron-token stay out of cron.job.
--
-- Runs at 03:15 UTC: off-peak for the South Asia audience, and offset from the
-- :00 jobs so a long sweep does not contend with the per-minute dispatchers.
-- Each run processes one batch per policy, so a large backlog drains over
-- several nights rather than timing out in one.
--
-- Guarded on pg_cron and on the helper both existing: on a project where
-- neither is installed (a fresh branch, a local stack) this is a no-op instead
-- of failing the whole migration push. Re-run the migration after installing
-- pg_cron to register the job.
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'pg_cron not installed - skipping call-retention-sweep registration';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = '_wa_cron_post'
  ) THEN
    RAISE NOTICE '_wa_cron_post helper missing - skipping call-retention-sweep registration';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'call-retention-sweep') THEN
    PERFORM cron.schedule(
      'call-retention-sweep',
      '15 3 * * *',
      $job$SELECT public._wa_cron_post('/api/public/calls/retention-sweep');$job$
    );
  END IF;
END;
$migration$;
