/**
 * The one collapsed list every admin review screen uses for skipped and
 * non-full items (see lib/skippedItems.ts). Closed by default and compact, so
 * the hidden items cost one line of space until someone opens it.
 *
 * No hooks and no "use client": a native <details> works from server pages and
 * from client components alike.
 */
export type SkippedListItem = {
  id: string
  title: string
  /** The written skip reason (null shows "No reason written"). */
  reason: string | null
  /** Optional second line, e.g. the fact or pair that was hidden. */
  detail?: string | null
  href?: string
}

export function SkippedList({ items, noun = "Items" }: { items: readonly SkippedListItem[]; noun?: string }) {
  if (items.length === 0) return null
  return (
    <details className="rounded-md border bg-muted/30 text-sm" data-testid="skipped-list">
      <summary className="flex min-h-[44px] cursor-pointer items-center px-3 font-medium">
        Skipped and Non-Full {noun} ({items.length})
        <span className="ml-2 text-xs font-normal text-muted-foreground">Hidden from the list above</span>
      </summary>
      <ul className="max-h-72 divide-y overflow-y-auto border-t">
        {items.map(item => (
          <li key={item.id} className="px-3 py-1.5 text-xs">
            <div className="font-medium">
              {item.href ? (
                <a href={item.href} className="hover:underline">
                  {item.title}
                </a>
              ) : (
                item.title
              )}
            </div>
            <div className="text-muted-foreground">{item.reason?.trim() || "No reason written"}</div>
            {item.detail ? <div className="line-clamp-2 text-muted-foreground">{item.detail}</div> : null}
          </li>
        ))}
      </ul>
    </details>
  )
}
