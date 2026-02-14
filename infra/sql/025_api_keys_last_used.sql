-- API key metadata: last_used_at, last_used_ip (BEST_IN_MARKET_PLAN 0.2.7)
alter table if exists api_keys
  add column if not exists last_used_at timestamptz,
  add column if not exists last_used_ip text;

comment on column api_keys.last_used_at is 'Last time this key was used for API auth';
comment on column api_keys.last_used_ip is 'Last client IP that used this key (CF-Connecting-IP or X-Forwarded-For)';
