"use client"

import { ReactNode } from "react"
import { MembershipStatus } from "@/lib/types"
import { isMembershipActive } from "@/lib/membership"

interface FreeFeatureGateProps {
  membership: MembershipStatus
  children: ReactNode
  fallback?: ReactNode
}

/**
 * FreeFeatureGate - Shows content only to users with free or paid membership
 * 
 * Use this to gate features that are available to all active members
 * (both free and paid tiers).
 * 
 * @example
 * ```tsx
 * <FreeFeatureGate membership={userMembership}>
 *   <SomeFreeFeature />
 * </FreeFeatureGate>
 * ```
 */
export function FreeFeatureGate({
  membership,
  children,
  fallback = null,
}: FreeFeatureGateProps) {
  if (isMembershipActive(membership)) {
    return <>{children}</>
  }

  return <>{fallback}</>
}
