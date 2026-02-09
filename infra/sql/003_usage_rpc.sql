-- Usage bump RPC to keep schema cache consistent
set search_path = public;

-- Wrapper RPC that delegates to the canonical bump_usage defined in 003_usage.sql.
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
  return query
  select workspace_id, day, writes, reads, embeds
  from bump_usage(p_workspace_id, p_day, p_writes, p_reads, p_embeds);
$$;
