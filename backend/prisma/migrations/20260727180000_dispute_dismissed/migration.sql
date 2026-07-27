-- "Dismiss" ruling: an admin closes a dispute without ruling against anyone.
-- Same no-fault guarantees as settled_by_parties (no winner, no bond seizure, no
-- points clawback, no dispute win/loss stats) but admin-initiated.
ALTER TYPE "DisputeResolutionType" ADD VALUE IF NOT EXISTS 'dismissed';
