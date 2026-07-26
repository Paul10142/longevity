"use client"

import ReactMarkdown from "react-markdown"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { TopicEvidence } from "@/components/TopicEvidence"

type Doc = { title: string; body_markdown: string; version: number } | null

/**
 * Strip inline claim-id UUID tokens (e.g. "…stability.[532e21ad-cb98-481e-…]")
 * that older articles stored raw in their body. Claim ids are internal evidence
 * pointers — never reader-facing. Leaves real [R#] reference markers untouched,
 * and deliberately avoids collapsing whitespace so markdown structure survives.
 */
function stripClaimIds(md: string): string {
  return md
    .replace(/ ?\[[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]/g, "")
    .replace(/ +([.,;:)])/g, "$1")
}

function Article({ doc, empty }: { doc: Doc; empty: string }) {
  if (!doc) return <p className="text-sm text-muted-foreground py-8">{empty}</p>
  return (
    <article className="prose prose-sm max-w-none dark:prose-invert py-4">
      <ReactMarkdown>{stripClaimIds(doc.body_markdown)}</ReactMarkdown>
    </article>
  )
}

export function TopicTabs({
  topicId,
  clinician,
  patient,
  protocol,
  isAdmin = false,
}: {
  topicId: string
  clinician: Doc
  patient: Doc
  protocol: Doc
  /** Evidence tab is an internal, source-tracing surface — admins only. */
  isAdmin?: boolean
}) {
  // Default to whichever generated view exists; Evidence is a last resort and
  // only exists for admins.
  const defaultTab = patient
    ? "patient"
    : clinician
      ? "clinician"
      : protocol
        ? "protocol"
        : isAdmin
          ? "evidence"
          : "patient"

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        <TabsTrigger value="patient">Patient</TabsTrigger>
        <TabsTrigger value="clinician">Clinician</TabsTrigger>
        <TabsTrigger value="protocol">Protocol</TabsTrigger>
        {isAdmin && <TabsTrigger value="evidence">Evidence</TabsTrigger>}
      </TabsList>

      <TabsContent value="patient">
        <Article doc={patient} empty="No patient article generated yet." />
      </TabsContent>
      <TabsContent value="clinician">
        <Article doc={clinician} empty="No clinician article generated yet." />
      </TabsContent>
      <TabsContent value="protocol">
        <Article doc={protocol} empty="No protocol generated yet." />
      </TabsContent>
      {isAdmin && (
        <TabsContent value="evidence">
          <TopicEvidence topicId={topicId} />
        </TabsContent>
      )}
    </Tabs>
  )
}
