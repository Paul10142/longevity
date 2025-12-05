# Troubleshooting Guide

## Issue: Error fetching sources (Empty error object)

### Symptoms
- Console shows: `Error fetching sources: {}`
- Page loads but shows error state
- "Add New Source" button may not work

### Possible Causes

1. **Wrong Secret Key Format**
   - The `SUPABASE_SECRET_KEY` should be the **secret key** (`sb_secret_...`), not the publishable key (`sb_publishable_...`)
   - Supabase has moved to new API key formats (as of 2025):
     - `sb_publishable_...` = client-side key (replaces old `anon` key)
     - `sb_secret_...` = server-side admin key (replaces old `service_role` JWT)
   - Legacy JWT keys (`eyJ...`) still work but will be deprecated in late 2026
   - Check your `.env.local` file
   - Get the correct key from: Supabase Dashboard → Settings → API → Secret key (`sb_secret_...`)

2. **Different Supabase Project**
   - Your `.env.local` shows URL: `https://vgzcrihdxcoozgcqadbt.supabase.co`
   - Make sure this matches the project where the Medical Library tables were created
   - The tables were created in project: `ipxjckdsqgqkwaqhidqp`

3. **RLS (Row Level Security)**
   - Tables have RLS disabled (which is fine for MVP)
   - But if RLS was enabled, the service role key should bypass it
   - Check: Supabase Dashboard → Table Editor → Select table → Check RLS policies

### Solutions

1. **Verify Environment Variables**
   ```bash
   # Check your .env.local file
   cat .env.local | grep SUPABASE
   ```

   Should show:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   SUPABASE_SECRET_KEY=sb_secret_...  # New format (recommended) OR legacy JWT (eyJ...) for backward compatibility
   ```

2. **Get Correct Secret Key**
   - Go to Supabase Dashboard
   - Settings → API
   - Look for **Secret key** (should start with `sb_secret_...`)
   - If you only see legacy keys, you can still use the `service_role` JWT (starts with `eyJ...`) but it will be deprecated in late 2026
   - Update `SUPABASE_SECRET_KEY` in `.env.local`
   - **Important:** Make sure it's `sb_secret_...` NOT `sb_publishable_...`
   - Restart dev server: `npm run dev`

3. **Test Database Connection**
   ```sql
   -- Run this in Supabase SQL Editor
   SELECT COUNT(*) FROM sources;
   ```
   
   If this works, the issue is with the client connection, not the database.

4. **Check Server Logs**
   - Look at terminal where `npm run dev` is running
   - Check for Supabase initialization messages
   - Look for any connection errors

### Quick Fix

If you're using the wrong key, update `.env.local`:

```env
# Wrong (publishable key - this is for client-side only!)
SUPABASE_SECRET_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Correct - New format (recommended, future-proof)
SUPABASE_SECRET_KEY=sb_secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Also correct - Legacy JWT (still works but deprecated in late 2026)
SUPABASE_SECRET_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlvdXJfcHJvamVjdF9yZWYiLCJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNjAwMDAwMDAwLCJleHAiOjIwMDAwMDAwMDB9.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Note:** Supabase has updated their API key system (2025). The new `sb_secret_...` format is recommended for future compatibility. Legacy JWT keys (`eyJ...`) still work but will be deprecated in late 2026.

**Official Documentation:** See [Supabase GitHub Discussion #29260](https://github.com/orgs/supabase/discussions/29260) for complete migration details.

---

## Issue: "Add New Source" button doesn't work

### Symptoms
- Clicking "Add New Source" does nothing
- No navigation occurs
- No console errors

### Solutions

1. **Check if it's a client-side error**
   - Open browser DevTools (F12)
   - Check Console tab for JavaScript errors
   - Check Network tab to see if request is made

2. **Verify the route exists**
   - File should exist: `app/admin/sources/new/page.tsx`
   - Should have `"use client"` directive at top

3. **Try direct navigation**
   - Manually navigate to: `http://localhost:3000/admin/sources/new`
   - If this works, the issue is with the Link component
   - If this doesn't work, check the file exists

4. **Clear Next.js cache**
   ```bash
   rm -rf .next
   npm run dev
   ```

---

## Debugging Steps

1. **Check environment variables are loaded**
   ```bash
   # In your terminal
   node -e "console.log(process.env.NEXT_PUBLIC_SUPABASE_URL)"
   ```
   
   Should output your Supabase URL (in Next.js, you need to restart dev server after changing .env.local)

2. **Check Supabase client initialization**
   - Look for console logs: "Supabase Admin Client initialized"
   - Should show: `url: ✓ Set, secretKey: ✓ Set`

3. **Test Supabase connection directly**
   ```typescript
   // Add this temporarily to app/admin/sources/page.tsx
   console.log('Supabase URL:', process.env.NEXT_PUBLIC_SUPABASE_URL)
   console.log('Secret key exists:', !!process.env.SUPABASE_SECRET_KEY)
   console.log('Secret key starts with:', process.env.SUPABASE_SECRET_KEY?.substring(0, 20))
   ```

4. **Check browser console**
   - Open DevTools → Console
   - Look for any Supabase-related errors
   - Check Network tab for failed requests

---

## Common Issues

### Issue: "supabaseUrl is required"
- **Cause:** `NEXT_PUBLIC_SUPABASE_URL` not set
- **Fix:** Add to `.env.local` and restart dev server

### Issue: Empty error object `{}`
- **Cause:** Supabase client error that doesn't serialize well
- **Fix:** Check the actual error in server logs, verify secret key is correct

### Issue: RLS policy violation
- **Cause:** Row Level Security blocking queries
- **Fix:** Either disable RLS (for MVP) or use service role key (which bypasses RLS)

---

## Still Having Issues?

1. Check Supabase Dashboard → Logs for any errors
2. Verify tables exist: `sources`, `chunks`, `insights`, etc.
3. Test with a simple query in Supabase SQL Editor
4. Check Next.js server logs for detailed error messages
