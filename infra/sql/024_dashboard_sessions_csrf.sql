-- Phase 0 CSRF: store token per session so we can validate X-CSRF-Token header for mutating dashboard calls.

alter table dashboard_sessions
  add column if not exists csrf_token text;

comment on column dashboard_sessions.csrf_token is 'CSRF token returned to client; required in X-CSRF-Token header for mutating requests.';
