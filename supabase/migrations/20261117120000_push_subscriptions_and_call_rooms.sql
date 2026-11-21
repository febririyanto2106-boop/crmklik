-- Web Push for incoming translated calls.
--
-- Two tables:
--   push_subscriptions — one row per browser/device an agent has opted in on.
--   call_rooms         — maps a call link's room id back to its conversation
--                        and host, so the (public, unauthenticated) guest page
--                        can trigger a push to the right agent on join.

-- ---------------------------------------------------------------- devices --
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid,
  endpoint text NOT NULL UNIQUE,
  keys jsonb NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- A device belongs to exactly one person; nobody else may read or change it.
DROP POLICY IF EXISTS "own push subscriptions" ON public.push_subscriptions;
CREATE POLICY "own push subscriptions"
  ON public.push_subscriptions FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

-- ------------------------------------------------------------- call rooms --
CREATE TABLE IF NOT EXISTS public.call_rooms (
  room_id text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  host_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_name text,
  call_type text NOT NULL DEFAULT 'voice',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);

CREATE INDEX IF NOT EXISTS call_rooms_expires_idx ON public.call_rooms (expires_at);

ALTER TABLE public.call_rooms ENABLE ROW LEVEL SECURITY;

-- Only the host (and the service role, used by the public join endpoint) ever
-- touches this table. The guest page never reads it directly — it calls a
-- server function that uses the service role and returns nothing but `ok`.
DROP POLICY IF EXISTS "host manages own call rooms" ON public.call_rooms;
CREATE POLICY "host manages own call rooms"
  ON public.call_rooms FOR ALL TO authenticated
  USING (host_user_id = auth.uid())
  WITH CHECK (host_user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_rooms TO authenticated;
GRANT ALL ON public.call_rooms TO service_role;
