# Sparks Monorepo Map — Phase 0 Scaffold Verification

**Status:** ✅ Scaffold verified and functional  
**Runtime:** Bun 1.3.14  
**Build Orchestrator:** Turborepo 2.10.2

---

## Directory Structure

```
sparks/
├── apps/
│   ├── server/              # Hono backend API (Bun runtime)
│   │   ├── src/
│   │   │   ├── index.ts     # Main Hono app + server startup
│   │   │   ├── auth.ts      # better-auth configuration
│   │   │   └── routers.ts   # API route structure (placeholder)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── dist/            # Built output
│   │
│   ├── web/                 # Next.js frontend (React + TypeScript)
│   │   ├── src/app/
│   │   │   ├── layout.tsx   # Root layout
│   │   │   └── page.tsx     # Home page (placeholder)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── next.config.js
│   │   └── .next/           # Next.js build output
│   │
│   ├── edge/                # Python edge agent (TBD Phase 2)
│   ├── mobile/              # Expo React Native (TBD Phase 3)
│   └── docs/                # Documentation + project spec
│
├── packages/
│   ├── db/                  # Drizzle ORM + Postgres schema
│   │   ├── src/
│   │   │   ├── index.ts     # Database client export
│   │   │   └── schema.ts    # Drizzle schema definition (placeholder)
│   │   ├── drizzle.config.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── migrations/      # Drizzle migrations (auto-generated)
│   │
│   ├── api/                 # Shared API types + client (oRPC / REST)
│   │   ├── src/
│   │   │   ├── index.ts     # Main export
│   │   │   └── client.ts    # Type-safe API client (placeholder)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── ui/                  # Shared React components
│       ├── src/
│       │   └── index.ts     # Component exports (placeholder)
│       ├── package.json
│       └── tsconfig.json
│
├── Root Config Files
│   ├── package.json         # Root workspace + scripts
│   ├── tsconfig.json        # Base TypeScript configuration
│   ├── turbo.json           # Turborepo task orchestration
│   ├── biome.json           # Biome linter/formatter config
│   ├── .env.example         # Environment variable template
│   ├── .gitignore
│   └── bun.lockb            # Bun lock file

└── Documentation
    └── docs/
        ├── 01_Product_Definition.md      # Business spec
        ├── 02_Technical_Architecture.md  # Tech decisions
        └── MONOREPO_MAP.md               # This file
```

---

## Key File Locations (Per Architecture §0–4)

### Drizzle ORM Schema

- **Location:** [`packages/db/src/schema.ts`](packages/db/src/schema.ts)
- **Config:** [`packages/db/drizzle.config.ts`](packages/db/drizzle.config.ts)
- **Status:** Placeholder structure; full schema will be implemented in Phase 1

### Database Client

- **Location:** [`packages/db/src/index.ts`](packages/db/src/index.ts)
- **Exports:** `db` (Drizzle client instance), all schema types
- **Connection:** `DATABASE_URL` environment variable (Neon PostgreSQL)

### Hono Application Entry Point

- **Location:** [`apps/server/src/index.ts`](apps/server/src/index.ts)
- **Structure:**
  - Health check: `GET /health`
  - better-auth routes: `GET|POST /api/auth/**`
  - oRPC (app API): `POST /rpc/*` (placeholder)
  - Device ingestion: `POST /ingest/*` (placeholder, Phase 3)
- **Port:** Configurable via `PORT` env var (default 3001)

### better-auth Configuration

- **Location:** [`apps/server/src/auth.ts`](apps/server/src/auth.ts)
- **Config Key:** `BETTER_AUTH_SECRET` environment variable
- **Status:** Placeholder structure; integration with @sparks/db pending (Phase 2)

### API Router Structure

- **Location:** [`apps/server/src/routers.ts`](apps/server/src/routers.ts)
- **Status:** Placeholder; implementation begins Phase 2
- **Future Reference:** Technical Architecture §4.1 for endpoint list

### Next.js Web App

