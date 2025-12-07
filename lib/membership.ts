/**
 * MEMBERSHIP SCAFFOLDING & FREE VS PAID GATING
 * 
 * This file provides the foundation for subscription management without
 * requiring full payment integration (Stripe, Lemon Squeezy, etc.) yet.
 * 
 * AUTH INTEGRATION NOTES:
 * =======================
 * 
 * Current State:
 * - Supabase Auth is configured but not yet implemented
 * - No User/Profile model exists in the database yet
 * - Authentication checks will need to be added when auth is implemented
 * 
 * How to check if user is logged in (when auth is implemented):
 * 
 * Client-side:
 * ```ts
 * import { supabase } from '@/lib/supabaseClient'
 * const { data: { session } } = await supabase.auth.getSession()
 * const isLoggedIn = !!session
 * const userId = session?.user?.id
 * ```
 * 
 * Server-side:
 * ```ts
 * import { supabaseAdmin } from '@/lib/supabaseServer'
 * // For server components, you'll need to pass session from middleware
 * // or use cookies to get the session
 * ```
 * 
 * Future Database Schema (when ready):
 * ```sql
 * -- Add to user profile or create separate memberships table
 * ALTER TABLE auth.users ADD COLUMN membership_tier text 
 *   CHECK (membership_tier IN ('free', 'annual', 'lifetime')) 
 *   DEFAULT 'free';
 * 
 * ALTER TABLE auth.users ADD COLUMN membership_expires_at timestamptz;
 * ```
 * 
 * INTEGRATION WITH PAYMENT PROVIDERS:
 * ===================================
 * 
 * When integrating Stripe/Lemon Squeezy/etc:
 * 1. Update getUserMembership() to fetch from database
 * 2. Add webhook handlers to update membership status
 * 3. Store subscription_id, customer_id, etc. in user profile
 * 4. Use payment provider's subscription status to set isActive
 */

import { MembershipTier, MembershipStatus } from './types'

/**
 * Default membership status for unauthenticated or new users
 */
export const DEFAULT_MEMBERSHIP: MembershipStatus = {
  tier: 'free',
  expiresAt: null,
  isActive: true,
}

/**
 * Check if a membership tier has access to paid features
 */
export function hasPaidAccess(tier: MembershipTier): boolean {
  return tier === 'annual' || tier === 'lifetime'
}

/**
 * Check if a membership is currently active
 * (not expired and isActive flag is true)
 */
export function isMembershipActive(membership: MembershipStatus): boolean {
  if (!membership.isActive) {
    return false
  }

  // Lifetime memberships never expire
  if (membership.tier === 'lifetime') {
    return true
  }

  // Check expiration date
  if (membership.expiresAt) {
    const expiresAt = new Date(membership.expiresAt)
    const now = new Date()
    return expiresAt > now
  }

  // If no expiration date, assume active (for free tier)
  return true
}

/**
 * Get user membership status
 * 
 * TODO: When auth is implemented, replace this with actual database lookup
 * 
 * Current implementation:
 * - Returns default free membership for all users
 * - This will be replaced with database query when auth is ready
 * 
 * Future implementation:
 * ```ts
 * export async function getUserMembership(userId: string): Promise<MembershipStatus> {
 *   const { data, error } = await supabaseAdmin
 *     .from('user_profiles')
 *     .select('membership_tier, membership_expires_at')
 *     .eq('id', userId)
 *     .single()
 *   
 *   if (error || !data) {
 *     return DEFAULT_MEMBERSHIP
 *   }
 *   
 *   return {
 *     tier: data.membership_tier || 'free',
 *     expiresAt: data.membership_expires_at,
 *     isActive: isMembershipActive({ ... })
 *   }
 * }
 * ```
 */
export async function getUserMembership(userId?: string | null): Promise<MembershipStatus> {
  // TODO: Implement actual database lookup when auth is ready
  // For now, return default free membership
  if (!userId) {
    return DEFAULT_MEMBERSHIP
  }

  // Placeholder: When auth is implemented, fetch from database
  // const { data } = await supabaseAdmin
  //   .from('user_profiles')
  //   .select('membership_tier, membership_expires_at')
  //   .eq('id', userId)
  //   .single()

  return DEFAULT_MEMBERSHIP
}

/**
 * Check if user has access to a specific feature
 * 
 * @param membership - User's membership status
 * @param requiredTier - Minimum tier required for the feature
 */
export function hasFeatureAccess(
  membership: MembershipStatus,
  requiredTier: MembershipTier = 'free'
): boolean {
  if (!isMembershipActive(membership)) {
    return false
  }

  const tierHierarchy: Record<MembershipTier, number> = {
    free: 0,
    annual: 1,
    lifetime: 2,
  }

  return tierHierarchy[membership.tier] >= tierHierarchy[requiredTier]
}

/**
 * Get membership display name
 */
export function getMembershipDisplayName(tier: MembershipTier): string {
  switch (tier) {
    case 'free':
      return 'Free'
    case 'annual':
      return 'Annual Member'
    case 'lifetime':
      return 'Lifetime Member'
    default:
      return 'Free'
  }
}

/**
 * Get membership badge color (for UI components)
 */
export function getMembershipBadgeColor(tier: MembershipTier): string {
  switch (tier) {
    case 'free':
      return 'bg-gray-100 text-gray-800'
    case 'annual':
      return 'bg-blue-100 text-blue-800'
    case 'lifetime':
      return 'bg-purple-100 text-purple-800'
    default:
      return 'bg-gray-100 text-gray-800'
  }
}
