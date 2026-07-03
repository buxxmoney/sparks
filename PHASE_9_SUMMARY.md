# Phase 9 Summary: Web App (Next.js) - Initial Setup Complete

## What Has Been Built

### Backend Infrastructure (Critical Foundation)
1. **Better-Auth Setup** (`apps/server/src/auth.ts`)
   - Added `emailAndPassword` plugin for email/password auth
   - Configured `trustedOrigins` for localhost development
   - Ready for session-based authentication

2. **CORS Configuration** (`apps/server/src/index.ts`)
   - Added Hono CORS middleware with proper headers
   - Allows credentials (cookies for better-auth sessions)
   - Supports development on localhost:3000 and localhost:3001

3. **oRPC Router Handler** (`apps/server/src/index.ts`)
   - Implements `/rpc/call` endpoint for all procedure calls
   - Validates method paths (e.g., `sites.list` → `appRouter.sites.list`)
   - Extracts auth context from better-auth sessions
   - Returns proper error codes (401 for auth, 403 for forbidden, 500 for errors)
   - Wraps all procedures with error handling

### Frontend Pages Built (9 Total)

#### Auth Pages
- **`/auth/login`** - Email/password login form
- **`/auth/signup`** - Email/password signup form
- **`/auth/org-selector`** - Org/site picker (placeholder, redirects to dashboard for now)

#### Dashboard & Navigation
- **`/` (home)** - Redirect page that checks session and routes appropriately
- **`/dashboard`** - Main hub showing user's sites, sign out button
- **`/sites/[siteId]`** - Site details hub with quick action buttons

#### Invoice Workflow (3 pages)
- **`/sites/[siteId]/invoices`** - List invoices, upload new invoice form
- **`/sites/[siteId]/invoices/[invoiceId]`** - Review parsed line items
  - Confidence-based highlighting (yellow for <80%)
  - Allows correcting category and values
  - Confirm button locks and calculates totals

#### Reconciliation Workflow (2 pages)
- **`/sites/[siteId]/reconciliation`** - List reconciliations, generate new ones
- **`/sites/[siteId]/reconciliation/[reconId]`** - Full reconciliation report
  - Shows measured data (active kWh, demand kVA, reactive kVArh)
  - Tariff comparison (landlord vs charged vs ceiling)
  - **Data gap alerts** prominently displayed (count + duration)
  - Finalize button (draft → final)
  - Download PDF button (when available)

### Supporting Infrastructure

#### API Client Library (`packages/api/src/client.ts`)
- `RPCClient` class for making oRPC calls
- Supports auth headers (x-session-id, x-user-id, x-organization-id)
- Proper error handling and JSON parsing
- `createClient()` factory function

#### React Hooks (`apps/web/src/lib/`)
- **`useRPC`** - Hook for fetching data from oRPC procedures
  - Automatic re-fetch on dependency changes
  - Loading/error/data states
  - Credentials included in requests

- **`useSession`** - Hook for managing auth state
  - Fetches session from `/api/auth/session`
  - Returns user info and session data
  - Handles auth check for redirects

#### API Utilities (`apps/web/src/lib/api.ts`)
- Session data fetching
- Sign out functionality
- Environment-aware API URL resolution

### Styling
- **`apps/web/src/app/globals.css`** - Custom design system
  - No external UI libraries (as required)
  - Comprehensive component styles (buttons, forms, alerts, badges)
  - Grid system, typography, utilities
  - Color scheme: blues, grays, accent colors

### Configuration Files
- **`apps/web/.env.example`** & **`.env.local`**
  - `NEXT_PUBLIC_API_URL` for dev/prod API endpoint configuration
- **`apps/web/next.config.cjs`**
  - Added `@sparks/api` to transpilePackages
- **`apps/web/package.json`**
  - Added `@sparks/api` and `better-auth` dependencies

---

## Architecture Overview

### Data Flow
1. **Frontend** sends HTTP POST to `/rpc/call` with `{method: "x.y.z", params: {...}}`
2. **Backend** extracts better-auth session from cookies
3. **Server** parses method string, traverses `appRouter` to find handler
4. **Handler** receives `AuthContext` (userId, sessionId, organizationId) + params
5. **Response** returned as JSON (or error with appropriate HTTP status)

