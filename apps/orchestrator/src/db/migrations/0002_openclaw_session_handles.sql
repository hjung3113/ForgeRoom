-- ADR-028 Project Room seam: nullable OpenClaw session handles on steps.
-- Resume HINTS only (ADR-017) — never authoritative for task/step status or output.
ALTER TABLE steps ADD COLUMN openclaw_session_id TEXT;
ALTER TABLE steps ADD COLUMN openclaw_agent_key TEXT;
ALTER TABLE steps ADD COLUMN openclaw_role TEXT;
