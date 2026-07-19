"use client"

import ReactMarkdown from "react-markdown"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { TopicEvidence } from "@/components/TopicEvidence"

type Doc = { title: string; body_markdown: string; version: number } | null

function Article({ doc, empty }: { doc: Doc; empty: string }) {
  if (!doc) return <p className="text-sm text-muted-foreground py-8">{empty}</p>
  return (
    <article className="prose prose-sm max-w-none dark:prose-invert py-4">
      <ReactMarkdown>{doc.body_markdown}</ReactMarkdown>
    </article>
  )
}

export function TopicTabs({
  topicId,
  clinician,
  patient,
  protocol,
}: {
  topicId: string
  clinician: Doc
  patient: Doc
  protocol: Doc
}) {
  // Default to whichever generated view exists, else Evidence (always available).
  const defaultTab = patient ? "patient" : clinician ? "clinician" : protocol ? "protocol" : "evidence"

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        <TabsTrigger value="patient">Patient</TabsTrigger>
        <TabsTrigger value="clinician">Clinician</TabsTrigger>
        <TabsTrigger value="protocol">Protocol</TabsTrigger>
        <TabsTrigger value="evidence">Evidence</TabsTrigger>
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
      <TabsContent value="evidence">
        <TopicEvidence topicId={topicId} />
      </TabsContent>
    </Tabs>
  )
}
