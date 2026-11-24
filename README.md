# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![Pump.fun Replay Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Ahmadmukafi/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-r2/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Ahmadmukafi/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-r2/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

## Strategy — proven-mint swing with a loose trailing exit

Most fresh mints are untradable noise: buying every mint loses ~7% per round trip after the 2-slot fill delay and fees, because the bot buys the top of the opening spike and sells the pullback. The edge that survives is narrow: only buy a mint once it has proven itself (real reserves >= 3 SOL, so the 1% order cap allows a full 0.05 SOL buy) and only while it is still cheap (price at most 2x its creation price — entries above 2x are the worst losers, the -60% crashes). Then hold with a loose trailing stop (-35% from peak) and a 90-trade age exit, and no hard stop-loss: the winners are the mints that survive 90 trades without a -35% pullback (they bank +56% to +172%), while tight stops just bleed -18% per exit through the fill delay.

## r2

r1 was rejected only because the server's dev grade timed out; every other check passed. r2 re-enters the same proven strategy. One targeted improvement was tried — waiting one batch after a mint's CreateEvent before buying — and graded worse locally (+0.1056 SOL vs r1's +0.1273 SOL), so it was reverted; r2 keeps r1's exact logic, re-implemented.

## Local dev result (kit grade-local, --driver process)

- Net PnL: **+127,314,289 lamports (+0.1273 SOL)**
- 43 fills, 24 round trips over 24 distinct mints, win rate 45.8%, max drawdown 0.9%
- Deterministic: two independent grade-local runs produce byte-identical action logs (sha256 `e192be88…`) and identical result sha256
