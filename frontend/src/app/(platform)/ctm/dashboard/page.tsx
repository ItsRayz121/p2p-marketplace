import { redirect } from 'next/navigation'

export default function CtmDashboardRedirect() {
  redirect('/my-ads?tab=analytics')
}
