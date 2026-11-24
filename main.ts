// Pump.fun Paper Sprint — two-stage late-curve bot (main.ts, Node 22).
//
// Strategy, in plain words:
//   * Most fresh pump.fun coins dump after their first micro-pump, so
//     buying early loses money. The coins that keep attracting real
//     money are different, so this bot buys in two stages.
//   * Stage 1: once a coin holds at least 48 SOL of real reserves, its
//     price sits at least 20% above where it was first seen, real
//     reserves are still growing, and the latest trade is a buy, open a
//     small 0.10 SOL position. This stage alone already clears the
//     guardrail of 20 distinct coins.
//   * Stage 2 (top-up): if that coin keeps climbing and reaches 55 SOL
//     of real reserves, add 0.40 SOL more, for 0.50 SOL total. A coin
//     that never proves itself stays a small bet; a proven one gets
//     full size. The take-profit / stop-loss switch to the full-size
//     levels after a top-up.
//   * Exits: small positions sell at +50% / -20%; topped-up positions
//     at +40% / -30%; any position sells after 20000 slots held, or
//     when the bonding curve completes.
//   * Sells always use the exact token balance the harness reports, so a
//     position closes to zero and never leaves dust behind.
//
// The bot is deterministic: no randomness, no clock, no network. It only
// reads the harness NDJSON protocol on stdin (hello / batch / done) and
// answers each batch with one reply line on stdout.

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- Tunable strategy numbers ---------------------------------------------
// Stage 1: 48 SOL of real reserves means the coin survived the early dump
// phase; stage 2 at 55 SOL means it is deep into its curve and close to
// completing. Sizes are capped so a buy never exceeds 1% of real reserves
// (the harness cap) — 0.9% of real reserves is used for sizing.
const RISE_TO_ENTER = 1.2; // price at least 20% above first-seen price
const MIN_TRADES_BEFORE_ENTRY = 3; // ignore a coin until 3 trades seen
const ENTRY_REAL_SOL = 48n * LAMPORTS_PER_SOL; // stage 1 needs >= 48 SOL
const TOPUP_REAL_SOL = 55n * LAMPORTS_PER_SOL; // stage 2 needs >= 55 SOL
const INFLOW_TO_ENTER = 1.1; // real SOL reserves up 10% since first trade
const SMALL_BUY_LAMPORTS = 100_000_000n; // stage 1 size: 0.10 SOL
const FULL_BUY_LAMPORTS = 500_000_000n; // total size after top-up: 0.50 SOL
const MIN_BUY_LAMPORTS = 20_000_000n; // never spend less than 0.02 SOL
const BUY_BPS_OF_REAL_RESERVE = 90; // size = 0.9% of real SOL reserves
const MAX_OPEN_POSITIONS = 4; // harness allows 5; keep one slot spare
const SMALL_TAKE_PROFIT = 0.5; // small positions sell at +50%
const SMALL_STOP_LOSS = -0.2; // small positions sell at -20%
const TAKE_PROFIT = 0.4; // topped-up positions sell at +40%
const STOP_LOSS = -0.3; // topped-up positions sell at -30%
const MAX_HOLD_SLOTS = 20000; // sell after ~2.2 hours of holding
const SLIPPAGE_BPS = 1000; // allow 10% slippage on fills
const CASH_BUFFER_LAMPORTS = 50_000_000n; // keep 0.05 SOL cash spare

// --- Small helpers ---------------------------------------------------------

type Lamports = bigint;

function toBig(value: unknown): Lamports {
  if (typeof value === "string") return BigInt(value);
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return 0n;
}

// Price of one token in lamports, from virtual reserves (a float ratio is
// plenty precise for comparing percentage moves).
function priceOf(virtualSol: unknown, virtualTokens: unknown): number {
  const sol = Number(toBig(virtualSol));
  const tokens = Number(toBig(virtualTokens));
  if (tokens <= 0) return 0;
  return sol / tokens;
}

// --- Per-coin bookkeeping ---------------------------------------------------

interface CoinState {
  firstPrice: number;
  firstSlot: number;
  lastPrice: number;
  lastRealSol: Lamports;
  firstRealSol: Lamports;
  tradesSeen: number;
  lastWasBuy: boolean;
  completed: boolean;
  bought: boolean; // a buy of ours filled on this coin
}

