import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY

// Server-side client with secret key (admin privileges)
// Uses new sb_secret_... format (replaces legacy service_role JWT)
// NEVER import this into client components
// Create client only if env vars are available
export const supabaseAdmin = supabaseUrl && supabaseSecretKey
  ? createClient(supabaseUrl, supabaseSecretKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      // Configure timeouts and retry behavior
      global: {
        // Increase timeout for complex queries (default is 60s)
        fetch: (url, options = {}) => {
          return fetch(url, {
            ...options,
            // 30 second timeout for database queries
            signal: AbortSignal.timeout(30000),
          })
        },
      },
    })
  : null as any // Type assertion for build-time, will error at runtime if used without config

// Debug helper
if (process.env.NODE_ENV === 'development') {
  const keyType = supabaseSecretKey?.startsWith('sb_secret_') 
    ? '✓ New format (sb_secret_)' 
    : supabaseSecretKey?.startsWith('eyJ') 
    ? '⚠ Legacy JWT (will be deprecated)' 
    : supabaseSecretKey 
    ? '⚠ Unknown format' 
    : '✗ Missing'
  
  console.log('Supabase Admin Client initialized:', {
    url: supabaseUrl ? '✓ Set' : '✗ Missing',
    secretKey: keyType
  })
  
  if (supabaseSecretKey && !supabaseSecretKey.startsWith('sb_secret_') && !supabaseSecretKey.startsWith('eyJ')) {
    console.warn('⚠ Warning: Secret key format may be incorrect. Expected: sb_secret_... or legacy JWT (eyJ...)')
  }
}
