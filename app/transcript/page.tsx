import TranscriptContent from "@/components/TranscriptContent"

export default function TranscriptPage() {
  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-16 sm:py-20">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-sans font-semibold mb-8 text-primary">
            Cleaned Up Transcript - Blue Ridge Mountain Rotary Club Presentation, 10/1/25
          </h1>
          <div className="prose prose-lg max-w-none prose-headings:font-sans prose-headings:text-primary prose-headings:font-semibold prose-a:text-primary prose-a:font-medium prose-strong:text-foreground prose-strong:font-semibold">
            <TranscriptContent />
          </div>
        </div>
      </div>
      </main>
    </div>
  )
}