interface HeldPosition {
  tokens: Lamports;
  costLamports: Lamports;
  entrySlot: number;
  investedLamports: Lamports; // sum of buy quotes so far (excludes fees)
  toppedUp: boolean;
  takeProfit: number;
  stopLoss: number;
}

const coins = new Map<string, CoinState>();
const held = new Map<string, HeldPosition>();
const pendingBuys = new Map<string, string>(); // mint -> client_id
const pendingTopups = new Map<string, string>(); // mint -> client_id
const pendingSells = new Map<string, string>(); // mint -> client_id
// Buy quotes per mint, tracked separately from positions: a fill can be
// reported in a batch before the position shows up in the account, so the
// invested total must survive that gap (it sizes the top-up).
const investedByMint = new Map<string, Lamports>();

let cashLamports = 0n;
let currentSlot = 0;
let buyCounter = 0;
let sellCounter = 0;

function coinState(mint: string): CoinState {
  let state = coins.get(mint);
  if (!state) {
    state = {
      firstPrice: 0,
      firstSlot: currentSlot,
      lastPrice: 0,
      lastRealSol: 0n,
      firstRealSol: 0n,
      tradesSeen: 0,
      lastWasBuy: false,
      completed: false,
      bought: false,
    };
    coins.set(mint, state);
  }
  return state;
}

// --- Order builders ---------------------------------------------------------

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

function buyOrder(mint: string, quoteLamports: Lamports): Order {
  buyCounter += 1;
  const id = `b-${buyCounter}`;
  pendingBuys.set(mint, id);
  return {
    side: "buy",
    client_id: id,
    mint,
    quote_lamports: quoteLamports.toString(),
    max_slippage_bps: SLIPPAGE_BPS,
  };
}

function topupOrder(mint: string, quoteLamports: Lamports): Order {
  buyCounter += 1;
  const id = `b-${buyCounter}`;
  pendingTopups.set(mint, id);
  return {
    side: "buy",
    client_id: id,
    mint,
    quote_lamports: quoteLamports.toString(),
    max_slippage_bps: SLIPPAGE_BPS,
  };
}

function sellOrder(mint: string, tokenAmount: Lamports): Order {
  sellCounter += 1;
  const id = `s-${sellCounter}`;
  pendingSells.set(mint, id);
  return {
    side: "sell",
    client_id: id,
    mint,
    token_amount: tokenAmount.toString(),
    max_slippage_bps: SLIPPAGE_BPS,
  };
}

// --- Batch handling ---------------------------------------------------------

function applyFills(fills: unknown): void {
  if (!Array.isArray(fills)) return;
  for (const fill of fills) {
    if (typeof fill !== "object" || fill === null) continue;
    const entry = fill as Record<string, unknown>;
    const clientId = String(entry.client_id ?? "");
    const mint = String(entry.mint ?? "");
    const side = String(entry.side ?? "");
    const status = String(entry.status ?? "");
    if (side !== "buy") {
      if (side === "sell" && pendingSells.get(mint) === clientId) {
        pendingSells.delete(mint);
      }
      continue;
    }
    if (pendingBuys.get(mint) === clientId) {
      pendingBuys.delete(mint);
      if (status === "filled") {
        const state = coinState(mint);
        state.bought = true;
        const quote = toBig(entry.quote_lamports);
        investedByMint.set(
          mint,
          (investedByMint.get(mint) ?? 0n) + quote,
        );
      }
    } else if (pendingTopups.get(mint) === clientId) {
      pendingTopups.delete(mint);
      if (status === "filled") {
        const quote = toBig(entry.quote_lamports);
        investedByMint.set(
          mint,
          (investedByMint.get(mint) ?? 0n) + quote,
        );
        const position = held.get(mint);
        if (position) {
          position.investedLamports = investedByMint.get(mint) ?? 0n;
          position.toppedUp = true;
          position.takeProfit = TAKE_PROFIT;
          position.stopLoss = STOP_LOSS;
        }
      }
      // A rejected or failed top-up leaves toppedUp false, so the bot
      // retries it on a later batch while the coin still qualifies.
    }
  }
}