### Auth Flow
1. User signs up via `/auth/signup` → better-auth creates user
2. User logs in via `/auth/login` → better-auth sets session cookie
3. Frontend redirects to `/auth/org-selector` (currently just redirects to dashboard)
4. `useSession()` hook checks `/api/auth/session` on protected routes
5. oRPC calls include session automatically (cookies)

### Invoice Workflow
1. User uploads invoice for a billing period
2. Backend (not yet implemented) parses invoice PDF with LLM → line items with confidence
3. Frontend shows line items with confidence-based highlighting
4. User corrects low-confidence items as needed
5. User confirms → calculates totals, updates DB, marks as "confirmed"
6. User locks invoice → marks as "locked", ready for reconciliation

### Reconciliation Workflow
1. User generates reconciliation for a locked invoice + billing period
2. Backend calculates measured vs tariff charges
3. Frontend displays:
   - Measured data (kWh, kVA, kVArh)
   - Tariff comparison (landlord, ceiling, charged)
   - **Data integrity alerts** (gap count + minutes)
4. User finalizes → marks as "final"
5. PDF download available once generated

---

## Known Roadblocks & TODOs

### Critical Blockers (Must Fix Before Testing)

1. **Better-Auth Session Extraction** ⚠️ (PARTIALLY ADDRESSED)
   - Implemented `auth.api.getSession()` with fallback to manual headers
   - Fallback allows testing without full better-auth integration
   - **Status**: Added error logging to debug session extraction issues
   - **Next**: Test and verify the actual method works, adjust if needed

2. **Organization Context** ⚠️
   - Frontend doesn't yet fetch/store user's organization ID
   - oRPC calls need `organizationId` in params
   - **Fix**: Implement org selector or default to user's first org

3. **Line Item Parsing** ⚠️
   - `invoices.listLineItems` expects line items to be pre-parsed
   - LLM parsing step not yet implemented in backend
   - **Fix**: Check `apps/server/src/invoices.ts` for parsing logic

4. **PDF Generation & Storage** ⚠️
   - `report.getPdf` expects PDF to already exist in storage
   - Need R2/S3 integration to generate and serve PDFs
   - **Fix**: Implement PDF generation step in `reconciliation.finalize`

5. **Better-Auth User Table** ⚠️
   - Procedures depend on better-auth user/member tables
   - May need schema migrations or initialization
   - **Fix**: Run better-auth schema setup

### Medium Priority (Implementation Gaps)

1. **Org Creation & Management**
   - `orgCreate`, `orgInvite`, `orgSetMemberRole` throw "not yet implemented"
   - Frontend doesn't have pages for these

2. **Device Management Pages**
   - No UI for provisioning devices or viewing health status
   - `devicesGetHealth` endpoint exists but not exposed

3. **Billing Period Management**
   - No page to create/close billing periods
   - Reconciliation assumes periods already exist

4. **Error Boundaries**
   - No React error boundaries
   - Failed API calls show generic errors

5. **Loading States**
   - Some pages show "Loading..." text, should have better UX

### Low Priority (Polish)

1. **Responsive Design**
   - No mobile support (out of scope for Phase 9)
   - Desktop-only for now

2. **Accessibility**
   - No ARIA labels or semantic HTML
   - Can be added later

3. **Form Validation**
   - Basic validation on signup password length
   - Could be more comprehensive

4. **Redirects on Auth Expiry**
   - Sessions can expire, but frontend doesn't redirect to login
   - Add refresh token logic if using session expiry

---

## Testing Checklist (Before Declaring Complete)

- [ ] **Backend Setup**
  - [ ] `npm run dev` (or `bun dev`) starts servers without errors
  - [ ] GET `http://localhost:3001/health` returns `{status: "ok"}`
  - [ ] POST `http://localhost:3001/api/auth/sign-up/email` with new email succeeds
  - [ ] POST `http://localhost:3001/api/auth/sign-in/email` with credentials succeeds
  - [ ] CORS headers present in responses

