import { redirect } from 'next/navigation'

// The page now lives at /points. Kept so old links, bookmarks and notifications still work.
export default function AirdropRedirect() {
  redirect('/points')
}
