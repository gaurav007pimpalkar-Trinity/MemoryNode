-- 022_payu_transactions_entitlements.sql
-- Harden billing with transaction verification records and entitlement source of truth.

create table if not exists payu_transactions (
  txn_id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  plan_code text not null,
  amount numeric(12,2) not null,
  currency text not null default 'INR',
  status text not null default 'created',
  payu_payment_id text,
  verify_status text,
  verify_payload jsonb,
  verify_checked_at timestamptz,
  request_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payu_transactions_amount_check'
  ) then
    alter table payu_transactions
      add constraint payu_transactions_amount_check
      check (amount > 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'payu_transactions_status_check'
  ) then
    alter table payu_transactions
      add constraint payu_transactions_status_check
      check (status in ('created', 'initiated', 'verify_failed', 'verified', 'success', 'failed', 'canceled', 'pending'));
  end if;
end$$;

create index if not exists payu_transactions_workspace_id_idx on payu_transactions (workspace_id);
create index if not exists payu_transactions_status_idx on payu_transactions (status);
create index if not exists payu_transactions_payu_payment_id_idx on payu_transactions (payu_payment_id);

create table if not exists workspace_entitlements (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_txn_id text unique references payu_transactions(txn_id) on delete set null,
  plan_code text not null,
  status text not null default 'active',
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  caps_json jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspace_entitlements_status_check'
  ) then
    alter table workspace_entitlements
      add constraint workspace_entitlements_status_check
      check (status in ('active', 'expired', 'revoked', 'pending'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'workspace_entitlements_caps_json_check'
  ) then
    alter table workspace_entitlements
      add constraint workspace_entitlements_caps_json_check
      check (jsonb_typeof(caps_json) = 'object');
  end if;
end$$;

create index if not exists workspace_entitlements_workspace_id_idx on workspace_entitlements (workspace_id);
create index if not exists workspace_entitlements_status_idx on workspace_entitlements (status);
create index if not exists workspace_entitlements_expires_at_idx on workspace_entitlements (expires_at);

alter table if exists payu_transactions enable row level security;
alter table if exists workspace_entitlements enable row level security;

drop policy if exists payu_transactions_select on payu_transactions;
drop policy if exists payu_transactions_all on payu_transactions;
drop policy if exists workspace_entitlements_select on workspace_entitlements;
drop policy if exists workspace_entitlements_all on workspace_entitlements;

create policy payu_transactions_select on payu_transactions
  for select using (
    auth.role() = 'service_role'
    or exists (
      select 1 from workspace_members m
      where m.workspace_id = payu_transactions.workspace_id and m.user_id = auth.uid()
    )
  );

create policy payu_transactions_all on payu_transactions
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy workspace_entitlements_select on workspace_entitlements
  for select using (
    auth.role() = 'service_role'
    or exists (
      select 1 from workspace_members m
      where m.workspace_id = workspace_entitlements.workspace_id and m.user_id = auth.uid()
    )
  );

create policy workspace_entitlements_all on workspace_entitlements
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
