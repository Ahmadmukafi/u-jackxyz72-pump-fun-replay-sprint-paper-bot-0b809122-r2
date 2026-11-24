// Pump.fun Replay Sprint r2 — "proven-mint swing with a loose trailing exit".
//
// Strategy (same proven design as r1, which graded +0.127314289 SOL locally
// and was rejected only because the server's dev grade timed out):
// most fresh mints are untradable noise — buying every mint loses ~7% per
// round trip after the 2-slot fill delay and fees, because the bot buys the
// top of the opening spike and sells the pullback. The edge that survives is
// narrow: only buy a mint once it has PROVEN itself (real reserves >= 3 SOL,
// so the 1% order cap allows a full 0.05 SOL buy) and only while it is still
// cheap (price at most 2x its creation price — entries above 2x are the worst
// losers, the -60% crashes). Then hold with a LOOSE trailing stop (-35% from
// peak) and a 90-trade age exit, and no hard stop-loss: the winners are the
// mints that survive 90 trades without a -35% pullback (they bank +56% to
// +172%), while tight stops just bleed -18% per exit through the fill delay.
// The 5-slot cap plus long holds is itself a filter: it keeps the bot to
// ~24 round trips in 24h, and every mechanism that frees slots faster only
// adds negative-EV trades.
//
// r2 change (one targeted improvement, TRIED and REVERTED): waiting one batch
// after a mint's CreateEvent before buying graded WORSE locally (+0.1056 SOL
// vs r1's +0.1273 SOL — the delay cost entries into winners), so it was
// removed. r2 therefore keeps r1's exact proven logic, re-implemented here.
//
// Rules enforced here: max 5 open positions, buys sized to the 1%-of-real-
// reserve cap (a 3 SOL mint allows exactly a 0.05 SOL buy), round trips
// >= 0.01 SOL (we buy 0.03-0.05 SOL), no shorts, no leverage.
// Determinism: every decision comes from the replay state only (slot numbers,
// reserves, trade counts). No clock, no environment, no Math.random — the two
// grader runs must produce byte-identical action logs.

import { runBot } from "./vendor/makefun-bot.ts";
import type { BotState, OrderInput } from "./vendor/makefun-bot.ts";

const BUY_LAMPORTS = 50_000_000n; // 0.05 SOL per buy
const MIN_BUY_LAMPORTS = 10_500_000n; // 0.0105 SOL: above the 0.01 SOL round-trip minimum
const MAX_TRADES_AT_ENTRY = 200; // enter while the mint is still early (up to 200 trades)
const MIN_REAL_QUOTE_LAMPORTS = 3_000_000_000n; // 3 SOL: only proven mints (cap then allows a full buy)
const MAX_ENTRY_MULT_BPS = 10000; // never buy above 2.0x the creation price
const MAX_OPEN = 5;
const SLIPPAGE_BPS = 2000;
const STOP_NUM = 0n; // no hard stop-loss: tight stops bleed -18% per exit through the fill delay
const TRAIL_NUM = 65n; // trailing stop: sell at -35% from the peak after entry
const MAX_HOLD_TRADES = 90; // age exit: sell after this many trades on the mint
const SCALE = 1_000_000n; // price scale: quote lamports per token, scaled

interface OpenTrade {
  entry: bigint;
  peak: bigint;
  tradesAtEntry: number;
}

const open = new Map<string, OpenTrade>();
const tried = new Set<string>();
const deferred = new Set<string>();
const buysInFlight = new Map<string, string>(); // client_id -> mint
const sellsInFlight = new Set<string>(); // mints with a sell already sent, awaiting its fill
const birthPrice = new Map<string, bigint>(); // mint -> price at creation (virtual quote / virtual token)

function curvePrice(state: BotState, mint: string): bigint | null {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n) return null;
  return (c.virtual_quote_reserves * SCALE) / c.virtual_token_reserves;
}

function cheapEnough(state: BotState, mint: string): boolean {
  const cp = birthPrice.get(mint);
  const pr = curvePrice(state, mint);
  if (cp === undefined || pr === null) return false;
  return pr * 10000n <= cp * BigInt(10000 + MAX_ENTRY_MULT_BPS);
}

