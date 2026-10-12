import type { EpisodeLink } from "@/lib/sourceLinks"
import { cn } from "@/lib/utils"

/**
 * The public links for an episode, as small separate links: "Episode page",
 * "YouTube", or — when neither is known — "Find on peterattiamd.com".
 *
 * Takes the output of `episodeLinks()` (lib/sourceLinks.ts), which is the only
 * thing that may decide what to link. No hooks, so it renders in server and
 * client components alike. Renders nothing when there is nothing to link.
 */
export function EpisodeLinks({ links, className }: { links: EpisodeLink[]; className?: string }) {
  if (!links || links.length === 0) return null
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}>
      {links.map((l) => (
        <a
          key={l.kind}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          className="whitespace-nowrap text-primary hover:underline"
        >
          {l.label}
          <span className="ml-0.5 text-muted-foreground">&#8599;</span>
        </a>
      ))}
    </span>
  )
}
