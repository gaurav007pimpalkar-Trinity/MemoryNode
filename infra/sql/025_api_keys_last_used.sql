-- API key metadata: last_used_at, last_used_ip (BEST_IN_MARKET_PLAN 0.2.7)
alter table if exists api_keys
  add column if not exists last_used_at timestamptz,
  add column if not exists last_used_ip text;

comment on column api_keys.last_used_at is 'Last time this key was used for API auth';
comment on column api_keys.last_used_ip is 'Last client IP that used this key (CF-Connecting-IP or X-Forwarded-For)';

-- Redefine list_api_keys to include last_used_at, last_used_ip (columns now exist)
create or replace function list_api_keys(p_workspace_id uuid)
returns table (
  id uuid,
  workspace_id uuid,
  name text,
  created_at timestamptz,
  revoked_at timestamptz,
  key_prefix text,
  key_last4 text,
  last_used_at timestamptz,
  last_used_ip text
)
security definer
set search_path = public
language sql
as $$
  select id, workspace_id, name, created_at, revoked_at, key_prefix, key_last4, last_used_at, last_used_ip
  from api_keys
  where workspace_id = p_workspace_id
    and (
      auth.role() = 'service_role'
      or exists (select 1 from workspace_members m where m.workspace_id = api_keys.workspace_id and m.user_id = auth.uid())
    )
  order by created_at desc;
$$;