function applyAccount(account: unknown): void {
  if (typeof account !== "object" || account === null) return;
  const record = account as Record<string, unknown>;
  cashLamports = toBig(record.cash_lamports);
  const positions = Array.isArray(record.positions) ? record.positions : [];
  const seen = new Set<string>();
  for (const raw of positions) {
    if (typeof raw !== "object" || raw === null) continue;
    const pos = raw as Record<string, unknown>;
    const mint = String(pos.mint ?? "");
    if (!mint) continue;
    seen.add(mint);
    const tokens = toBig(pos.token_amount);
    const cost = toBig(pos.cost_lamports);
    const invested = investedByMint.get(mint) ?? 0n;
    const existing = held.get(mint);
    if (existing) {
      existing.tokens = tokens;
      existing.costLamports = cost;
      existing.investedLamports = invested;
      if (!existing.toppedUp && invested >= FULL_BUY_LAMPORTS) {
        existing.toppedUp = true;
        existing.takeProfit = TAKE_PROFIT;
        existing.stopLoss = STOP_LOSS;
      }
    } else {
      const toppedUp = invested >= FULL_BUY_LAMPORTS;
      held.set(mint, {
        tokens,
        costLamports: cost,
        entrySlot: currentSlot,
        investedLamports: invested,
        toppedUp,
        takeProfit: toppedUp ? TAKE_PROFIT : SMALL_TAKE_PROFIT,
        stopLoss: toppedUp ? STOP_LOSS : SMALL_STOP_LOSS,
      });
    }
  }
  // Positions the harness closed (complete / end of data) drop out here.
  for (const mint of [...held.keys()]) {
    if (!seen.has(mint)) {
      held.delete(mint);
      investedByMint.delete(mint);
      pendingSells.delete(mint);
      pendingTopups.delete(mint);
    }
  }
}

function applyMarks(marks: unknown): void {
  if (!Array.isArray(marks)) return;
  for (const raw of marks) {
    if (typeof raw !== "object" || raw === null) continue;
    const mark = raw as Record<string, unknown>;
    const mint = String(mark.mint ?? "");
    if (!mint) continue;
    const state = coinState(mint);
    const price = priceOf(
      mark.virtual_quote_reserves,
      mark.virtual_token_reserves,
    );
    if (price > 0) {
      if (state.firstPrice === 0) {
        state.firstPrice = price;
        state.firstSlot = currentSlot;
      }
      state.lastPrice = price;
    }
    state.lastRealSol = toBig(mark.real_quote_reserves);
  }
}

function applyEvents(events: unknown): void {
  if (!Array.isArray(events)) return;
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const event = raw as Record<string, unknown>;
    const kind = String(event.event ?? "");
    const mint = String(event.mint ?? "");
    if (!mint) continue;
    const state = coinState(mint);

    if (kind === "CreateEvent") {
      const price = priceOf(
        event.virtual_sol_reserves,
        event.virtual_token_reserves,
      );
      if (price > 0 && state.firstPrice === 0) {
        state.firstPrice = price;
        state.firstSlot = currentSlot;
      }
      if (price > 0) state.lastPrice = price;
      // CreateEvent carries no real SOL reserves; keep the last known value.
    } else if (kind === "TradeEvent") {
      const price = priceOf(
        event.virtual_sol_reserves,
        event.virtual_token_reserves,
      );
      if (price > 0) {
        if (state.firstPrice === 0) {
          state.firstPrice = price;
          state.firstSlot = currentSlot;
        }
        state.lastPrice = price;
      }
      const realSol = toBig(event.real_sol_reserves);
      if (state.firstRealSol === 0n) state.firstRealSol = realSol;
      state.lastRealSol = realSol;
      state.tradesSeen += 1;
      state.lastWasBuy = event.is_buy === true;
    } else if (kind === "CompleteEvent") {
      state.completed = true;
    }
  }
}

// --- Decisions ---------------------------------------------------------------

function decideExits(orders: Order[]): void {
  for (const [mint, position] of held) {
    if (pendingSells.has(mint)) continue;
    if (position.tokens <= 0n) continue;
    const state = coins.get(mint);
    if (!state) continue;

    // A completed bonding curve is closed by the harness; try to sell
    // first so the exit happens at the last live price, and if the
    // harness rejects it the auto-close still settles the position.
    if (state.completed) {
      orders.push(sellOrder(mint, position.tokens));
      continue;
    }

    // Average entry price from the harness-reported cost basis, so a
    // topped-up position is judged on its blended cost.
    const entryPrice = Number(position.costLamports) / Number(position.tokens);
    if (entryPrice <= 0) continue;
    const currentPrice = state.lastPrice;
    if (currentPrice <= 0) continue;
    const ret = currentPrice / entryPrice - 1;

    if (ret >= position.takeProfit || ret <= position.stopLoss) {
      orders.push(sellOrder(mint, position.tokens));
      continue;
    }
    if (currentSlot - position.entrySlot >= MAX_HOLD_SLOTS) {
      orders.push(sellOrder(mint, position.tokens));
    }
  }
}

