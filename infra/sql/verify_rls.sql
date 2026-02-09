-- Returns rows only when RLS is missing or not enforced on required tables.
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in ('api_audit_log','api_keys','memories','memory_chunks','usage_daily','workspaces')
  and (
    c.relrowsecurity is not true
    or c.relforcerowsecurity is not true
  )
order by 1;

-- Simulate tenant JWT (replace UUIDs as needed)
-- set local role authenticated;
-- set local "request.jwt.claims" = '{"workspace_id":"00000000-0000-0000-0000-000000000001"}';
-- select count(*) as visible_memories from memories;

-- Spoof attempt: claim set to a workspace without membership (expect 0)
-- set local "request.jwt.claims" = '{"workspace_id":"ffffffff-ffff-ffff-ffff-ffffffffffff"}';
-- select count(*) as cross_visible from memories;

-- Service role should see everything (RLS bypass)
-- reset role;
-- set local role service_role;
-- select count(*) as service_visible from memories;