- **Entry:** [`apps/web/src/app/layout.tsx`](apps/web/src/app/layout.tsx) (root layout)
- **Homepage:** [`apps/web/src/app/page.tsx`](apps/web/src/app/page.tsx)
- **Config:** [`apps/web/next.config.js`](apps/web/next.config.js)

### Shared API Types

- **Location:** [`packages/api/src/`](packages/api/src/)
- **Status:** Placeholder; will export type-safe client (Phase 2)

### Shared UI Components

- **Location:** [`packages/ui/src/`](packages/ui/src/)
- **Status:** Placeholder; reusable components for web + mobile (Phase 2+)

---

## Environment Variables

**Required** (set in `.env.local`):

- `DATABASE_URL` — Neon PostgreSQL connection string
- `BETTER_AUTH_SECRET` — Session encryption key (≥32 chars)

**Optional** (documented in [`.env.example`](.env.example)):

- `PORT` — Server port (default 3001)
- `ANTHROPIC_API_KEY` — Claude API (invoice parsing, Phase 2+)
- `RESEND_API_KEY` — Email service (Phase 2+)
- `SMS_PROVIDER`, `SMS_API_KEY` — SMS delivery (Phase 2+)
- `R2_*` — Cloudflare R2 object storage (Phase 2+)

---

## Build & Development Commands

**Workspace root:**

```bash
bun install              # Install all dependencies
bun run dev              # Start dev servers (all packages)
bun run build            # Build all packages
bun run check            # TypeScript type check (Turborepo)
bun run lint             # Biome linter
bun run format           # Biome formatter
```

**Individual packages:**

```bash
cd apps/server
bun run dev              # Run Hono server (port 3001)

cd apps/web
bun run dev              # Run Next.js dev server (port 3000)

cd packages/db
bun run db:push          # Push schema to Neon
bun run db:generate      # Generate Drizzle migrations
bun run db:migrate       # Run migrations
```

---

## Verification Checklist (Phase 0 Complete)

- ✅ **Monorepo Layout:** `apps/web`, `apps/server`, `packages/db`, `packages/api`, `packages/ui` scaffolded
- ✅ **Bun + Turborepo:** Workspace wired; `turbo run check` passes all packages
- ✅ **better-auth:** Configured at `apps/server/src/auth.ts`; secret key acceptance confirmed
- ✅ **Drizzle ORM:** Schema at `packages/db/src/schema.ts`; client at `packages/db/src/index.ts`; drizzle.config.ts points to Neon
- ✅ **Hono Server:** Entry at `apps/server/src/index.ts`; `/health` endpoint, auth mounts, ingest placeholders ready
- ✅ **Next.js Web:** App Router working; root layout + page in place
- ✅ **TypeScript:** `bun run check` with zero errors; `bunx tsc --noEmit` passes
- ✅ **Dependencies:** `bun install` succeeds; versions pinned
- ✅ **Biome Config:** Linter + formatter wired at `biome.json`

---

## Next Steps (Phase 1 Trigger)

When you're ready for Phase 1 (Database Schema + Migrations), the following are in scope:

1. Implement full Drizzle schema at `packages/db/src/schema.ts` per Technical Architecture §3
2. Create initial migration for Neon via `drizzle-kit`
3. Wire better-auth to the schema (user, session, organization tables)
4. Seed minimal test data

Explicitly out of scope until their phases:

- oRPC routes (Phase 2)
- Web UI components (Phase 2)
- Device ingestion (Phase 3)
- Edge agent (separate, Python)
- Mobile app (Phase 3+)

---

## Roadblocks & Notes

- **No pre-existing errors:** TypeScript, Biome, and Turbo all report success.
- **Schema placeholder only:** The `packages/db/src/schema.ts` file has a minimal stub to pass type checking; full 30-table schema (Technical Architecture §3) will be implemented when Phase 1 begins.
- **API router placeholder:** `apps/server/src/routers.ts` is a stub; no oRPC or REST handlers are wired until Phase 2.
- **Docs folder included:** The `docs/` directory with the business and technical specs is already present and not modified by this phase.

---

*Scaffold verification complete. Ready for Phase 1 authorization.*
