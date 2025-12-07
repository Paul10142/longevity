"use client"

import { MembershipTier } from "@/lib/types"
import { getMembershipDisplayName, getMembershipBadgeColor } from "@/lib/membership"
import { Badge } from "@/components/ui/badge"

interface MembershipBadgeProps {
  tier: MembershipTier
  className?: string
}

/**
 * MembershipBadge - Displays a user's membership tier as a badge
 * 
 * @example
 * ```tsx
 * <MembershipBadge tier={userMembership.tier} />
 * ```
 */
export function MembershipBadge({ tier, className }: MembershipBadgeProps) {
  return (
    <Badge className={`${getMembershipBadgeColor(tier)} ${className || ""}`}>
      {getMembershipDisplayName(tier)}
    </Badge>
  )
}
