# Phase 9 Remaining Critical Blockers

## Current Status: BROKEN 🔥

While auth session checking is now working, **the application is completely non-functional** for authenticated users.

---

## Issue #1: Backend Console.error Crash (CRITICAL) 🔥

**Location:** `apps/server/src/index.ts:94`

**Problem:**
```
TypeError: Cannot read properties of undefined (reading 'value')
    at formatProperty (node:internal/util/inspect:2532:12)
```
This error fires 10+ times per request. It's a Node.js console.error crash when trying to log `c.req.raw.headers`.

**Root Cause:**
```typescript
console.error("No session found, headers:", c.req.raw.headers);
```
The `c.req.raw.headers` object has complex properties that Node's formatter can't handle. Trying to console.error it crashes.

**Impact:**
- Blocks all RPC calls
- Returns 500 errors instead of proper responses
- Makes dashboard unusable

**What I Got Wrong:**
I added error logging without testing what happens when you try to console.error raw HTTP headers. Should have either:
- Logged a simple string instead: `"No session found"`
- Serialized headers safely: `JSON.stringify(headers)`
- Used just the object without headers parameter

---

## Issue #2: RPC Endpoint Returns 500 (CRITICAL) 🔥

**Location:** Dashboard trying to call `POST /rpc/call`

**Error:**
```
POST http://localhost:3001/rpc/call → 500 Internal Server Error
```

**Root Cause:**
The console.error crash at index.ts:94 is crashing the RPC handler before it can return a proper response.

**Frontend Impact:**
Shows JSON parse error: `"Unexpected token 'I', "Internal S"... is not valid JSON"`
The browser gets HTML error page instead of JSON.

**What I Got Wrong:**
I didn't test the RPC endpoint after making changes. Should have:
- Tested `/rpc/call` with valid session
- Monitored server logs for errors
- Removed or fixed error logging before committing

---

## Issue #3: Sign Out Endpoint Missing (MEDIUM) ❌

**Problem:** Frontend calls `/api/auth/signout` but gets 404

**Error in logs:**
```
:3001/api/auth/signout:1  Failed to load resource: the server responded with a status of 404
```

**Root Cause:**
Better-auth might use a different endpoint name. Need to test what endpoints better-auth actually provides.

**Files to Check:**
- `apps/web/src/lib/api.ts` - `signOut()` function
- `apps/web/src/app/dashboard/page.tsx` - Where sign out button calls the API

---

## Issue #4: Login Endpoint Returns 401 (MEDIUM) ❌

**Error in logs:**
```
:3001/api/auth/sign-in/email:1  Failed to load resource: the server responded with a status of 401
```

**Context:**
This might be legitimate (wrong password), but should verify the endpoint exists and error handling is correct.

**Files to Check:**
- Better-auth endpoint names for sign-in
- Login page error handling

---

## What SHOULD Be Working Now (But Isn't)

✅ Session creation - WORKS
✅ Session checking - WORKS
❌ Using session to fetch data - BROKEN (500 errors)
❌ Signing out - BROKEN (404 endpoint)
❌ Signing in - BROKEN? (401 responses)

---

## Test Evidence

**From browser console logs:**
```
POST http://localhost:3001/rpc/call → 500 Internal Server Error
POST http://localhost:3001/rpc/call → 500 Internal Server Error
POST http://localhost:3001/rpc/call → 500 Internal Server Error
Failed to load resource: the server responded with a status of 500 (Internal Server Error)
```

**From backend logs:**
```
TypeError: Cannot read properties of undefined (reading 'value')
    at formatProperty (node:internal/util/inspect:2532:12)
    at formatRaw (node:internal/util/inspect:1428:9)
    at formatValue (node:internal/util/inspect:1183:10)
    at inspect (node:internal/util/inspect:409:10)
    at formatWithOptionsInternal (node:internal/util/inspect:2897:40)
    at formatWithOptions (node:internal/util/inspect:2759:10)
    at console.value (node:internal/util/console/constructor:377:14)
    at console.error (node:internal/util/console/constructor:444:61)
    at <anonymous> (/Users/sebastianbuxman/Desktop/sparks/apps/server/src/index.ts:94:13)
```

**From frontend:**
- Shows dashboard
- Shows "Welcome, yoyo@gmail.com" (session works)
- Shows JSON parse error when trying to load sites
- All RPC calls fail

---

## Priority Fix Order

1. **IMMEDIATE:** Fix console.error crash in oRPC handler (line 94)
   - This blocks everything
   - Should be a 2-minute fix

2. **HIGH:** Verify RPC endpoint works with real session
   - Test `/rpc/call` returns 200 with valid data
   - Test error handling doesn't crash again

3. **HIGH:** Fix sign-out endpoint
   - Determine correct better-auth endpoint
   - Implement or wire up properly

4. **MEDIUM:** Verify login endpoint works
   - Test with correct and incorrect credentials
   - Ensure proper error messages

---

## Files That Need Attention

```
apps/server/src/index.ts
  Line 78-94: Error handling in oRPC endpoint
  Line 32-33: Sign-out endpoint (probably)
  Line 56-61: Session retrieval (works but could be cleaner)

apps/web/src/lib/api.ts
  Line 30-39: Sign-out function (calls wrong endpoint)

apps/web/src/app/dashboard/page.tsx
  - Tests RPC call to fetch sites
  - Shows JSON parse error (downstream effect)

packages/api/ or apps/web/src/
  - Might have login page if not in web/src/app/auth/login/page.tsx
```

---

## What NOT To Do

❌ Don't try to console.log/error complex objects without serializing
❌ Don't assume better-auth endpoint names match what you think
❌ Don't fix one thing and claim it's done without testing the full flow
❌ Don't skip testing error cases (auth failures, network errors, etc.)
❌ Don't commit error logging that crashes the server

---

## Success Criteria When Fixed

- [ ] `curl http://localhost:3001/rpc/call` returns 200 (with proper auth)
- [ ] Dashboard loads without JSON parse errors
- [ ] "Sites" section either shows sites or "Create your first site"
- [ ] Sign Out button works and redirects to login
- [ ] No console errors in server logs
- [ ] No 500 errors in browser Network tab

---

## Timeline

Auth blocker was declared "fixed" but the app is still non-functional for authenticated users. Need to:
1. Fix the console.error crash (5 min)
2. Fix sign-out endpoint (10 min)
3. Test full auth flow including RPC (10 min)

Total: ~25 minutes to get the app actually working.

---

**Next Agent: START BY FIXING THE CONSOLE.ERROR CRASH - don't test the full flow again until line 94 is fixed.**
