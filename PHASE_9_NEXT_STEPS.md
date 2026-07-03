# Phase 9 - Next Steps for Phase 10

## Immediate Actions (Before Running `npm run dev`)

### 1. Verify Better-Auth Configuration
**File**: `apps/server/src/auth.ts`
**Status**: ✅ Added emailAndPassword plugin
**Action**: Test by running server and confirming `/api/auth/sign-up/email` and `/api/auth/sign-in/email` endpoints work

```bash
# After running bun install and bun run dev (server)
curl -X POST http://localhost:3001/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123","name":"Test User"}'

# Should return a user object or error
# Then test sign-in
curl -X POST http://localhost:3001/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

### 2. Test oRPC Handler Session Extraction
**File**: `apps/server/src/index.ts` (lines 32-74)
**Status**: ⚠️ Implemented with better-auth integration + fallback for testing
**Action**: 
- [ ] Verify `auth.api.getSession()` actually works with better-auth 1.6.0
- [ ] If it fails, check better-auth docs for correct Hono integration
- [ ] Consider using `better-auth` middleware helper if available

**Testing approach** (if `auth.api.getSession()` doesn't work):
```bash
# Use fallback headers for manual testing
curl -X POST http://localhost:3001/rpc/call \
  -H "Content-Type: application/json" \
  -H "x-session-id: test-session" \
  -H "x-user-id: test-user-id" \
  -H "x-organization-id: test-org-id" \
  -d '{"method":"sites.list","params":{"organizationId":"test-org-id"}}'
```

### 3. Set Up Database Schema & Migrations
**Status**: ⚠️ Better-auth schema might need initialization
**Action**:
- [ ] Check if better-auth user/session/member tables are created
- [ ] Run any missing migrations
- [ ] Verify @sparks/db schema includes better-auth tables

```bash
cd apps/server
bun src/database/apply-migrations.ts  # or equivalent
```

---

## Testing Sequence (In Order)

### Phase 1: Backend Only
1. **Start server**
   ```bash
   cd apps/server
   bun run dev
   ```

2. **Test health endpoint**
   ```bash
   curl http://localhost:3001/health
   # Expected: {"status":"ok","timestamp":"..."}
   ```

3. **Test auth endpoints** (using curl or Postman)
   - POST `/api/auth/sign-up/email` → Create new user
   - POST `/api/auth/sign-in/email` → Login (should set cookie)
   - GET `/api/auth/session` → Check session (should be in cookie)

4. **Test oRPC endpoint**
   - POST `/rpc/call` with method `"sites.list"` and auth headers
   - Should return list (empty at start)
   - Should return 401 without auth

### Phase 2: Frontend Setup
1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Verify environment variables**
   - [ ] `/apps/web/.env.local` exists with `NEXT_PUBLIC_API_URL=http://localhost:3001`

3. **Start frontend dev server**
   ```bash
   cd apps/web
   bun run dev
   ```
   - Should start on `http://localhost:3000`

### Phase 3: Full Integration Testing
1. **Auth Flow**
   - [ ] Visit `http://localhost:3000` → Redirects to `/auth/login`
   - [ ] Go to `/auth/signup` → Create new account → Redirects to `/auth/org-selector`
   - [ ] Go to `/auth/login` → Login → Redirects to `/auth/org-selector` → Then to `/dashboard`
   - [ ] Verify session cookie is set (check DevTools → Application → Cookies)

2. **Dashboard**
   - [ ] See "No sites yet" message
   - [ ] Sign out button works

3. **Network Inspection**
   - [ ] Open DevTools → Network tab
   - [ ] Check that POST to `/rpc/call` includes cookies
   - [ ] Verify response headers include CORS headers
   - [ ] Check request/response bodies

---

## Known Issues to Resolve

### Issue #1: Organization Context Missing
**Impact**: All oRPC calls will have empty `organizationId`
**Current Behavior**: Passed from params or defaults to empty string

**Fix Options**:
- Option A: Store org ID in browser localStorage after login
- Option B: Create a React Context provider for org/site selection
- Option C: Have backend return default org with session
- **Recommended**: Option C (backend returns org with session)

**Implementation**:
```typescript
// In auth.ts / better-auth config:
// Add custom user object that includes default organization

// In frontend useSession hook:
// Extract organizationId from session and use for all RPC calls
```

### Issue #2: Better-Auth Session Extraction Method Uncertain
**Impact**: oRPC calls might not authenticate properly
**Current**: Used `auth.api.getSession()` with fallback to headers

