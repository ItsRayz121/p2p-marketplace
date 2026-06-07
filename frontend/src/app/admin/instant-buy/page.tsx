import { redirect } from 'next/navigation'

// Instant Buy has been removed from the product. This admin route now redirects
// to the Gas Fees admin section that replaced it.
export default function AdminInstantBuyRedirect() {
  redirect('/admin/gas')
}
