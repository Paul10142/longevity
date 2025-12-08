'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'

interface ClusterMember {
  memberId: string
  rawInsightId: string
  similarity: number
  isSelected: boolean
  statement: string
  contextNote?: string | null
  confidence: string
  evidenceType: string
  qualifiers?: any
  sourceId?: string
  sourceTitle: string
  locator?: string | null
}

interface ClusterDetailClientProps {
  clusterId: string
  clusterStatus: string
  members: ClusterMember[]
  canonicalSuggestion: ClusterMember
  suggestedUniqueInsight?: {
    id: string
    canonical_statement: string
  }
}

export function ClusterDetailClient({
  clusterId,
  clusterStatus,
  members,
  canonicalSuggestion,
  suggestedUniqueInsight
}: ClusterDetailClientProps) {
  const router = useRouter()
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(
    new Set(members.filter(m => m.isSelected).map(m => m.memberId))
  )
  const [canonicalMemberId, setCanonicalMemberId] = useState<string>(
    canonicalSuggestion.memberId
  )
  const [isMerging, setIsMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleMember = (memberId: string) => {
    const newSelected = new Set(selectedMembers)
    if (newSelected.has(memberId)) {
      newSelected.delete(memberId)
      // If we're unselecting the canonical, pick a new one from remaining selected
      if (canonicalMemberId === memberId && newSelected.size > 0) {
        const remaining = members.filter(m => newSelected.has(m.memberId))
        setCanonicalMemberId(remaining[0].memberId)
      }
    } else {
      newSelected.add(memberId)
    }
    setSelectedMembers(newSelected)
  }

  const handleMerge = async () => {
    if (selectedMembers.size === 0) {
      setError('Please select at least one insight to merge')
      return
    }

    setIsMerging(true)
    setError(null)

    try {
      const selectedRawIds = members
        .filter(m => selectedMembers.has(m.memberId))
        .map(m => m.rawInsightId)

      // If this is a "merge into existing unique" suggestion
      if (suggestedUniqueInsight) {
        // Merge all selected raw insights into the existing unique insight
        for (const rawId of selectedRawIds) {
          const response = await fetch('/api/admin/insights/merge-into-unique', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rawInsightId: rawId,
              uniqueInsightId: suggestedUniqueInsight.id
            })
          })

          if (!response.ok) {
            const errorData = await response.json()
            throw new Error(errorData.error || `Failed to merge raw insight ${rawId.substring(0, 8)}...`)
          }
        }

        // Mark cluster as approved
        const approveResponse = await fetch('/api/admin/insights/clusters/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clusterId, status: 'approved' })
        })

        if (!approveResponse.ok) {
          console.warn('Failed to mark cluster as approved, but merge succeeded')
        }

        // Success - redirect to unique insight
        router.push(`/admin/insights/unique/${suggestedUniqueInsight.id}`)
        router.refresh()
        return
      }

      // Regular merge: create new unique insight
      if (!canonicalMemberId) {
        setError('Please select a canonical statement')
        setIsMerging(false)
        return
      }

      const canonicalMember = members.find(m => m.memberId === canonicalMemberId)
      if (!canonicalMember) {
        throw new Error('Canonical member not found')
      }

      const response = await fetch('/api/admin/insights/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clusterId,
          selectedRawIds,
          canonicalRawId: canonicalMember.rawInsightId
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to merge insights')
      }

      // Success - redirect to clusters list
      router.push('/admin/insights/clusters?status=approved')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setIsMerging(false)
    }
  }

  const handleReject = async () => {
    setIsMerging(true)
    setError(null)

    try {
      const response = await fetch('/api/admin/insights/clusters/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterId })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to reject cluster')
      }

      router.push('/admin/insights/clusters?status=rejected')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setIsMerging(false)
    }
  }

  const selectedCount = selectedMembers.size
  const canMerge = clusterStatus === 'pending' && (
    suggestedUniqueInsight 
      ? selectedCount > 0  // For merge-into-existing, just need selections
      : selectedCount > 0 && canonicalMemberId  // For new unique, need selections + canonical
  )

  return (
    <div className="space-y-6">
      {/* Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>
            {suggestedUniqueInsight ? 'Merge Into Existing Unique Insight' : 'Merge Instructions'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {suggestedUniqueInsight ? (
            <div className="space-y-3">
              <p className="text-sm">
                This raw insight is similar to an existing unique insight. You can merge it into the existing one.
              </p>
              <Card className="bg-muted">
                <CardContent className="pt-4">
                  <p className="font-medium mb-1">Existing Unique Insight:</p>
                  <p className="text-sm">{suggestedUniqueInsight.canonical_statement}</p>
                  <Link href={`/admin/insights/unique/${suggestedUniqueInsight.id}`} className="text-xs text-primary hover:underline mt-2 inline-block">
                    View unique insight →
                  </Link>
                </CardContent>
              </Card>
              <ol className="list-decimal list-inside space-y-2 text-sm">
                <li>Review the raw insight below</li>
                <li>Click "Merge Into Existing" to add it to the unique insight</li>
              </ol>
            </div>
          ) : (
            <ol className="list-decimal list-inside space-y-2 text-sm">
              <li>Review all insights in this cluster</li>
              <li>Select which insights should be merged together (checkboxes)</li>
              <li>Choose the canonical statement (radio button) - this will be the wording for the unique insight</li>
              <li>Click "Merge Selected" to create the unique insight</li>
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Error message */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Members list */}
      <Card>
        <CardHeader>
          <CardTitle>
            Cluster Members ({members.length})
            {selectedCount > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {selectedCount} selected
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {members.map((member) => {
              const isSelected = selectedMembers.has(member.memberId)
              const isCanonical = !suggestedUniqueInsight && canonicalMemberId === member.memberId
              const canBeCanonical = isSelected

              return (
                <Card
                  key={member.memberId}
                  className={isSelected ? 'border-primary' : ''}
                >
                  <CardContent className="pt-6">
                    <div className="flex gap-4">
                      {/* Checkbox for selection */}
                      <div className="flex items-start pt-1">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleMember(member.memberId)}
                        />
                      </div>

                      {/* Radio for canonical (only show if not merging into existing unique) */}
                      {!suggestedUniqueInsight && (
                        <div className="flex items-start pt-1">
                          <RadioGroup
                            value={canonicalMemberId}
                            onValueChange={setCanonicalMemberId}
                          >
                            <RadioGroupItem
                              value={member.memberId}
                              id={member.memberId}
                              disabled={!canBeCanonical}
                            />
                          </RadioGroup>
                        </div>
                      )}

                      {/* Content */}
                      <div className="flex-1 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <Label
                              htmlFor={member.memberId}
                              className="text-base font-medium cursor-pointer"
                            >
                              {member.statement}
                            </Label>
                            {!suggestedUniqueInsight && isCanonical && (
                              <Badge variant="default" className="ml-2">
                                Canonical
                              </Badge>
                            )}
                          </div>
                          <div className="text-right text-sm text-muted-foreground">
                            <div>Similarity: {(member.similarity * 100).toFixed(1)}%</div>
                            <div>Confidence: {member.confidence}</div>
                          </div>
                        </div>

                        {member.contextNote && (
                          <p className="text-sm text-muted-foreground italic">
                            {member.contextNote}
                          </p>
                        )}

                        <div className="flex flex-wrap gap-2 text-xs">
                          <Badge variant="outline">{member.evidenceType}</Badge>
                          <Badge variant="outline">{member.sourceTitle}</Badge>
                          {member.locator && (
                            <Badge variant="outline">{member.locator}</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      {clusterStatus === 'pending' && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex gap-4 justify-end">
              <Button
                variant="outline"
                onClick={handleReject}
                disabled={isMerging}
              >
                Reject Cluster
              </Button>
              <Button
                onClick={handleMerge}
                disabled={!canMerge || isMerging}
              >
                {isMerging ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Merging...
                  </>
                ) : suggestedUniqueInsight ? (
                  `Merge Into Existing (${selectedCount})`
                ) : (
                  `Merge Selected (${selectedCount})`
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {clusterStatus !== 'pending' && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-center">
              This cluster has been {clusterStatus}. No further actions available.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
