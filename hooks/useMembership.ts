"use client"

import { useState, useEffect } from "react"
import { MembershipStatus } from "@/lib/types"
import { getUserMembership, hasPaidAccess, isMembershipActive, hasFeatureAccess } from "@/lib/membership"

/**
 * useMembership - React hook for accessing membership status
 * 
 * This hook provides easy access to membership information in client components.
 * 
 * TODO: When auth is implemented, update to fetch actual user membership from database
 * 
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { membership, isLoading, hasPaid, isActive } = useMembership()
 *   
 *   if (isLoading) return <div>Loading...</div>
 *   
 *   return (
 *     <div>
 *       {hasPaid ? (
 *         <PremiumFeature />
 *       ) : (
 *         <UpgradePrompt />
 *       )}
 *     </div>
 *   )
 * }
 * ```
 */
export function useMembership(userId?: string | null) {
  const [membership, setMembership] = useState<MembershipStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    async function fetchMembership() {
      try {
        setIsLoading(true)
        // TODO: When auth is implemented, get userId from session
        // const { data: { session } } = await supabase.auth.getSession()
        // const userId = session?.user?.id
        const userMembership = await getUserMembership(userId)
        setMembership(userMembership)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to fetch membership"))
      } finally {
        setIsLoading(false)
      }
    }

    fetchMembership()
  }, [userId])

  const hasPaid = membership ? hasPaidAccess(membership.tier) : false
  const isActive = membership ? isMembershipActive(membership) : false
  const canAccessFeature = (requiredTier: "free" | "annual" | "lifetime" = "free") => {
    return membership ? hasFeatureAccess(membership, requiredTier) : false
  }

  return {
    membership,
    isLoading,
    error,
    hasPaid,
    isActive,
    canAccessFeature,
  }
}
