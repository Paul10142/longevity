"use client"

import { ReactNode } from "react"
import { MembershipStatus, MembershipTier } from "@/lib/types"
import { hasPaidAccess, isMembershipActive } from "@/lib/membership"
import { Button } from "@/components/ui/button"
import Link from "next/link"

interface PaidFeatureGateProps {
  membership: MembershipStatus
  children: ReactNode
  fallback?: ReactNode
  showUpgradePrompt?: boolean
  upgradeMessage?: string
  upgradeButtonText?: string
  upgradeHref?: string
}

/**
 * PaidFeatureGate - Shows content only to users with paid membership (annual or lifetime)
 * 
 * Use this to gate premium features that require a paid subscription.
 * 
 * @example
 * ```tsx
 * <PaidFeatureGate 
 *   membership={userMembership}
 *   showUpgradePrompt={true}
 *   upgradeHref="/pricing"
 * >
 *   <PremiumFeature />
 * </PaidFeatureGate>
 * ```
 */
export function PaidFeatureGate({
  membership,
  children,
  fallback,
  showUpgradePrompt = true,
  upgradeMessage = "This feature is available to paid members only.",
  upgradeButtonText = "Upgrade Now",
  upgradeHref = "/pricing",
}: PaidFeatureGateProps) {
  const hasAccess = hasPaidAccess(membership.tier) && isMembershipActive(membership)

  if (hasAccess) {
    return <>{children}</>
  }

  // Show custom fallback if provided
  if (fallback) {
    return <>{fallback}</>
  }

  // Show upgrade prompt if enabled
  if (showUpgradePrompt) {
    return (
      <div className="flex flex-col items-center justify-center p-8 border border-dashed border-border rounded-lg bg-muted/50">
        <p className="text-muted-foreground mb-4 text-center">{upgradeMessage}</p>
        <Button asChild>
          <Link href={upgradeHref}>{upgradeButtonText}</Link>
        </Button>
      </div>
    )
  }

  return null
}
