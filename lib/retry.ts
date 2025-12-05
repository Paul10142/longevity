/**
 * Retry utility for handling transient network errors
 * Implements exponential backoff and distinguishes between retryable and fatal errors
 */

export interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  retryableErrors?: string[]
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 200,
  maxDelayMs: 2000,
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNREFUSED',
    'network',
    'timeout',
    'fetch failed',
  ],
}

/**
 * Check if an error is retryable (transient network issue)
 */
function isRetryableError(error: any): boolean {
  if (!error) return false

  const errorMessage = String(error.message || error).toLowerCase()
  const errorCode = String(error.code || '').toLowerCase()
  const errorName = String(error.name || '').toLowerCase()

  // Check for retryable error patterns
  const retryablePatterns = [
    'network',
    'timeout',
    'econnreset',
    'etimedout',
    'enotfound',
    'econnrefused',
    'fetch failed',
    'connection',
    'temporary',
    'econnaborted',
  ]

  // Check message, code, and name
  const allErrorText = `${errorMessage} ${errorCode} ${errorName}`.toLowerCase()

  // Fatal errors that should NOT be retried
  const fatalPatterns = [
    '401', // Unauthorized
    '403', // Forbidden
    '404', // Not Found
    '422', // Unprocessable Entity
    'invalid',
    'authentication',
    'authorization',
    'permission',
  ]

  // If it's a fatal error, don't retry
  if (fatalPatterns.some(pattern => allErrorText.includes(pattern))) {
    return false
  }

  // Check if it matches retryable patterns
  return retryablePatterns.some(pattern => allErrorText.includes(pattern))
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Calculate delay with exponential backoff
 */
function calculateDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  const delay = initialDelayMs * Math.pow(2, attempt)
  return Math.min(delay, maxDelayMs)
}

/**
 * Retry a function with exponential backoff
 * 
 * @param fn - Function to retry (should return a Promise)
 * @param options - Retry configuration options
 * @returns Result of the function call
 * @throws Last error if all retries fail
 * 
 * @example
 * ```ts
 * const result = await retry(
 *   () => supabaseAdmin.from('concepts').select('*').single(),
 *   { maxRetries: 3 }
 * )
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  let lastError: any

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // Don't retry if it's not a retryable error
      if (!isRetryableError(error)) {
        throw error
      }

      // Don't retry on the last attempt
      if (attempt >= opts.maxRetries) {
        break
      }

      // Calculate delay with exponential backoff
      const delay = calculateDelay(attempt, opts.initialDelayMs, opts.maxDelayMs)
      
      console.warn(
        `[Retry] Attempt ${attempt + 1}/${opts.maxRetries + 1} failed: ${error instanceof Error ? error.message : String(error)}. Retrying in ${delay}ms...`
      )

      await sleep(delay)
    }
  }

  // All retries exhausted
  console.error(`[Retry] All ${opts.maxRetries + 1} attempts failed. Last error:`, lastError)
  throw lastError
}

/**
 * Retry a Supabase query with automatic retry logic
 * Wraps the query execution and handles Supabase-specific error patterns
 * 
 * @param queryFn - Function that returns a Supabase query promise
 * @param options - Retry configuration options
 * @returns Supabase query result { data, error }
 * 
 * @example
 * ```ts
 * const { data, error } = await retrySupabaseQuery(
 *   () => supabaseAdmin.from('concepts').select('*').eq('slug', slug).single()
 * )
 * ```
 */
export async function retrySupabaseQuery<T>(
  queryFn: () => Promise<{ data: T | null; error: any }>,
  options: RetryOptions = {}
): Promise<{ data: T | null; error: any }> {
  try {
    return await retry(queryFn, options)
  } catch (error) {
    // If retry fails, return error in Supabase format
    return {
      data: null,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: (error as any)?.code || 'UNKNOWN',
        details: error instanceof Error ? error.stack : undefined,
      },
    }
  }
}
