import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!

// Client-side Supabase client using new sb_publishable_... format
// This key is safe to expose in client-side code and respects RLS policies
export const supabase = createClient(supabaseUrl, supabasePublishableKey)
