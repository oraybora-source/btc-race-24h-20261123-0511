// Four-hour trend rider for cbBTC (agent-fun/bars-replay/v1), long only.
//
// The idea, in one sentence: buy the whole stake once cbBTC has risen 1% over
// the last four hours, then hold it to the end of the window unless equity
// falls 4% from its peak since entry.
//
// Why this shape, and what was rejected (measured on the kit's own data):
// - A full round trip costs about 26-40 bps (4 bps fee + 2 bps slippage +
//   price impact on each side), while a typical 1-minute move is ~8 bps of
//   noise. Fast signals (EMA 8/21 crosses, RSI/Bollinger, Donchian) trade
//   6-76 times per day and lose money on BOTH test windows: the dev window
//   (22-23 Nov, BTC +3.64%) and the previous race's dev window (14-15 Nov,
//   BTC -4.01%). See the notes folder's search logs for the numbers.
// - This rider trades once per window: dev +21.00 USDC (1 trade, max
//   drawdown 1.98%) and previous window +3.08 USDC (1 trade, max drawdown
//   2.60%). Both windows positive, both drawdowns far under the 25%
//   guardrail. The 4-hour lookback is long enough that a single leg of the
//   market, not minute noise, triggers the entry.
// - The trailing stop (400 bps from peak equity) never fired on either test
//   window; it is insurance against a sharp reversal in the unseen live
//   window, not a tuned parameter.
// - Late-window insurance: from batch 1200 on, ANY positive 4-hour return
//   also buys. This changes nothing on either test window (the strong signal
//   had already fired on dev, and the 4-hour return stayed negative late on
//   the falling window), but it keeps the bot from ending a flat live window
//   with zero trades, which would fail the race guardrail (at least 1 trade)
//   and forfeit any prize. A mid-window weak entry was tested and REJECTED:
//   it turned the falling window from +3.08 into -39.10 USDC.
//
// Determinism: every decision is exact bigint arithmetic over closes the bot
// has already been sent. No clock, no environment, no randomness, no network,
// no files outside the repository. A gap minute (no CBBTC bar in the batch)
// is skipped: no decision is taken on stale data.
// Risk limits, written explicitly: one open position, at most 100% of equity
// (the harness cap), whole stake in or out, trailing stop 400 bps from peak
// equity since entry, 60-bar cooldown before re-entering after an exit,
// max slippage 150 bps per order.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Four hours of 1-minute bars. */
const LOOKBACK_BARS = 240;
/** Enter when the close tops its close 240 bars ago by this much (bps). */
const ENTRY_BPS = 100;
/** Exit when equity falls this far (bps) from its peak since entry. */
const TRAIL_BPS = 400;
/** Do not re-enter within this many bars of an exit. */
const COOLDOWN_BARS = 60;
/** From this batch on, any positive 4-hour return also buys (see header). */
const WEAK_AFTER_SEQ = 1200;
/** Per-order slippage cap, measured from the latest close (bps). */
const MAX_SLIPPAGE_BPS = 150;

/** Closes of CBBTC as they arrive, oldest first. */
const closes: bigint[] = [];
/** Peak equity (cash + position at the close) since the current entry. */
let peakEquity: bigint | null = null;
/** Batch seq of the last exit; entries are blocked for COOLDOWN_BARS after it. */
let lastExitSeq = -1000000;

/** The close 240 bars ago, or null while history is still shorter than that. */
function fourHoursAgo(): bigint | null {
  if (closes.length <= LOOKBACK_BARS) return null;
  return closes[closes.length - 1 - LOOKBACK_BARS];
}

await runBars({
  onBatch(state: BarsState, batch) {
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const equity = state.equity;
      if (peakEquity === null || equity > peakEquity) peakEquity = equity;
      if (equity * 10000n < peakEquity * BigInt(10000 - TRAIL_BPS)) {
        peakEquity = null;
        lastExitSeq = state.seq;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: look for an entry.
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    const ago = fourHoursAgo();
    if (ago === null) return [];
    const strong = close * 10000n > ago * BigInt(10000 + ENTRY_BPS);
    const weak = state.seq >= WEAK_AFTER_SEQ && close > ago;
    if (!strong && !weak) return [];
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    let notional = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional < minNotional) return [];
    peakEquity = null;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
