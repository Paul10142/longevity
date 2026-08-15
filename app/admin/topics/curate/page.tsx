import { redirect } from "next/navigation"

/** The board moved up to /admin/topics (it IS the Topics page now). */
export default function TopicCurationPage() {
  redirect("/admin/topics")
}