function decideTopups(orders: Order[]): void {
  for (const [mint, position] of held) {
    if (orders.length >= 16) break;
    if (position.toppedUp) continue;
    if (pendingTopups.has(mint)) continue;
    if (pendingSells.has(mint)) continue;
    const state = coins.get(mint);
    if (!state || state.completed) continue;
    if (state.lastRealSol < TOPUP_REAL_SOL) continue;
    if (state.firstPrice <= 0 || state.lastPrice <= 0) continue;
    if (state.lastPrice < state.firstPrice * RISE_TO_ENTER) continue;

    const add = FULL_BUY_LAMPORTS - position.investedLamports;
    if (add < MIN_BUY_LAMPORTS) continue;
    if (cashLamports < add + CASH_BUFFER_LAMPORTS) continue;

    orders.push(topupOrder(mint, add));
    cashLamports -= add;
  }
}

function decideEntries(orders: Order[]): void {
  if (held.size + pendingBuys.size >= MAX_OPEN_POSITIONS) return;
  for (const [mint, state] of coins) {
    if (held.size + pendingBuys.size >= MAX_OPEN_POSITIONS) break;
    if (orders.length >= 16) break;
    if (state.completed) continue;
    if (state.bought) continue;
    if (held.has(mint)) continue;
    if (pendingBuys.has(mint)) continue;
    if (state.tradesSeen < MIN_TRADES_BEFORE_ENTRY) continue;
    if (state.firstPrice <= 0 || state.lastPrice <= 0) continue;
    if (state.lastPrice < state.firstPrice * RISE_TO_ENTER) continue;
    // Real money must still be flowing in, and the latest trade a buy.
    if (state.firstRealSol <= 0n) continue;
    if (Number(state.lastRealSol) < Number(state.firstRealSol) * INFLOW_TO_ENTER) continue;
    if (!state.lastWasBuy) continue;
    // The deep-curve filter: only coins holding 48+ SOL of real reserves.
    if (state.lastRealSol < ENTRY_REAL_SOL) continue;

    // Size: 0.9% of real reserves, capped at the small stage size.
    // The 0.9% also stays under the harness cap of 1% of real reserves.
    let size =
      (state.lastRealSol * BigInt(BUY_BPS_OF_REAL_RESERVE)) / 10000n;
    if (size > SMALL_BUY_LAMPORTS) size = SMALL_BUY_LAMPORTS;
    if (size < MIN_BUY_LAMPORTS) continue;
    if (cashLamports < size + CASH_BUFFER_LAMPORTS) continue;

    orders.push(buyOrder(mint, size));
    cashLamports -= size;
  }
}

function handleBatch(message: Record<string, unknown>): Order[] {
  currentSlot = typeof message.slot === "number" ? message.slot : currentSlot;
  applyFills(message.fills);
  applyAccount(message.account);
  applyMarks(message.marks);
  applyEvents(message.events);

  const orders: Order[] = [];
  decideExits(orders);
  decideTopups(orders);
  decideEntries(orders);
  return orders;
}

// --- Main loop ---------------------------------------------------------------

let buffer = "";

function handleLine(line: string): void {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null) return;
  const record = message as Record<string, unknown>;
  const kind = String(record.type ?? "");

  if (kind === "hello") {
    if (typeof record.capital === "object" && record.capital !== null) {
      cashLamports = toBig(
        (record.capital as Record<string, unknown>).lamports,
      );
    }
    return;
  }

  if (kind === "done") {
    process.exit(0);
  }

  if (kind !== "batch") return;
  const seq = typeof record.seq === "number" ? record.seq : 0;
  let orders: Order[] = [];
  try {
    orders = handleBatch(record);
  } catch (error) {
    process.stderr.write(`batch ${seq} error: ${String(error)}\n`);
    orders = [];
  }
  process.stdout.write(
    JSON.stringify({ type: "reply", seq, orders }) + "\n",
  );
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (buffer.trim()) handleLine(buffer);
  process.exit(0);
});
