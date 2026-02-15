# MemoryNode API Reference (v1)

Base URL (dev): `http://127.0.0.1:8787`

Auth:
- Worker API: `Authorization: Bearer <api_key>` or `x-api-key`.
- Admin control plane: `x-admin-token: <MASTER_ADMIN_TOKEN>` (workspace/api-key management).

Health
- `GET /healthz` → `{ status: "ok", version, build_version, embedding_model, stage?, git_sha? }`
  - `embedding_model`: `text-embedding-3-small` (OpenAI) or `stub` (dev)

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
  Body: `{ user_id, query, namespace?, top_k?, page?, page_size?, explain?, filters? }`  
  With `explain: true`, each result includes `_explain: { rrf_score, match_sources, vector_score?, text_score? }`  
  Header `X-Save-History: true` saves query+results for replay
- `GET /v1/search/history` – list saved queries (query, params, created_at)
- `POST /v1/search/replay` – re-run a saved query; returns `{ previous, current }` for comparison  
  Body: `{ query_id }`
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

Retrieval quality (Phase 5)
- `GET /v1/eval/sets` – list eval sets
- `POST /v1/eval/sets` – create eval set. Body: `{ name }`
- `POST /v1/eval/sets/:id/items` – add eval item. Body: `{ query, expected_memory_ids: uuid[] }`
- `POST /v1/eval/run` – run evaluation. Body: `{ eval_set_id, user_id, namespace? }`  
  Returns `{ items, summary: { avg_precision_at_k, avg_recall } }`

Dashboard/Supabase RPCs (workspace auth)
- `create_workspace`, `create_api_key`, `list_api_keys`, `revoke_api_key`
- Invites & roles: `create_invite`, `revoke_invite`, `accept_invite`, `update_member_role`, `remove_member`

SDK
- `addMemory`, `search`, `context`, `listMemories`, `getMemory`, `deleteMemory`, `exportMemories`, `importMemories`, `getUsageToday`, `createWorkspace`, `createApiKey`, `listApiKeys`, `revokeApiKey`.

Machine-readable spec
- OpenAPI 3.0: `docs/openapi.yaml` (generated from Zod schemas in `apps/api/src/contracts/`).
- To regenerate: `pnpm openapi:gen`. CI runs `pnpm openapi:check` to prevent drift.

See `docs/QUICKSTART.md` for setup and `docs/RELEASE_RUNBOOK.md` for deployment steps.
