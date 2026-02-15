-- Phase 5: Retrieval quality cockpit - eval sets, query history, explainability
-- 5.1 Eval sets: (query, expected memory ids) for retrieval quality evaluation
-- 5.2 Query history: store past queries for replay and comparison

-- Eval sets (per workspace)
create table if not exists eval_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create index if not exists eval_sets_workspace_idx on eval_sets (workspace_id);

-- Eval items: (query, expected memory ids) - one per eval set
create table if not exists eval_items (
  id uuid primary key default gen_random_uuid(),
  eval_set_id uuid not null references eval_sets(id) on delete cascade,
  query text not null,
  expected_memory_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists eval_items_eval_set_idx on eval_items (eval_set_id);

-- Search query history (per workspace) - for replay and comparison
create table if not exists search_query_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  query text not null,
  params jsonb not null default '{}',
  results_snapshot jsonb,
  created_at timestamptz not null default now()
);

create index if not exists search_query_history_workspace_created_idx
  on search_query_history (workspace_id, created_at desc);

alter table if exists eval_sets enable row level security;
alter table if exists eval_items enable row level security;
alter table if exists search_query_history enable row level security;

-- RLS: workspace members can access their workspace's eval sets and history
create policy eval_sets_select on eval_sets for select
  using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = eval_sets.workspace_id and m.user_id = auth.uid()
    )
  );
create policy eval_sets_insert on eval_sets for insert
  with check (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = eval_sets.workspace_id and m.user_id = auth.uid()
    )
  );
create policy eval_sets_update on eval_sets for update
  using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = eval_sets.workspace_id and m.user_id = auth.uid()
    )
  );
create policy eval_sets_delete on eval_sets for delete
  using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = eval_sets.workspace_id and m.user_id = auth.uid()
    )
  );

create policy eval_items_select on eval_items for select
  using (
    exists (
      select 1 from eval_sets es
      join workspace_members m on m.workspace_id = es.workspace_id and m.user_id = auth.uid()
      where es.id = eval_items.eval_set_id
    )
  );
create policy eval_items_insert on eval_items for insert
  with check (
    exists (
      select 1 from eval_sets es
      join workspace_members m on m.workspace_id = es.workspace_id and m.user_id = auth.uid()
      where es.id = eval_items.eval_set_id
    )
  );
create policy eval_items_update on eval_items for update
  using (
    exists (
      select 1 from eval_sets es
      join workspace_members m on m.workspace_id = es.workspace_id and m.user_id = auth.uid()
      where es.id = eval_items.eval_set_id
    )
  );
create policy eval_items_delete on eval_items for delete
  using (
    exists (
      select 1 from eval_sets es
      join workspace_members m on m.workspace_id = es.workspace_id and m.user_id = auth.uid()
      where es.id = eval_items.eval_set_id
    )
  );

create policy search_query_history_select on search_query_history for select
  using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = search_query_history.workspace_id and m.user_id = auth.uid()
    )
  );
create policy search_query_history_insert on search_query_history for insert
  with check (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = search_query_history.workspace_id and m.user_id = auth.uid()
    )
  );
create policy search_query_history_delete on search_query_history for delete
  using (
    exists (
      select 1 from workspace_members m
      where m.workspace_id = search_query_history.workspace_id and m.user_id = auth.uid()
    )
  );
