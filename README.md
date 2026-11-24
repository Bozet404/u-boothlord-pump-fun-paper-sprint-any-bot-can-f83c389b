[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Bozet404/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Bozet404/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — Momentum Bot

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program, `main.ts` (Node 22), no dependencies, no network, no real money — it only talks to the replay harness over stdin/stdout.

## Strategy

Most fresh pump.fun coins dump after their first micro-pump, so buying early loses money. This bot waits for the survivors and buys in two stages:

- **Stage 1:** once a coin holds **≥ 48 SOL of real reserves** (it survived the early dump phase), its price sits **≥ 20% above** its first-seen price, real reserves are still growing, and the latest trade is a buy — open a small **0.10 SOL** position. This stage alone clears the 20-coin guardrail.
- **Stage 2 (top-up):** if the coin keeps climbing to **≥ 55 SOL** of real reserves, add **0.40 SOL** more, for **0.50 SOL** total. A coin that never proves itself stays a small bet; a proven one gets full size.
- **Exits:** small positions sell at **+50% / −20%**; topped-up positions at **+40% / −30%**; any position sells after **20000 slots** held, or when the bonding curve completes.
- Sells use the exact token balance the harness reports, so positions close to zero and leave no dust.

The bot is fully deterministic: no randomness, no clock, no network calls. The same replay always produces the same orders.

## Run locally

```sh
node main.ts
```

It reads NDJSON (`hello` / `batch` / `done`) on stdin and writes one `{"type":"reply","seq":...,"orders":[...]}` line per batch on stdout.

## License

MIT — see [LICENSE](LICENSE).
