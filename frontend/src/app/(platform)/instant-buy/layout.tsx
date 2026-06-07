import { redirect } from 'next/navigation'

// Instant Buy has been removed from the product. Any visit to /instant-buy or
// its sub-routes (payment, status, crypto-deposit) is redirected to the
// Crypto Gas Fees experience that replaced it.
export default function InstantBuyLayout() {
  redirect('/gas')
}
