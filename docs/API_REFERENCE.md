# MemoryNode API Reference (v1)

Base URL (dev): `http://127.0.0.1:8787`

Auth:
- Worker API: `Authorization: Bearer <api_key>` or `x-api-key`.
- Admin control plane: `x-admin-token: <MASTER_ADMIN_TOKEN>` (workspace/api-key management).

Health
- `GET /healthz` → `{ status: "ok", version, build_version, stage?, git_sha? }`

Response headers:
- Every response includes `x-request-id`.

Error shape:
- `{ error: { code, message }, request_id }`

Memories
- `POST /v1/memories` – ingest memory  
  Body: `{ user_id, text, namespace?, metadata? }`  
  Returns: `{ memory_id, chunks }`
- `GET /v1/memories` – list with pagination/filters  
  Query: `page`, `page_size`, `namespace`, `user_id`, `metadata` (JSON), `start_time`, `end_time`
- `GET /v1/memories/:id` – fetch one
- `DELETE /v1/memories/:id` – delete

Retrieval
- `POST /v1/search` – hybrid search (vector + full-text + RRF)  
  Body: `{ user_id, query, namespace?, top_k?, page?, page_size?, filters?{ metadata?, start_time?, end_time? } }`
- `POST /v1/context` – prompt-ready context + citations  
  Body: same as search  
  Returns: `{ context_text, citations:[{i,chunk_id,memory_id,chunk_index}], page, total, has_more }`

Usage & Limits
- `GET /v1/usage/today` – usage counters and effective plan caps.

Export / Import
- `POST /v1/export` – returns `{ artifact_base64, bytes, sha256 }` or ZIP when `Accept: application/zip` or `?format=zip`.
- `POST /v1/import` – restore from export. Body: `{ artifact_base64, mode? }` (`upsert|skip_existing|error_on_conflict|replace_ids|replace_all`).

Admin (control plane)
- `POST /v1/workspaces` – create workspace (admin token required).
- `POST /v1/api-keys` – create API key for workspace.
- `GET /v1/api-keys?workspace_id=...` – list masked keys (includes `created_at`, `revoked_at`, `last_used_at`, `last_used_ip` when available).
- `POST /v1/api-keys/revoke` – revoke API key (body: `{ api_key_id }`).
- **Rotation:** Create a new key via `POST /v1/api-keys`, then revoke the old key via `POST /v1/api-keys/revoke` after a grace period (e.g. 24 h) so clients can switch. “If you lose your key, you rotate” — no key recovery; rotation is the supported path.

Billing
- `GET /v1/billing/status`
- `POST /v1/billing/checkout` – Body `{ plan?: "pro"|"team" }`, returns PayU hosted checkout (URL or POST form fields).
- `POST /v1/billing/portal` – returns `410 Gone` (legacy Stripe portal removed; PayU billing is platform-only via checkout/webhooks).
- `POST /v1/billing/webhook` – PayU callback (raw body, hash verified with PAYU_MERCHANT_SALT/PAYU_MERCHANT_KEY).

Plans & Caps (defaults)
- free: writes 200 / reads 500 / embeds 2000 per day  
- pro: writes 2000 / reads 5000 / embeds 20000  
- team: writes 10000 / reads 20000 / embeds 100000

Dashboard/Supabase RPCs (workspace auth)
- `create_workspace`, `create_api_key`, `list_api_keys`, `revoke_api_key`
- Invites & roles: `create_invite`, `revoke_invite`, `accept_invite`, `update_member_role`, `remove_member`

SDK
- `addMemory`, `search`, `context`, `listMemories`, `getMemory`, `deleteMemory`, `exportMemories`, `importMemories`, `getUsageToday`, `createWorkspace`, `createApiKey`, `listApiKeys`, `revokeApiKey`.

Machine-readable spec
- OpenAPI 3.0: `docs/openapi.yaml` (generated from Zod schemas in `apps/api/src/contracts/`).
- To regenerate: `pnpm openapi:gen`. CI runs `pnpm openapi:check` to prevent drift.

See `docs/QUICKSTART.md` for setup and `docs/LAUNCH_CHECKLIST.md` for deployment steps.