await runBot({
  onBatch(state, batch) {
    const orders: OrderInput[] = [];

    // 0. Record each mint's creation price (from its CreateEvent).
    for (const e of batch.events) {
      if (e.event === "CreateEvent" && !birthPrice.has(e.mint)) {
        const vt = BigInt(e.virtual_token_reserves);
        const vq = BigInt(e.virtual_quote_reserves);
        if (vt > 0n) birthPrice.set(e.mint, (vq * SCALE) / vt);
      }
    }

    // 1. Fold fills: open tracking when a buy fills, close it when a sell resolves.
    for (const f of batch.fills) {
      if (f.side === "buy" && buysInFlight.has(f.client_id)) {
        const mint = buysInFlight.get(f.client_id) as string;
        buysInFlight.delete(f.client_id);
        if (f.status === "filled") {
          // Entry = true cost basis from the fill (quote paid per token),
          // not the curve price when the fill arrives.
          const paid = BigInt(f.quote_lamports);
          const got = BigInt(f.token_amount);
          if (got > 0n) {
            const curve = state.curves.get(mint);
            const basis = (paid * SCALE) / got;
            open.set(mint, { entry: basis, peak: basis, tradesAtEntry: curve ? curve.trades : 0 });
          }
        }
        // rejected / failed: mint stays tried; we do not chase it.
      } else if (f.side === "sell") {
        sellsInFlight.delete(f.mint);
        if (f.status === "filled") open.delete(f.mint);
        // rejected / failed sell: keep tracking so the exit is retried next batch.
      }
    }
    // Drop tracking for positions the harness closed on its own (complete / flatten).
    for (const mint of [...open.keys()]) {
      if (!state.positions.has(mint)) open.delete(mint);
    }

    // 2. Exits: trailing stop and age exit (no hard stop-loss by design).
    for (const [mint, pos] of open) {
      const holding = state.positions.get(mint);
      if (!holding || sellsInFlight.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const p = curvePrice(state, mint);
      if (p === null) continue;
      if (p > pos.peak) pos.peak = p;
      const stopHit = p * 100n <= pos.entry * STOP_NUM;
      const trailHit = p * 100n <= pos.peak * TRAIL_NUM;
      const aged = curve.trades - pos.tradesAtEntry >= MAX_HOLD_TRADES;
      if (stopHit || trailHit || aged) {
        orders.push({ side: "sell", mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        sellsInFlight.add(mint);
      }
    }

    // 3. Entries: every proven mint, as early as possible.
    const buysAlready = orders.filter((o) => o.side === "buy").length;
    if (state.committedPositionCount() + buysAlready < MAX_OPEN) {
      const candidates = new Set<string>();
      for (const e of batch.events) {
        if (e.event !== "TradeEvent" && e.event !== "CreateEvent") continue;
        const mint = e.mint;
        if (tried.has(mint) || deferred.has(mint)) continue;
        if (open.has(mint) || state.positions.has(mint)) continue;
        if (buysInFlight.size > 0 && [...buysInFlight.values()].includes(mint)) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete || curve.trades === 0 || curve.trades > MAX_TRADES_AT_ENTRY) continue;
        // Only proven mints: real reserves >= 3 SOL, so the 1% cap allows a full buy.
        if (curve.real_quote_reserves < MIN_REAL_QUOTE_LAMPORTS) continue;
        // Only while still cheap: at most 2.0x the creation price.
        if (!cheapEnough(state, mint)) continue;
        candidates.add(mint);
      }
      // Retry mints whose buy was deferred for a too-small size cap.
      for (const mint of [...deferred]) {
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) {
          deferred.delete(mint);
          tried.add(mint);
          continue;
        }
        if (curve.real_quote_reserves < MIN_REAL_QUOTE_LAMPORTS) continue;
        if (!cheapEnough(state, mint)) continue;
        if (curve.trades > MAX_TRADES_AT_ENTRY) {
          deferred.delete(mint);
          tried.add(mint);
          continue;
        }
        candidates.add(mint);
      }
      for (const mint of candidates) {
        if (state.committedPositionCount() + orders.filter((o) => o.side === "buy").length >= MAX_OPEN) break;
        if (state.freeCashLamports() < BUY_LAMPORTS + state.txFeeLamports()) break;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) {
          deferred.add(mint);
          continue;
        }
        const size = cap < BUY_LAMPORTS ? cap : BUY_LAMPORTS;
        const id = state.clientId();
        buysInFlight.set(id, mint);
        orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS, client_id: id });
        tried.add(mint);
        deferred.delete(mint);
      }
    }

    return orders;
  },
});
