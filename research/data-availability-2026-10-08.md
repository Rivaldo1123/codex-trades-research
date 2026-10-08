# Deriv public-data availability probe — 2026-10-08

This was a read-only, unauthenticated probe of the Deriv public WebSocket endpoint.
It did not configure Deriv Bot, authenticate an account, request an executable
account quote, or place an order.

At 2026-10-08T12:41:08Z, 1HZ100V, 1HZ50V, and R_100 were returned as active
symbols. Bounded ticks_history requests returned genuine rows near 90, 180, and
365 days before the probe for all three symbols. This establishes point
availability only; it does not establish complete or gap-free coverage.

The contracts_for request returned Rise/Fall (CALL/PUT) tick contracts with a
stated range of 1–10 ticks for all three probed symbols. It also returned
intraday and daily products, which are outside this batch.

A representative 1HZ100V request asked for 5,000 ticks over a bounded two-hour
interval 90 days back. The service returned 1,000 rows in about 3.13 seconds.
The 90-day one-second target therefore needs roughly 7,776 pages from empty, or
roughly 5,184 additional pages beyond the existing 30-day archive. At the
collector's conservative three-second inter-request delay plus observed request
time, the additional backfill estimate is about 8.8 hours.

The initial universe is limited to 1HZ100V: it already has a checksummed
30-day archive, its one-second cadence matches the validated pipeline, and the
4 GB / 2-core machine should not duplicate 90-day tick archives across several
symbols before one is fully audited. Cross-symbol replication remains a later
validation step, not extra configurations in the initial count.

Official API references:

- <https://developers.deriv.com/docs/data/ticks-history/>
- <https://developers.deriv.com/docs/data/contracts-for/>
