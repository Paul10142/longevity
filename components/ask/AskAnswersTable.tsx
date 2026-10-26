import Link from "next/link"
import { ThumbsDown, ThumbsUp } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate } from "@/components/ask/askLib"

export type AskAnswerRow = {
  id: string
  question: string
  status: string
  latency_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  groundedness_score: number | null
  /** Markers the model wrote that matched no retrieved claim. Null when not recorded. */
  dangling_markers: number | null
  created_at: string | null
  feedback: { up: number; down: number }
}

const STATUS_LABEL: Record<string, string> = {
  answered: "Answered",
  not_covered: "Not Covered",
  failed: "Failed",
}

const num = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"))

/** The admin log of every Ask the Library question. Each row opens the stored answer. */
export function AskAnswersTable({ rows, linkSuffix = "" }: { rows: AskAnswerRow[]; linkSuffix?: string }) {
  if (rows.length === 0) {
    return <p className="py-8 text-sm text-muted-foreground">No questions have been asked yet.</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="whitespace-nowrap">Asked</TableHead>
          <TableHead>Question</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Latency</TableHead>
          <TableHead className="text-right">Tokens In / Out</TableHead>
          <TableHead className="text-right">Groundedness</TableHead>
          <TableHead className="text-right">Dangling Markers</TableHead>
          <TableHead>Feedback</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
              {formatDate(r.created_at) ?? "—"}
            </TableCell>
            <TableCell className="min-w-[14rem] max-w-md">
              <Link href={`/ask?id=${encodeURIComponent(r.id)}${linkSuffix}`} className="font-medium text-primary hover:underline">
                {r.question}
              </Link>
            </TableCell>
            <TableCell>
              <Badge className="whitespace-nowrap" variant={r.status === "failed" ? "destructive" : r.status === "not_covered" ? "outline" : "secondary"}>
                {STATUS_LABEL[r.status] ?? r.status}
              </Badge>
            </TableCell>
            <TableCell className="whitespace-nowrap text-right tabular-nums">
              {r.latency_ms === null ? "—" : `${(r.latency_ms / 1000).toFixed(1)} s`}
            </TableCell>
            <TableCell className="whitespace-nowrap text-right tabular-nums">
              {num(r.input_tokens)} / {num(r.output_tokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {r.groundedness_score === null ? <span className="text-muted-foreground">Pending</span> : Number(r.groundedness_score).toFixed(2)}
            </TableCell>
            <TableCell className={`text-right tabular-nums ${r.dangling_markers ? "font-semibold text-destructive" : ""}`}>
              {num(r.dangling_markers)}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {r.feedback.up + r.feedback.down === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className="inline-flex items-center gap-3 text-sm tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    <ThumbsUp className="h-3.5 w-3.5" aria-label="Helpful" /> {r.feedback.up}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ThumbsDown className="h-3.5 w-3.5" aria-label="Not helpful" /> {r.feedback.down}
                  </span>
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
