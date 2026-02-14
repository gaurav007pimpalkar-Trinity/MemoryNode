# Dashboard Deployment

Production deploy path for the MemoryNode dashboard (workspace, API keys, memories, usage, billing).

---

## URL

- **Production:** `https://app.memorynode.ai` (or your configured domain)
- **Local:** `pnpm --filter @memorynode/dashboard dev` → http://localhost:5173

---

## Deploy

### Vercel (recommended)

The dashboard uses `apps/dashboard/vercel.json` for headers.

```bash
cd apps/dashboard
vercel --prod
```

**Required env vars (Vercel project settings):**
- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anon/public key
- `VITE_API_BASE_URL` — API base (e.g. `https://api.memorynode.ai`)

Configure `app.memorynode.ai` as custom domain in Vercel.

### Cloudflare Pages

```bash
pnpm --filter @memorynode/dashboard build
# Deploy apps/dashboard/dist to Cloudflare Pages
```

1. Connect repo or upload `dist/`
2. Build command: `pnpm --filter @memorynode/dashboard build`
3. Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`
4. Output directory: `apps/dashboard/dist`
5. Custom domain: `app.memorynode.ai`

---

## CORS

Ensure `ALLOWED_ORIGINS` in the API Worker includes your dashboard URL (e.g. `https://app.memorynode.ai`).

---

## Post-deploy

- [ ] `https://app.memorynode.ai` loads
- [ ] Sign in works (Supabase Auth)
- [ ] Session → workspace → API key flow works
- [ ] API calls succeed (session cookie, CSRF)
