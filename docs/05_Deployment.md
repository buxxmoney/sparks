# 05 — Private Staging Deployment (on your domain, gated with Cloudflare Access)

Goal: get Sparks onto **your domain** so you + your brother can test end-to-end from any device, but **private** — nobody else can even load it. Approach: two subdomains behind **Cloudflare Access** (an email allowlist gate).

```
app.sparksmetering.com   → Vercel   (the Next.js web app)   ← Cloudflare Access gate (you two only)
api.sparksmetering.com   → Railway  (the Hono API server)   ← session-protected
Neon (Postgres)          → already live
Cloudflare R2            → already configured (sealed-PDF storage)
```

The browser only ever talks to `app.*` (which it can only reach after passing the Access email gate) and to `api.*` (which requires a valid login session). Cookies work because both are sub-domains of the same site (`sparksmetering.com`).

---

## Prerequisites (do these first)

1. **The domain must use Cloudflare for DNS** — Cloudflare Access only works if `sparksmetering.com`'s **nameservers point to Cloudflare**. Verifying the domain in Resend does NOT do this.
   - If it's already on Cloudflare: ✅ skip.
   - If not: add the site to a free Cloudflare account → Cloudflare gives you 2 nameservers → set them at your registrar → wait for it to go "Active" (minutes–hours). Re-add your existing DNS records (incl. the Resend ones) in Cloudflare so email keeps working.
2. Accounts (free tiers are fine): **Railway** (or Render), **Vercel**, **Cloudflare**. (I can't create these for you — sign up with your GitHub.)
3. Push this repo to GitHub if it isn't already (both Vercel and Railway deploy from a repo).
4. Generate a **production auth secret** (do NOT reuse the dev one):
   ```
   openssl rand -base64 48
   ```
   Save it — it's `BETTER_AUTH_SECRET` below.

---

## Step 1 — Backend → Railway (`api.sparksmetering.com`)

1. Railway → New Project → **Deploy from GitHub repo** → pick this repo.
2. Settings:
   - There's a **`Dockerfile` at the repo root** — Railway auto-detects and builds it. No start command needed (the Dockerfile's `CMD` runs the server, which reads `PORT` automatically). The image is pinned to Playwright 1.61.1 (so sealed-PDF Chromium works) and installs `poppler-utils`.
   - If Railway insists on a Nixpacks build, set the builder to **Dockerfile** in service settings.
3. **Environment variables** (Railway → Variables):
   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | your Neon connection string |
   | `BETTER_AUTH_SECRET` | the `openssl rand` value from prereqs |
   | `BETTER_AUTH_URL` | `https://api.sparksmetering.com` |
   | `WEB_ORIGINS` | `https://app.sparksmetering.com` |
   | `WEB_URL` | `https://app.sparksmetering.com` |
   | `ANTHROPIC_API_KEY` | (from your .env) |
   | `INVOICE_PARSE_MODEL` | optional override |
   | `RESEND_API_KEY` | (from your .env) |
   | `EMAIL_FROM` | `Sparks <noreply@sparksmetering.com>` |
   | `SPARKS_REVIEW_EMAIL` | `sebastianbuxman10@gmail.com,buxmanm9@gmail.com` |
   | `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET_NAME` | (from your .env — enables durable PDF storage) |
   | `SMS_PROVIDER` etc. | optional (leave unset → SMS just logs) |
4. **Custom domain:** Railway → Settings → Networking → add `api.sparksmetering.com`. Railway gives you a `CNAME` target — add it in Cloudflare DNS (Step 3). Set the Cloudflare record for `api` to **DNS-only (grey cloud)** so Access doesn't sit in front of the API.

## Step 2 — Frontend → Vercel (`app.sparksmetering.com`)

1. Vercel → **Add New Project** → import this repo.
2. Settings:
   - **Root Directory:** `apps/web`
   - Framework preset: **Next.js** (auto-detected).
   - Vercel supports Bun workspaces; if install fails, set Install Command to `bun install` (run at repo root) — ping me if it fights the monorepo.
3. **Environment variables** (Vercel → Settings → Environment Variables):
   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://api.sparksmetering.com` |
4. **Custom domain:** Vercel → Domains → add `app.sparksmetering.com`. Vercel gives a `CNAME`/target — add it in Cloudflare DNS (Step 3). For `app`, keep Cloudflare **proxied (orange cloud)** so Access can gate it.

## Step 3 — DNS (in Cloudflare)

Add two records under `sparksmetering.com`:
- `api` → CNAME → (Railway's target) → **DNS-only (grey)**
- `app` → CNAME → (Vercel's target) → **Proxied (orange)**

Keep your existing Resend records untouched.

## Step 4 — Cloudflare Access (the private gate)

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Application domain: `app.sparksmetering.com`.
3. Add a **policy**: Action **Allow**, rule **Emails** → `sebastianbuxman10@gmail.com`, `buxmanm9@gmail.com`.
4. Save. Now visiting `app.sparksmetering.com` shows a Cloudflare login; only those two emails get a one-time code and in. Everyone else is blocked.

## Step 5 — Bootstrap + smoke test

1. Open `https://app.sparksmetering.com` (pass the Access gate) → **/auth/signup** → create your account.
2. Make yourself operator (from a machine with the repo + prod `DATABASE_URL`):
   ```
   cd apps/server && DATABASE_URL='<neon>' bun scripts/make-operator.ts you@email.com
   ```
3. Log in → `/admin` → provision a customer → grab the set-password link (it now **emails** since the domain is verified) → set password on another device → run the full flow (upload invoice → send to Sparks → operator responds → customer sees the Alerts outcome + downloads the sealed PDF).

---

## Gotchas (read before debugging)

- **Cloudflare Access requires the domain on Cloudflare nameservers** (prereq 1). Without it, use Vercel's built-in Password Protection instead (one shared password; Vercel → Settings → Deployment Protection).
- **Sealed-PDF generation uses Playwright/Chromium** (`reports.ts`) — **handled** by the root `Dockerfile` (Playwright base image with Chromium + libs preinstalled, pinned to the installed 1.61.1). If you ever bump the `playwright` dependency, bump the `FROM` tag in the `Dockerfile` to match, or Chromium won't be found.
- **`poppler-utils`** (`pdftotext`) — installed by the `Dockerfile`; makes invoice parsing faster/cheaper. Without it the parser falls back to Chromium-vision automatically (graceful).
- **Self-signup is still open** — fine here because Access gates the whole app to your two emails. **Before any public launch**, gate `/auth/signup`.
- **`x-organization-id` header:** the web client sends the selected org id as a header; it's in the CORS allowlist already. If org-scoped calls 403 after deploy, it's usually a stale org id in `localStorage` — sign out/in.
- **Backend must be restarted / redeployed** whenever server code changes (no hot reload in prod — Railway redeploys on push).
- **DB migrations aren't auto-applied.** The Neon schema is already current (migrations `0001`–`0008` applied). When you add a new migration later, run it against the prod DB before/after deploy:
  ```
  cd packages/db && DATABASE_URL='<neon prod url>' bun apply-migrations.ts
  ```

---

## Env var reference (server)

Required: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_ORIGINS`, `WEB_URL`, `NODE_ENV=production`.
Email: `RESEND_API_KEY`, `EMAIL_FROM`, `SPARKS_REVIEW_EMAIL`.
Parsing: `ANTHROPIC_API_KEY` (+ optional `INVOICE_PARSE_MODEL`).
Storage: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.
SMS (optional): `SMS_PROVIDER` + provider creds.