**Verification**:
1. Check better-auth v1.6.0 documentation for Hono examples
2. Look for existing auth.handler() implementation patterns
3. Test actual session extraction with curl (check for errors in server logs)

**Fallback**: Manual session header passing works for local development

---

## Files That Need Attention Next

### High Priority
1. **apps/server/src/invoices.ts** - Add LLM parsing step
   - `invoicesCreateUpload()` needs to trigger parsing
   - Need to populate `invoiceLineItems` table with parsed data

2. **apps/server/src/reports.ts** - PDF generation
   - Implement PDF creation in `reportGeneratePdf()` 
   - Upload to R2/S3 storage
   - Set `pdfStorageKey` and `pdfHash` in reconciliations table

3. **apps/server/src/routers.ts** - Add missing procedures
   - `orgCreate()`, `orgInvite()`, `orgSetMemberRole()` currently throw errors
   - Implement using better-auth organization tables

### Medium Priority
1. **apps/web/src/app/auth/org-selector/page.tsx**
   - Currently just redirects to dashboard
   - Should show list of user's organizations
   - Add create org button

2. **apps/web/src/app/dashboard/page.tsx**
   - Add "Add Site" page/modal
   - Show site status badges (device health, last reading, etc.)

3. **Frontend error handling**
   - Add React Error Boundary component
   - Better error messages than generic "Failed to..."

---

## Environment Setup Checklist

- [ ] Node/Bun installed (v20+)
- [ ] PostgreSQL running (for @sparks/db)
- [ ] `.env` files configured
  - [ ] `apps/server/.env` with DB credentials, BETTER_AUTH_SECRET, etc.
  - [ ] `apps/web/.env.local` with NEXT_PUBLIC_API_URL
- [ ] Database migrations run
- [ ] Better-auth schema initialized

---

## Testing Tools Needed

- [ ] cURL or Postman for API testing
- [ ] Browser DevTools (Network + Application tabs)
- [ ] Database client (psql, pgAdmin, or similar)
- [ ] Server logs (bun/node output)

---

## Success Criteria (Phase 9 Complete)

- [x] Auth system implemented (better-auth setup)
- [x] CORS configured
- [x] oRPC handler created
- [x] 9 pages created (auth, dashboard, invoices, reconciliation)
- [x] API client library implemented
- [x] React hooks for data fetching
- [x] Custom CSS design system (no external UI libs)
- [ ] Full auth flow works end-to-end
- [ ] oRPC calls authenticate properly
- [ ] Organization context passed correctly
- [ ] No console errors in browser/server

---

## Phase 10 Focus Areas

Based on Phase 9 completion, Phase 10 should focus on:

1. **Backend Invoice Parsing**
   - LLM integration for PDF invoice parsing
   - Line item extraction with confidence scores
   - Populate `invoiceLineItems` table

2. **PDF Report Generation**
   - Generate reconciliation reports as PDFs
   - Hash-sealing/integrity verification
   - R2/S3 storage integration

3. **Organization Management**
   - Org creation flow
   - Member invitation + role assignment
   - Org switching UI

4. **Device Integration** (if Phase 8 incomplete)
   - Device provisioning UI
   - Health status display
   - Connectivity badges on dashboard

5. **Testing & Polish**
   - E2E tests for full workflows
   - Error handling
   - Performance optimization

---

## Quick Reference: File Locations

```
apps/web/src/
├── app/
│   ├── page.tsx (home/redirect)
│   ├── layout.tsx (root layout)
│   ├── globals.css (styles)
│   ├── auth/
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   └── org-selector/page.tsx
│   ├── dashboard/
│   │   └── page.tsx
│   └── sites/
│       └── [siteId]/
│           ├── page.tsx (hub)
│           ├── invoices/
│           │   ├── page.tsx (list)
│           │   └── [invoiceId]/page.tsx (detail)
│           └── reconciliation/
│               ├── page.tsx (list)
│               └── [reconId]/page.tsx (detail)
└── lib/
    ├── api.ts (utilities)
    ├── useRPC.ts (hook)
    └── useSession.ts (hook)

apps/server/src/
├── index.ts (server entry, routes)
├── auth.ts (better-auth config)
├── routers.ts (procedures)
├── middleware.ts (auth context)
└── [other services]

packages/api/src/
└── client.ts (RPCClient class)
```

---

## Contact/Questions

When debugging, check these in order:
1. **Server logs** - See `/rpc/call` being called, auth extraction attempts
2. **Browser Network tab** - Verify requests have proper headers and cookies
3. **Browser Console** - Client-side errors
4. **Database logs** - Query errors or missing tables
5. **Environment variables** - Ensure all are set correctly
