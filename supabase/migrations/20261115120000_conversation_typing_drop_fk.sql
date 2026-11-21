-- conversation_typing.user_id was FK'd to auth.users, but two callers already
-- (or now need to) write non-auth ids into it: the live-chat widget writes a
-- chatbot_sessions.id for an anonymous visitor, and the WhatsApp QR worker
-- writes a contacts.id to represent the other party typing. Both would violate
-- the FK. Drop it — the column stays a uuid, scoped per-conversation by the
-- primary key, and RLS already restricts access to workspace members.
ALTER TABLE public.conversation_typing DROP CONSTRAINT IF EXISTS conversation_typing_user_id_fkey;
