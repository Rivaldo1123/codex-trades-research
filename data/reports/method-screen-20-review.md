# Twenty-method research screen: Volatility 100 (1s)

This is a development screen on the already viewed 30-day `1HZ100V` archive, `[2026-09-06T04:00:00Z, 2026-10-06T04:00:00Z)`. The archive has 2,591,993 genuine seconds and the same seven absent seconds previously reported. The fixed definitions, one-open-contract rule, five-tick expiry, 1/2/3-tick entry delays, payout assumptions, and chronological 70/15/15 split are in `data/market/method-screen-20-v1.json` (SHA-256 `d050e41582df2490095b6027fb490ec2e95c8e694a88f3416634b08736d99634`). The full 180-scenario ledger is in `data/reports/method-screen-20-1HZ100V-1788667200-1791259200.json`.

Methods use indicator types available as Deriv Bot blocks: SMA, EMA, Bollinger Bands, RSI, and MACD. Each rule has a specific Rise, Fall, and abstain condition in the catalog. The families separate trend following, countertrend, fresh crossovers, Bollinger breakouts and re-entry, RSI extremes, and two-indicator confirmation. Stake progression systems were excluded because they alter loss size rather than the price signal.

These are 20 operational rules, not 20 independent sources of predictive information. Several share the same underlying indicator and differ in direction or trigger timing. That overlap makes a ranked top three less diverse than the count alone suggests.

The table ranks by the **worst** middle-segment average return across the three entry delays at an assumed +$0.80 per $1 win and -$1.00 per loss or tie. The late segment is shown as a stability check; it was already viewed and is not a pristine final test. Percentages are modeled average return per $1 staked, not realized profit.

| Rank | Fixed method | Middle worst | Late worst | Minimum middle trades per delay |
|---:|---|---:|---:|---:|
| 1 | MACD 12/26/9 fresh signal cross | -10.44% | -10.46% | 20,486 |
| 2 | SMA 20/50 countertrend | -10.55% | -11.13% | 43,194 |
| 3 | Bollinger 20/2 reversal | -10.59% | -11.78% | 17,211 |
| 4 | MACD 12/26/9 signal sign | -10.60% | -10.56% | 43,196 |
| 5 | EMA 12/26 countertrend | -10.75% | -11.26% | 43,197 |
| 6 | Bollinger 20/2 re-entry | -10.80% | -12.81% | 16,930 |
| 7 | SMA 10/20 countertrend | -10.93% | -11.33% | 43,197 |
| 8 | RSI 14 center cross | -11.03% | -11.33% | 18,731 |
| 9 | RSI 14 extreme exit | -11.04% | -11.80% | 7,474 |
| 10 | RSI 14 extreme reversal | -11.18% | -12.64% | 8,726 |
| 11 | Bollinger plus RSI confirmation | -11.23% | -12.32% | 5,722 |
| 12 | SMA 20/50 trend | -11.32% | -11.07% | 43,194 |
| 13 | SMA 10/20 trend | -11.39% | -10.68% | 43,197 |
| 14 | EMA 12/26 trend | -11.41% | -10.83% | 43,197 |
| 15 | SMA plus RSI confirmation | -11.75% | -10.89% | 40,630 |
| 16 | Bollinger 20/2 breakout | -11.83% | -10.84% | 17,211 |
| 17 | EMA 12/26 fresh cross | -11.84% | -10.87% | 10,501 |
| 18 | SMA 20/50 fresh cross | -11.86% | -11.19% | 8,073 |
| 19 | SMA 10/20 fresh cross | -12.23% | -11.32% | 16,821 |
| 20 | RSI 14 extreme trend | -12.87% | -11.59% | 8,726 |

## The three least negative rules

- **MACD fresh cross:** Rise only when the MACD line crosses above its signal line; Fall only when it crosses below. At 1/2/3-tick entry delay, middle-segment win rates were 49.80% / 49.92% / 49.76%, with modeled returns of -10.36% / -10.15% / -10.44% per stake. The late segment was also negative for all delays.
- **SMA countertrend:** Rise while SMA20 is below SMA50; Fall while SMA20 is above SMA50. The three middle win rates were 49.74% / 49.69% / 49.72%, and returns were -10.47% / -10.55% / -10.50%. The late segment remained negative.
- **Bollinger reversal:** Rise below the lower 20-period, 2-SD band; Fall above the upper band. The three middle win rates were 49.97% / 50.00% / 49.67%, and returns were -10.06% / -10.00% / -10.59%. The late segment remained negative.

At +$0.80 per $1 won and -$1.00 per loss, break-even requires a 55.56% win rate. All 60 primary-payout scenarios were negative in the middle and late segments. The same is true for all 60 scenarios at +$0.70 and all 60 at +$0.90. No method passed the predefined development screen. **The three names above are the least negative, not an optimum trading set.**

Deriv notes that synthetic indices may be poorly suited to technical indicators and that apparent historical patterns may be coincidental. The replay also lacks observed executable payouts and verified Bot Builder indicator/tick timing. The decision is **NO TRADE**. The next meaningful test is platform parity and actual payout observation, followed by a separately frozen rule on genuinely new forward data only if a candidate clears a development screen. Further parameter searches on this same viewed archive would not supply an independent result.

Sources: [Deriv Bot indicator blocks](https://experts.deriv.com/insights/how-to-use-technical-analysis-tools-on-derivs-trading-bot); [Deriv synthetic indices FAQ](https://deriv.com/markets/derived-indices/synthetic-indices?ae675f24_page=2).
