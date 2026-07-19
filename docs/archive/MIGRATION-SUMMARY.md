# Migration Summary: Vite → Next.js 16 + Medical Library Feature

## ✅ Completed

### 1. Database Schema
- Created Supabase migration with all required tables:
  - `sources` - Podcast episodes, books, videos, articles
  - `chunks` - Segmented transcript content  
  - `insights` - Extracted canonical statements
  - `insight_sources` - Links insights to sources
  - `concepts` & `concept_parents` - For future concept organization
  - `insight_concepts` - Links insights to concepts

### 2. Next.js Migration
- ✅ Migrated from Vite + React Router to Next.js 16 (App Router)
- ✅ Updated `package.json` scripts
- ✅ Created `next.config.js`
- ✅ Updated `tsconfig.json` for Next.js
- ✅ Ported all existing components to Next.js structure
- ✅ Updated routing from React Router to Next.js App Router

### 3. Medical Library Feature
- ✅ Added "Medical Library" tab to header navigation
- ✅ Created `/medical-library` landing page
- ✅ Created `/admin/sources` - List all sources
- ✅ Created `/admin/sources/new` - Create new source form
- ✅ Created `/api/admin/sources` - API route for source creation
- ✅ Created `/sources/[id]` - Public view of insights per source

### 4. Processing Pipeline
- ✅ Implemented `lib/pipeline.ts` with:
  - Text chunking (~1000-1500 chars per chunk)
  - OpenAI insight extraction (GPT-4o-mini)
  - Deduplication via SHA256 hash
  - Database insertion and linking

### 5. Supabase Integration
- ✅ Created `lib/supabaseClient.ts` (client-side)
- ✅ Created `lib/supabaseServer.ts` (server-side, secret key)
- ✅ All server-side operations use secret key

## 📋 Next Steps for You

### 1. Environment Variables
Create `.env.local` file with:
```env
NEXT_PUBLIC_SUPABASE_URL=https://ipxjckdsqgqkwaqhidqp.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
OPENAI_API_KEY=your-openai-api-key
```

**To get your Supabase keys:**
1. Go to your Supabase project dashboard
2. Settings → API
3. Copy the **Publishable key** (`sb_publishable_...` format)
4. Copy the **Secret key** (`sb_secret_...` format)
5. **Important:** Make sure you use `sb_secret_...` for `SUPABASE_SECRET_KEY`, NOT `sb_publishable_...`

**Note:** Supabase has updated their API key system (2025). The new `sb_publishable_...` and `sb_secret_...` formats are recommended for future compatibility. Legacy JWT keys (`eyJ...`) still work but will be deprecated in late 2026.

### 2. Test the Application
```bash
npm run dev
```

Then visit:
- `http://localhost:3000` - Homepage
- `http://localhost:3000/medical-library` - Medical Library
- `http://localhost:3000/admin/sources` - Admin sources list
- `http://localhost:3000/admin/sources/new` - Create new source

### 3. Test End-to-End Flow
1. Go to `/admin/sources/new`
2. Fill in source details (type: podcast, title, authors, etc.)
3. Paste a transcript (can be a test transcript)
4. Submit the form
5. Wait for processing (check console logs)
6. Navigate to `/sources/[source-id]` to see extracted insights

## 🏗️ Architecture

### File Structure
```
app/
  ├── layout.tsx              # Root layout
  ├── page.tsx                # Homepage
  ├── globals.css             # Global styles
  ├── medical-library/
  │   └── page.tsx            # Medical Library landing
  ├── admin/
  │   └── sources/
  │       ├── page.tsx        # Sources list
  │       └── new/
  │           └── page.tsx    # New source form
  ├── sources/
  │   └── [id]/
  │       └── page.tsx        # Source insights view
  └── api/
      └── admin/
          └── sources/
              └── route.ts    # API route

lib/
  ├── supabaseClient.ts       # Client-side Supabase
  ├── supabaseServer.ts       # Server-side Supabase
  ├── pipeline.ts             # Processing pipeline
  └── utils.ts                # Utility functions

components/
  ├── Header.tsx              # Navigation (includes Medical Library tab)
  ├── Footer.tsx
  ├── HeroSection.tsx
  ├── ExecutiveTips.tsx
  ├── ResourcesSection.tsx
  ├── About.tsx
  ├── ContactSection.tsx
  └── ui/                     # shadcn/ui components
```

## 🔧 Key Changes from Vite

1. **Routing:** React Router → Next.js App Router
2. **Links:** `react-router-dom` Link → `next/link` Link
3. **Client Components:** Added `"use client"` directive where needed
4. **Server Components:** API routes and pages use server components by default
5. **Build:** `vite build` → `next build`

## 📝 Notes

- The processing pipeline runs synchronously in the API route. For production, consider moving to a background job queue.
- OpenAI model is set to `gpt-4o-mini` for cost efficiency. Can upgrade to `gpt-4o` if needed.
- Admin pages are currently public. Add authentication later if needed.
- The schema supports embeddings (vector column in chunks) but embeddings are not generated yet.

## 🐛 Known Issues / TODO

- [ ] Add error handling UI for failed processing
- [ ] Add loading states during processing
- [ ] Add authentication for admin pages
- [ ] Add embeddings generation
- [ ] Add concept assignment to insights
- [ ] Improve OpenAI prompt based on test results
- [ ] Add pagination for sources list
- [ ] Add search/filter for insights
