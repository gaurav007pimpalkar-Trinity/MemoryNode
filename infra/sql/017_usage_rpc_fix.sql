-- Normalize usage bump functions without touching legacy migration checksums.
set search_path = public;

-- Ensure any legacy definitions are removed before recreating.
drop function if exists public.bump_usage_rpc(uuid, date, int, int, int);
drop function if exists public.bump_usage(uuid, date, int, int, int);

-- Canonical usage bump: returns the usage_daily composite.
create or replace function public.bump_usage(
  p_workspace_id uuid,
  p_day date,
  p_writes int,
  p_reads int,
  p_embeds int
) returns usage_daily
language sql
volatile
as $$
  insert into usage_daily (workspace_id, day, writes, reads, embeds)
  values (
    p_workspace_id,
    p_day,
    coalesce(p_writes, 0),
    coalesce(p_reads, 0),
    coalesce(p_embeds, 0)
  )
  on conflict (workspace_id, day)
  do update set
    writes = usage_daily.writes + coalesce(excluded.writes, 0),
    reads  = usage_daily.reads  + coalesce(excluded.reads, 0),
    embeds = usage_daily.embeds + coalesce(excluded.embeds, 0)
  returning *;
$$;

-- Wrapper RPC that Supabase clients call; delegates to canonical bump_usage.
create or replace function public.bump_usage_rpc(
  p_workspace_id uuid,
  p_day date,
  p_writes int,
  p_reads int,
  p_embeds int
) returns table (
  workspace_id uuid,
  day date,
  writes int,
  reads int,
  embeds int
)
security definer
volatile
language sql
as $$
  select *
  from public.bump_usage(p_workspace_id, p_day, p_writes, p_reads, p_embeds);
$$;
