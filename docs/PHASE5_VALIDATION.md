# Phase 5: Validation & Contract (Option A)

**Contract ownership:** **Zod is source → OpenAPI derived** (Option A).

- **Source of truth:** Zod schemas in `apps/api/src/contracts/`.
- **Derived artifact:** OpenAPI spec (e.g. `docs/openapi.yaml`) generated or kept in sync from Zod (e.g. `@asteasolutions/zod-to-openapi` or manual sync in same PR).
- **Rationale:** TS-first repo; runtime validation lives in Zod; types from `z.infer<>`; single source of truth for request/response shapes; OpenAPI is documentation/contract for clients.

---

## Task breakdown

| # | Task | File(s) | Status |
|---|------|---------|--------|
| 5.1 | Add Zod dependency | `apps/api/package.json` | done |
| 5.2 | Contract module + parse helper | `apps/api/src/contracts/index.ts`, `validate.ts` | done |
| 5.3 | Memory create schema | `apps/api/src/contracts/memories.ts` | done |
| 5.4 | Search payload schema | `apps/api/src/contracts/search.ts` | done |
| 5.5 | Import payload schema | `apps/api/src/contracts/import.ts` | done |
| 5.6 | Wire validation in handlers | memories, search, context (search payload), import | done |
| 5.7 | Generate/update OpenAPI from Zod | `docs/openapi.yaml` + `apps/api/scripts/generate_openapi.mjs` | done |
| 5.8 | Document in API_REFERENCE | Pointer to spec + "schemas from Zod" | done |

---

## File layout (Option A)

```
apps/api/src/
  contracts/
    index.ts       # re-exports schemas + parseWithSchema
    validate.ts    # parseWithSchema(schema, request) → { ok, data } | { ok, error }
    memories.ts    # MemoryInsertSchema (user_id, text, namespace?, metadata?)
    search.ts      # SearchPayloadSchema (user_id, query, top_k?, page?, page_size?, filters?)
    import.ts      # ImportPayloadSchema (artifact_base64, mode?)
docs/
  openapi.yaml     # derived from Zod via apps/api/scripts/generate_openapi.mjs
  PHASE5_VALIDATION.md  # this file
```

---

## Error shape for validation failures

Invalid request bodies return **400** with:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Validation failed",
    "details": { "field": ["issue"], ... }
  }
}
```

`details` is Zod `flatten()` or a short summary so clients can fix payloads.

---

## Done when

- [x] Zod is source of truth; Option A documented here and in IMPROVEMENT_PLAN.
- [x] POST /v1/memories, POST /v1/search (and /v1/context), POST /v1/import bodies validated with Zod; invalid → 400 with consistent shape.
- [x] OpenAPI spec exists and is derived or synced from Zod (same PR as schema changes).
- [x] docs/API_REFERENCE.md mentions machine-readable spec and "schemas from Zod".
