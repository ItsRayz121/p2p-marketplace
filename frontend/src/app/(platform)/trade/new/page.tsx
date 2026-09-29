import { redirect } from 'next/navigation'

// The ad-based "New Trade" form was retired in favor of the listing+bid+trade
// flow (see commit 5b395481) — Profile/Favorites Buy/Sell links now go straight
// to /marketplace/listings/[id]. This route has no internal callers left, but
// old bookmarks/shared links (?adId=...) can't map to a listing id, so send
// them to the marketplace to pick a live listing instead of a dead form.
export default function NewTradePage() {
  redirect('/marketplace')
}
