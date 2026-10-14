-- Three May-2026 test payouts were marked sent with the destination wallet address stored in
-- txHash (no real transaction hash). They were settled by hand long ago, but the confirmation
-- watcher can never resolve a malformed hash, so it raised a "Withdrawal Stuck" alert every 6h.
-- Move exactly these rows to their terminal state. Guarded by id + status + the bad hash, so it
-- is a no-op on any database where they do not match, and re-running it changes nothing.
UPDATE "Withdrawal"
SET "status" = 'completed',
    "adminNote" = 'Legacy test payout settled manually; txHash held the wallet address, not a tx hash. Closed to stop watcher alerts.'
WHERE "id" IN ('cmpoc8vum00074qfov6v051w6', 'cmpovdbgx001asobhc4uz6yrh', 'cmpovhne70023sobhyhzarwnb')
  AND "status" = 'sent'
  AND "txHash" = '0x886ff6572def49068e086aa3db07b57e406ca308';
