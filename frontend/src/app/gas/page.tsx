import { GasFlowClient } from './_components/GasFlowClient'

// The bare gas wizard. Pretty share routes (/gas/<chain>[/<token>]) render the
// same GasFlowClient with an initial selection + their own metadata / OG card.
export default function GasPage() {
  return <GasFlowClient />
}