- [ ] **Frontend Auth**
  - [ ] Visiting `http://localhost:3000` redirects to `/auth/login`
  - [ ] Sign up page works, creates user, redirects to `/auth/org-selector`
  - [ ] Login page works, signs in user, redirects to `/auth/org-selector`
  - [ ] `/dashboard` shows welcome message after login
  - [ ] Sign out button clears session

- [ ] **API Connectivity**
  - [ ] `sites.list` RPC call returns list (currently empty)
  - [ ] Network tab shows POST to `/rpc/call` with proper headers
  - [ ] Errors return correct HTTP status codes

- [ ] **Invoice Workflow**
  - [ ] Can navigate to invoices page
  - [ ] Upload form shows billing periods (if they exist)
  - [ ] (When LLM parsing is implemented) Can review line items

- [ ] **Reconciliation Workflow**
  - [ ] Can navigate to reconciliation page
  - [ ] Generate form appears
  - [ ] (When generate is implemented) Shows report with data gaps

---

## Next Steps (For Phase 10+)

1. **Fix Critical Blockers**
   - Verify better-auth session extraction
   - Set up organization context (cookies, context provider, etc.)
   - Implement LLM line item parsing if not already done

2. **Implement Missing Backend Procedures**
   - Org creation and management
   - Billing period creation/closure
   - Invoice LLM parsing
   - PDF generation and storage

3. **Add Mobile Support**
   - Responsive CSS updates
   - Mobile navigation
   - Touch-friendly interactions

4. **Enhance UX**
   - Error boundaries
   - Better loading states
   - Form validation
   - Confirmation dialogs for destructive actions

5. **Add Admin/Operator Pages**
   - Device provisioning
   - Tariff management
   - User management (org owner features)

---

## File Summary

### Modified Files
- `apps/server/src/auth.ts` - Added emailAndPassword plugin
- `apps/server/src/index.ts` - Added CORS + oRPC handler
- `apps/web/next.config.cjs` - Added @sparks/api transpiling
- `apps/web/package.json` - Added dependencies
- `apps/web/src/app/layout.tsx` - Added globals.css import
- `apps/web/src/app/page.tsx` - Added redirect logic
- `packages/api/src/client.ts` - Implemented RPCClient class

### Created Files (Apps/Web)
- `.env.local`, `.env.example`
- `src/app/globals.css` - Custom design system
- `src/lib/api.ts` - API utilities
- `src/lib/useRPC.ts` - RPC hook
- `src/lib/useSession.ts` - Session hook
- `src/app/auth/login/page.tsx`
- `src/app/auth/signup/page.tsx`
- `src/app/auth/org-selector/page.tsx`
- `src/app/dashboard/page.tsx`
- `src/app/sites/[siteId]/page.tsx`
- `src/app/sites/[siteId]/invoices/page.tsx`
- `src/app/sites/[siteId]/invoices/[invoiceId]/page.tsx`
- `src/app/sites/[siteId]/reconciliation/page.tsx`
- `src/app/sites/[siteId]/reconciliation/[reconId]/page.tsx`

### Total: 28 files created/modified

---

## Scope Compliance

✅ **In Scope (Completed)**
- Auth screens via better-auth
- Site dashboard listing
- Invoice upload UI + review flow
- Reconciliation report UI + download
- Data gap display on reconciliation
- Custom CSS design system (no external UI lib)
- oRPC client consumption
- Session-based auth

⚠️ **Partially Implemented**
- Org/site selector (skeleton, needs membership lookup)
- Near-real-time load status (placeholder, needs device integration)
- Device/connectivity badges (UI ready, backend integration needed)

❌ **Not Implemented (Intentional Out of Scope)**
- Mobile support (explicitly ruled out)
- LLM invoice parsing (backend responsibility)
- PDF generation (backend responsibility)
- Admin/operator interfaces

---

## Ready to Test?

**No.** Critical blockers must be resolved first:
1. Verify better-auth session handling works with Hono
2. Fix organization context passing
3. Ensure backend doesn't throw on org-less queries

**Next action:** Start dev servers and test the full auth flow end-to-end.
