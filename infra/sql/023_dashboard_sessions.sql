-- Dashboard session store (Phase 0.2 BEST_IN_MARKET_PLAN). Opaque session id, user_id, workspace_id, TTL.
-- Sessions are validated by the Worker; RLS is not used for dashboard_sessions (Worker uses service role).

create table if not exists dashboard_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists dashboard_sessions_expires_at on dashboard_sessions(expires_at);
create index if not exists dashboard_sessions_id on dashboard_sessions(id);

comment on table dashboard_sessions is 'Short-lived dashboard session tokens; Worker validates and sets httpOnly cookie.';
