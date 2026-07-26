import type { Metadata } from "next"

/**
 * The admin workbench is internal. The public header now links to /admin, so
 * search engines can discover it — emit `noindex, nofollow` on every admin
 * route to keep it out of Google. We intentionally do NOT block /admin in
 * robots.txt: a disallow would stop crawlers from ever seeing this directive,
 * which can leave the URL indexed without content.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
