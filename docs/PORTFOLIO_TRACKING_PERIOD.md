# Portfolio tracking period, baseline and value snapshots

Written 2026-10-18. Describes what was found in the portfolio, what was changed, how the cutover works, and what is
still pending. Nothing here was run against production: the data cutover is a separate, deliberate step (see "Running it").

## 1. Findings (Phase 1)

Verified in code unless marked "not verified". No production data was available to this work (the local `.env` points at
a throwaway local database), so nothing below is a measurement of the live account.

| Observation (screenshots) | Cause | Evidence |
|---|---|---|
| Chart: fragmented lines, isolated dots, long gaps | The value series was recomputed on request. A point had a value only if **every** held token had a price observation at or before that moment, in the **same currency** as the view. Observations exist only at proven platform trade times or manual entries, so most sampled dates had none. | `performance.ts` `valueOf`/`priceAt`, sampling of up to 60 evenly spaced times |
| Historical zeros at the start of the chart | Before the first entry nothing is held, so the (empty) total was the genuine value `0`, drawn from the first entry date back. | `performance.ts` `valueOf` returns `"0"` when `held` is empty |
| Table full of "Not known" in USDT view | The USDT view ignores every PKR-quoted observation (`p.quote !== currency`). Platform trade prices are PKR, so only the USDT holding itself ever had a USDT-view price. | `performance.ts` obsByAsset filter |
| MEC shows 0 held / PKR 0.00 | The records contain sales larger than purchases (4 sales exceeding by about 3.26 units in the screenshot's own warning). FIFO leaves 0 and never invents units; the card list showed every non-archived token including zero-balance ones. Whether the user really holds MEC elsewhere is **not knowable** from the records. | `fifo.ts` `unresolvedSales`; `PortfolioTab` listed all assets |
| 7 cards vs "Assets Held 6" | Two different rules: cards = all non-archived assets, count = assets with a positive balance. | `PortfolioTab` before this change |
| "Partial · 59/141" | `figures.ts`: realized coverage = sales with a complete result / **all** sales. 82 of 141 sales were sold-beyond-records or from lots with unknown cost. | `computeFigures` |
| "Fix transaction history" lists | Raw per-sale quantities printed for each oversold token. | `ReviewCenter` before this change |
| Price warnings 9 to 45 days old | A platform price is the latest **proven** settled trade of the token (owner decision: no auto-completed, admin-forced, disputed or unverified trades), looked back over the last 200 trades. A token that has not traded provably recently keeps an old price; the review list then asked the user to "Update price", which cannot help a price that updates itself. The Markets page uses a looser rule (any completed trade, else listing rates), which is why a quote can exist there but not here. Which of the four tokens had no proven trade in the window is **not verified** (needs production data). | `portfolioMarks.service.ts`; `markets.service.ts:294`; `ReviewCenter` |
| USD/USDT inconsistency | There is no USD asset. "Tether USDT" is a per-user tracked holding (`p2p-usdt`) valued at 1 USDT and converted to PKR at `rate_USDT_PKR`. The inconsistency was the chart rule above, plus imported RupChain trades that carry no rate of their own being converted at **today's** platform rate in the USDT view (existing behaviour, kept, see limitations). | `rows.ts`, `currency.ts` |

## 2. What changed

- **Tracking period** (`PortfolioTrackingPeriod`, versioned per user) with one explicit cutover instant. Entries dated up to
  it are *archived* (a marker column, never deleted); what the user held then becomes the **opening baseline**
  (`PortfolioOpeningHolding`): per token the remaining FIFO lots with their **actual** cost (null = unknown, never zero, never
  the market price) in PKR and USDT, plus separately the cutover-day quote used for the **opening market value**.
- **Two separate concepts.** Trading profit/loss uses actual cost (lots). "Change since start" uses the opening *market*
  value, adjusted for money in and out (Modified Dietz, as before). If a token had no valid quote that day the opening value is
  unknown and the change says so.
- **Method**: the repository already uses **FIFO**, so FIFO was kept (the brief's weighted-average example does not apply).
  Under FIFO the brief's fixture (10 @ 100, 10 @ 120, sell 5 @ 130) gives realized 150 and 15 units costing 1,700, not 100 and 1,650.
- **Snapshots** (`PortfolioSnapshot`): one stored value point per minute at most, taken every 6 hours, after entry/price/import
  changes, and when the portfolio is viewed after 30 quiet minutes. A token without a usable quote makes the point `null` (a gap).
  The USDT value uses the rate stored with the same point. The chart's last point is the live value from the same code as the
  headline.
- **Chart**: starts at the baseline, never before; single observation shows "Tracking started today"; table control removed (text
  description, tooltip, arrow keys); nicer axes, currency label, responsive.
- **Counting**: `assetsHeld` = tokens with a positive balance, archived excluded, same in PKR and USDT. Zero-balance tokens are listed
  under "Not currently held".
- **Review**: concise per-token lines; the old oversold list disappears from the current period (archived with a plain-language
  discrepancy record); a price from the latest RupChain trade is a note, not a task.
- **Prices**: a failed platform-price refresh keeps the last good series and retries after 5 seconds instead of failing the portfolio.
- Edits/removals of archived entries are refused (they are the record the baseline was built from).
- Opening holdings and archived entries are visible per token ("Show earlier history") and in the Earlier history panel.

## 3. Time and timezone

Timestamps are stored in UTC. The business timezone is `platform_timezone` (default **Asia/Karachi**, as in `activeHours.ts`); it
decides "tracking started today" and is stored on the period. The cutover instant is the time the script is started (`--at` may
move it back at most 6 hours, because opening quotes are the latest at run time). **The production cutover timestamp does not exist
yet: it will be the moment the script is run.**

## 4. Running it (production steps are pending)

1. Deploy (the migration `20261022100000_portfolio_tracking_period` is additive).
2. `railway run npx tsx scripts/portfolio-cutover.ts --dry-run --confirm-production` (read-only report).
3. `... --apply --backup-dir <dir> --confirm-production`: writes and verifies a checksummed backup of every portfolio table for users
   with portfolio data, syncs RupChain trades for users who already imported (same rule as opening the page), then cuts every user
   over in one transaction each. Safe to re-run; finished users are skipped.
4. Rollback: `--rollback --all` (or `--user`): archived entries become current again, the period is marked `rolled_back`. Disaster
   recovery of rows: `--restore-dump <file>` re-inserts missing rows only. `--verify-dump <file>` checks a file.

Until step 3 a user without a period sees the portfolio exactly as before. A user with no records at all gets an empty period the
first time the portfolio is used.

## 5. Reconciliation record

Stored on each period: counts, per-token discrepancies (sold beyond records, unknown cost, no quote that day, duplicate identity),
and read-only wallet/listing context. The wallet's `balance` **includes** the reserved `lockedBalance`, so reserved is never added;
listings are never read as purchases (guarded by `isolation.unit.test.ts`). A difference between tracked USDT and the wallet is
recorded as a fact and left alone; the tracker and the custody wallet stay separate by design.

## 6. Limitations

- No production data was read or changed. Whether specific tokens (including MEC) are really held elsewhere is unknown.
- The portfolio has no deposit, withdrawal or transfer entries, and fees can only be in the quote currency. They create no profit
  and no holdings; a transfer between your own wallets is simply not recorded. Holdings added by hand during a period make the gain
  "unavailable" rather than guessed.
- USDT view restates each entry at its own recorded rate; imported RupChain PKR trades without a rate use the current platform rate
  (existing behaviour). Profit therefore differs by currency by exactly the rate movement; quantities never differ.
- Opening values use the latest quotes at run time. A quote that is old is used with its date and flagged, never hidden.
- Backdated entries recorded after the cutover count from the cutover.
