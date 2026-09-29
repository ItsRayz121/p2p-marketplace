import { redirect } from 'next/navigation'

// The standalone payment-methods manager was superseded by
// PaymentMethodsSection inside /wallet (id="payment-methods"), which already
// covers add/edit/hide/remove via userPaymentMethodsApi. This route has no
// internal callers left, but middleware still gates it as an authenticated
// route, so old links land signed-in users on the wallet's payment-methods
// section instead of a 404 or a dead duplicate page.
export default function PaymentMethodsPage() {
  redirect('/wallet#payment-methods')
}
