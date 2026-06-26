# QUORUM — distributing the cheap debater seats to worker nodes

**Status:** design — **decisions LOCKED.** Reuse the `inference` capability for distributable debater seats; the premium **judge is house-held in-broker, permanently** (never distributed); debater seats are open + one-owner-per-panel; routing falls out of the existing `tier` field (cheap → grid, premium → house). No code in this doc.
**Owner surface:** `src/broker/agents/deliberate.mjs`, `src/broker/server.mjs`, `src/broker/scheduler.mjs`, `src/broker/reputation.mjs`, `src/broker/validator.mjs`.
**Flag:** `MOLT_QUORUM_GRID=1` (default OFF) enables distribution; `MOLT_QUORUM_SEAT_TIMEOUT_MS` tunes the per-seat dispatch deadline before broker-local fallback.

---

## 1. Summary / motivation

Today a "quorum discussion" runs **entirely inside the broker process**. `deliberate({ question, context, decisions, infer })` (`src/broker/agents/deliberate.mjs:105`) executes a fixed DAG: three cheap-model personas (`pessimist` / `optimist` / `realist`) open, then rebut; a utilitarian `skeptic` heckles the whole debate; a single **premium** `judge` reads the transcript and renders a structured verdict (`NODES`, `deliberate.mjs:28-33`). The DAG is run by `runDag` as topological waves over each node's `deps` (`deliberate.mjs:77-91`). Every node is resolved by `runNode`, which calls the injected `infer(...)`; in production that injection is `makeProviderInfer` (`deliberate.mjs:173`), which maps the two tiers onto **local in-process adapters** (`cheap → local`, `premium → bedrock`) and runs them inline via `adapter.run(job, ctx)` (`deliberate.mjs:188`). So the "panel" is not a panel of nodes — it is one process making ~7 cheap calls and 1 premium call to itself.

The header comment already states the intent we are building toward:

> Explicit nodes + deps so the structure is inspectable and **maps 1:1 onto the broker's `job_dependencies` if/when these run as real grid jobs.** Independent nodes run concurrently. (`deliberate.mjs:22-23`)

The architecture anticipates distribution. This doc designs it: **let worker nodes *participate* in quorum discussions by turning the cheap debater seats into claimable grid jobs — while the premium judge stays house-held in the broker, always.** "Participation" means a debater/skeptic seat (`open_pessimist`, `rebut_realist`, `skeptic`) becomes a unit of work a remote worker can `claim`, fill with its own model, and submit — instead of the broker filling every cheap seat itself. The `judge` seat is **never** a grid job: the one seat whose output the broker acts on is run in-broker, every time. `NODES → jobs` (cheap nodes only) and `deps → job_dependencies`; `runDag` becomes an *orchestration* of grid jobs for the debaters, with the judge resolved in-process.

This is attractive (heterogeneous models genuinely debating; spreading the cheap debate load; nodes earning fuel for participation) **and** distributing *any* part of adjudication is the single most dangerous thing this project could do. The locked design keeps the decision-maker in the house precisely because of that — see the threat model next, then §4 for why house-judge is the only safe resting place for the verdict.

---

## 2. Threat model (read this first)

Distributing *adjudication* to arbitrary nodes is **strictly more dangerous than distributing implementation.** An implementation job produces a patch the broker can verify against ground truth — `validateResult` fails CLOSED for `code.implementation` unless L2/L3 actually ran against the worktree (`validator.mjs:85-89`). A deliberation seat produces *an argument or a verdict* — there is no compiler, no test suite, no diff to re-derive. The verdict **is** the ground truth the broker will act on (release/hold/escalate an objective; sanity-check a decomposition). We are handing untrusted nodes a vote on the broker's own judgment.

This project has been here before. The permissionless "open grid" was **REVERTED after a security audit (2026-06-22)** because an anonymous worker could "forge a green review, self-grade, spoof trust/changed_files, and grief reputation" (`server.mjs:695-698`). Worker/job ingress is consequently **default-OFF**, gated behind the explicit `MOLT_OPEN_GRID=1` opt-in (`server.mjs:700-702`). Everything below assumes that posture is the floor, not a starting point to relax — and is exactly why the *binding* seat (the judge) never leaves the broker (§4).

Concrete attacks unique to distributed deliberation:

1. **Panel capture (the headline risk).** One operator claims *multiple seats* in a single deliberation — e.g. `open_pessimist` + `rebut_pessimist` + `judge`, or even both a debater and the judge — and steers the verdict. The cheapest capture is **owning the judge plus one debater**: the judge can simply select the colluding debater's position. Because seats are independent jobs, naive `claim` would happily hand all of them to whoever polls first.

2. **Sybil seats.** The same operator registers N workers (N keypairs) and fills the whole panel, manufacturing a fake "consensus." Reputation already treats a fresh id as `UNPROVEN_PRIOR = 0.3`, deliberately *below* the fuel gate `FUEL.repThreshold = 0.4` (`reputation.mjs:36-38`) — a sybil cannot clear trust gates, but it *can* clear a `trust_required: 0` seat. Panels of zero-trust seats are sybil-fillable by default.

3. **Forged transcripts.** A seat-filler returns text it never reasoned about — a canned "the optimist is correct, release" — or fabricates a usage report to over-bill. The judge downstream reads `done[dep].text` (`deliberate.mjs:51-62`); if that text is attacker-authored, the judge is reasoning over a planted record. Worse, a malicious *judge* can return a verdict whose `rationale`/`winner` don't match the debate it claims to have read.

4. **Judge collusion with debaters.** Even with one-owner-per-seat, if the judge's owner has an out-of-band relationship with a debater's owner (or is the *same* account behind two claimed agents), independence is violated. This mirrors exactly the precedent in `validator.mjs:104-110`: "reviewer not independent of implementer," enforced from the assignment record, never self-report.

5. **Premium-seat fuel abuse.** The judge is the funded **premium** tier (`deliberate.mjs:32`). *If* the judge were a claimable seat, a node holding it would spend team fuel on a Bedrock-class call, and an attacker who could claim judge seats could drain the fuel ledger (`budgetGate`/`meter`, `deliberate.mjs:193,204-205`; `server.mjs:724-735`) by returning garbage. **The locked design removes this attack entirely by keeping the judge house-held (§4)** — there is no judge seat to claim, so no node ever spends team fuel. Listed here because it is the reason the judge stays in the house.

6. **RCE surface.** Implementation jobs already run "untrusted, worker-authored code" — but the broker contains it to a worktree and never trusts its self-report (`validator.mjs:54-59`). Deliberation seats must **not** widen this: a seat is a pure text-in/text-out inference job. It must never carry a patch, a command, or a checkpoint that the broker executes. Keeping deliberation jobs strictly non-`code.*` is a containment boundary.

The design's job is to make panel capture, sybil filling, and judge collusion **structurally impossible to win**, and to keep fuel + RCE exposure bounded — before any of this is reachable by a non-team node.

---

## 3. Independence & anti-capture rules

The enforcement principle is the one already load-bearing in this codebase: **verify-don't-trust.** Every gate value is read from server state — "capabilities/max_slots from the registered manifest row, active_slots from a live count, trust from earned reputation — never from the claim body" (`server.mjs:224-226`). Deliberation seats extend the same rule to *owner identity*.

Rules the broker MUST enforce at `claim` time, per deliberation (call it a `panel_id` shared by all seats of one `deliberate()` run):

- **R1 — One `owner_id` per panel.** A worker may claim **at most one seat** in a given `panel_id`. Owner is read from the worker row (`workers.owner_id`, set from the verified agent credential at registration — `server.mjs:137-141`), never from the claim. This is the anti-capture and anti-sybil core: capture requires owning many *accounts*, and accounts cost stake/identity (`runechain-grid-identity` posture), not a fresh keypair.

- **R2 — Judge independence (vacuous under the locked design; retained as precedent).** With the judge **house-held** (§4), there is no judge *seat* to claim, so judge-vs-debater independence cannot be violated through the grid — it is structurally guaranteed, not enforced at claim time. R2 survives only as the *origin* of R1's enforcement pattern: the direct analogue of `validator.mjs:105` ("reviewer not independent of implementer") and the scheduler's `reviewImplAuthors` gate (`scheduler.mjs:42-52,116`), where the broker derives owners from the *assignment records*, never from self-report. If the judge ever were distributed (it is not — see §9), this is the rule that would gate it.

- **R3 — Distinct-owner quorum floor (debaters only).** A panel verdict is only honored as *distributed* if the cheap debater seats were filled by at least *K distinct owners* (proposed K ≥ 2 distinct debater owners; the judge is the house, not an owner). Below the floor, the panel is treated as not-distributed and falls back (see §6). This prevents "2 sybils + 1 honest" from being dressed up as a real quorum. Because the house judge weighs the debate on merit and can `escalate`, a thin or captured debate degrades to a cautious in-house verdict, never to a hijacked one.

- **R4 — Identity is necessary, not sufficient.** Per `runechain-grid-identity`, agent auth establishes *who* a debater seat-filler is; it does **not** establish that their argument is good. The decisive quality gate is **the house judge itself** (§4) — it weighs the debate on merit and can `escalate` — not a claim-time trust score on the debaters. Independence + identity (R1) bound *capture*; the house judge bounds *quality*.

Enforcement lives in the scheduler's feasibility filter (`claimableJobsFor`, `scheduler.mjs:92`), as new HARD constraints alongside the existing capability/trust/reviewer-independence gates (`scheduler.mjs:114-116`) — computed from server state inside the `claim` transaction so two concurrent claims can't both win the last open seat of a panel.

---

## 4. Capability model (LOCKED: reuse `inference` + house-held judge)

**Recommendation (locked): reuse the existing `inference` capability for distributable debater seats, and keep the premium judge house-held in the broker — there is NO distinct `deliberation` capability.** A distributable seat is a plain `inference` job, tagged with `panel_id` + `seat_role`, claimable by any registered inference-capable node. The judge never becomes a grid job at all.

**Why house-judge is the safety-load-bearing decision (read this).** The seat split follows directly from the threat model (§2). The judge is the *only* seat whose output the broker acts on — it **is** the ground truth (release / hold / escalate). With no separate `deliberation` capability there is also no separate trust ledger to build a judge *gate* on (a distinct-capability design would gate the judge on earned `deliberation` trust; reusing `inference` deliberately throws that knob away). So the question becomes: with no capability-specific gate, where is the *only* safe place for the decision-maker? **The house.** Keeping the judge in-broker means:

- A captured debate can only ever **bias the house judge's inputs** — it can plant arguments, manufacture a fake "consensus," forge a transcript — but it can **never produce the verdict.** The decision-maker is code the team controls, not a claimed seat. Panel capture (threat #1), judge collusion (#4), and premium-fuel abuse via a claimed judge (#5) are not *mitigated*, they are **structurally unreachable**: there is no judge seat to claim.
- The broker's existing verdict normalization (`deliberate.mjs:144-154`) still runs over whatever the debaters submitted, so a forged debate (threat #3) that points at an out-of-set or unparseable conclusion still collapses to `escalate` (`deliberate.mjs:149-150`) — fail-safe, in the house.
- The premium spend stays in-broker (the funded Bedrock judge), so it is fuel-gated before the call and metered after exactly as today (§7) — no node can ever spend team fuel on a judge call, because no node runs the judge.

**Why reuse `inference` rather than a new capability.** The cheap debater seats are pure text-in / text-out inference — that is *literally* what `makeProviderInfer` already builds for them (`capability_required: 'inference'`, `deliberate.mjs:196`). A distinct `deliberation` capability buys a separate trust ledger and an independent judge gate — but **the judge is house-held, so it needs no claim-time trust gate at all**, which removes the main reason the separate capability existed. What's left is pure cost: a manifest change, a new ledger to bootstrap, and a node has to advertise a second capability to participate. Reusing `inference` means *every inference-capable node on the grid can already fill a debater seat* with zero new plumbing. The debater seats are non-binding (the in-house judge weighs them on merit); polluting the inference ledger with "did this node argue well" is a non-issue because debater outcomes are recorded as ordinary reliability events (accepted / dropped — §8), not a separate quality score the judge gate reads. The independence rules in §3 (one-owner-per-panel) — not a capability boundary — are what bound capture.

**Routing falls out of the existing `tier` field — no new metadata.** Each node already carries `tier: 'cheap' | 'premium'` (`deliberate.mjs:28-33`). That single field is the whole routing decision:

- `tier: 'cheap'` (the three `open_*`, three `rebut_*`, and `skeptic`) → **distributable** `inference` job, tagged `panel_id` + `seat_role`, claimable per §3.
- `tier: 'premium'` (the `judge`, the only premium node — `deliberate.mjs:32`) → **in-broker**, never enqueued.

No `capability_required` change (it stays `inference`), no `trust_required` knob on the seats, no new manifest field. The only additions to a dispatched job are the two correlation tags `panel_id` + `seat_role` so the grid infer can route a claimed result back to the right seat of the right panel. The judge's `premium` tier already routes it to the funded in-process Bedrock path and the fuel gate (§7); that path is unchanged.

**The rejected alternatives.**
- *A distinct `deliberation` capability.* Would give a separate trust ledger and an independent judge gate — but the judge is house-held (no claim, no gate), so the gate is moot, and the ledger is pure overhead plus a coupling between deliberation exposure and a new manifest bit. Dropped.
- *Distributing the judge to high-trust nodes (former "phase (b)").* **Overridden.** Even gated on high trust + judge-independence (R2), a distributed judge is still a claimed seat whose verdict the broker acts on — the costliest seat to get wrong, and the one this project's open-grid revert (`server.mjs:695-698`) warns hardest against. The locked posture is: the judge **never** leaves the broker, not even for the highest-trust node. Independence rule R2 (judge-independent-of-debaters) therefore becomes vacuous for the dispatch path and is retained in §3 only as the precedent it descends from (`validator.mjs:104-110`).

---

## 5. Execution mapping

The DAG is *already* the schedulable artifact. The mapping is mechanical:

| In-process today | Distributed |
| --- | --- |
| `NODES` (`deliberate.mjs:28-33`) | one **`inference` job per *cheap* node**, sharing a `panel_id`; the premium `judge` node is **never** enqueued |
| `node.deps` | `job_dependencies` rows (`scheduler.mjs:130-138` already gates a job until every dep is `accepted`) — between cheap seats only |
| `node.tier` (`deliberate.mjs:28-33`) | the routing field: `cheap` → distributable `inference` job; `premium` → in-broker (judge) |
| `seat_role` (= `node.role`) / `node.phase` | carried in the job payload so the seat renders the right `rolePrompt` (`deliberate.mjs:47`) and `SYSTEMS[role]` |
| `runNode` in-process `infer(...)` (cheap) | **enqueue `inference` seat job (tagged `panel_id`+`seat_role`), await claim + completion** |
| `runNode` in-process `infer(...)` (judge) | **unchanged — runs in-broker via `makeProviderInfer`** |

**What changes — `runNode`, for cheap seats only.** Today `runNode` (`deliberate.mjs:123-134`) calls `infer(...)` inline for every node. In distributed mode the injected infer branches on `tier`:
- **`tier: 'cheap'`** → materialize the seat as a grid job with `capability_required: 'inference'` (reused, not a new capability — §4), tagged `panel_id` + `seat_role`, plus `phase` and a `prompt` built from `rolePrompt(node, question, context, done, allowed)`. Note the prompt for `rebut`/`heckle` phases is built from **already-completed** upstream seat outputs (`deliberate.mjs:50-62`), which is exactly why those `deps` must be `accepted` before the dependent seat is claimable. Then await the seat's accepted result and return `{ text, usage }` in the same shape `runDag` already consumes.
- **`tier: 'premium'`** (the judge) → **delegate straight to the in-broker `makeProviderInfer` path** (`deliberate.mjs:187`). The judge never touches the grid.

The cleanest implementation is a **new `infer` provider** — call it `makeGridInfer({ enqueueSeat, awaitResult, fallbackInfer, panelId })` — that wraps `makeProviderInfer` (as `fallbackInfer`) and is injected exactly where `makeProviderInfer` is wired today (`server.mjs:737-740`). For premium-tier calls it simply forwards to `fallbackInfer`; for cheap-tier calls it enqueues a seat and awaits it, falling back to `fallbackInfer` on timeout (§6). `deliberate()`'s signature does not change; only which `infer` it gets — and `deliberate` already threads `panelId`/`seatKey` into every `infer` call (`deliberate.mjs:129`) for exactly this purpose.

**What stays unchanged.**
- `runDag` (`deliberate.mjs:77-91`) — the topological wave executor is provider-agnostic; it doesn't care whether `runNode` awaits an in-process call or a grid completion. Independent seats in a wave (e.g. the three `open_*`) still dispatch concurrently.
- `NODES` / `deps` — the panel shape is unchanged. (Distribution may *add* metadata per node, but the graph is identical.)
- **Verdict normalization** (`deliberate.mjs:144-166`): `extractJson` on the judge's text, the `inSet`/`escalate` collapse, `clamp01`, `escalateVerdict`, `transcriptOf`. Because the judge is house-held (§4) its output is *produced* in-broker too — but the normalization matters even more in distributed mode: it parses and bounds-checks the verdict the house judge formed over **debater-submitted, possibly-forged** transcripts, so a debate that steers the judge toward out-of-set garbage still collapses to `escalate` (`deliberate.mjs:149-150`). This is the first line of defense against forged debates (threat #3) and stays broker-side by construction.

**Seat result shape.** A cheap seat returns `{ text, usage }` (debaters/skeptic); the judge JSON is produced in-broker and never claimed. To defend against forged transcripts (threat #3), cheap-seat results should be treated like any worker submission: schema-checked (an L1-style envelope check, cf. `validator.mjs:41-47`) and the `usage` taken as a *claim*. Cheap seats are not fuel-gated (only the premium judge is — §7), so over-billing exposure is limited to the cheap rate; the house judge's premium spend is metered by the broker's own `estimateCost`, never a worker's self-report (`server.mjs:728-735`).

---

## 6. Liveness & fail-safe

The current design's defining property is that **a broken panel fails SAFE to `escalate`** — never a silent "release" (`deliberate.mjs:139-141`, and the integration agent re-asserts it at `integration-agent.mjs:109-112`). Distribution must preserve this exactly. A grid is less reliable than an in-process call (seats go unclaimed, workers stall, leases expire — the broker already reclaims expired leases and penalizes droppers via `lease_expired`/`dropped`, `reputation.mjs:13-16`).

**Per-seat lease + timeout.** Each seat job gets the standard lease (`DEFAULTS.leaseSeconds`, `server.mjs:248`). If a seat is unclaimed past a *dispatch deadline*, or claimed-but-stalled past its lease, that seat is considered failed.

**Best-effort-distributed (debaters) with broker-local in-process FALLBACK.** This is the key liveness rule. Only the cheap debater seats are distributed; the orchestrator tries to fill each *cheap* seat from the grid, but on seat timeout (`MOLT_QUORUM_SEAT_TIMEOUT_MS`) / unclaimed / distinct-owner-floor-not-met (§3 R3), it **falls back to running that seat in-process** via the existing `makeProviderInfer` path (`deliberate.mjs:187`). Concretely, `makeGridInfer` wraps `makeProviderInfer` and delegates to it whenever a cheap seat can't be sourced from the grid. The **judge is always in-process** — there is nothing to fall back from. Consequences:

- The panel **always completes**, debaters distributed-where-possible and in-process-where-necessary, judge in-process always — so the existing fail-safe-to-`escalate` behavior (`deliberate.mjs:140-141`) is preserved end-to-end. A grid that's empty or hostile degrades to *exactly today's behavior*, not to a hang.
- The one seat whose verdict the broker acts on — the judge — never depended on grid availability in the first place: it is house-held by design (§4), the safest possible posture for the decision-maker.
- A panel that can't even reach a distinct-owner debater quorum (R3) is not a "failed deliberation" — it's a panel whose debaters ran in-process this time, judged in-house as always. No verdict is ever blocked on grid availability.

**Interaction with `MAX_DELIBERATIONS`.** The integration agent already caps full debates per approval event (`MAX_DELIBERATIONS = 8`, `integration-agent.mjs:28,94-98`); beyond it, dependents are *held + surfaced*, not debated. Distribution does not change this outer cap — it bounds how many *panels* spin up. It does add an inner consideration: a distributed panel ties up multiple grid slots for its duration, so the orchestrator should treat a panel as one logical unit against the cap (it already does — one `deliberate()` call == one count). The pre-hold across the multi-second deliberation (`integration-agent.mjs:90-91`) becomes *more* important when seats are remote and slower: the objective stays held for the now-longer panel window so a concurrent `claim` can't leak the dependent's jobs mid-debate.

---

## 7. Fuel & metering

The premium **judge is house-held** (§4), so the entire fuel story for the funded path is **unchanged from today** — and that is the point. The judge runs in-broker via `makeProviderInfer`, which already budget-gates before the premium call and meters after (`deliberate.mjs:193,204-205`; `server.mjs:724-735`). Distribution adds nothing to the funded path because the funded path never leaves the broker.

- **Gate before the judge call (unchanged).** `budgetGate()` throws before the premium judge call so `deliberate` fails safe to `escalate` and the planner falls back to template (`deliberate.mjs:193`). The gate is the same `getBalance(PRIMARY_ACCOUNT) < FUEL.minBalance` check already wired at `server.mjs:724-726`. Because no node ever claims the judge, **threat #5 (premium-seat fuel abuse) is structurally unreachable** — there is no premium seat to dispatch or drain.
- **Meter the judge on completion (unchanged).** The in-broker meter (`meter({ provider, model, usage })`, `server.mjs:728-735`, which calls `estimateCost` + `chargeFuel`) charges the team account for the judge's own Bedrock call. It uses the broker's own `estimateCost`, never a self-report — and since the judge is the broker, there is no external `usage` claim to inflate.
- **Cheap debater seats: cheap-rate payout, no fuel gate.** A distributable debater seat is a plain `inference` job (§4); like any cheap/local inference it is paid out-of-band at the cheap rate, not drawn from the fuel ledger (`server.mjs:720-722`). A payout credited to the seat-filler's owner is the incentive to fill seats. Over-billing exposure is bounded to the cheap rate, and a captured cheap seat still cannot reach the funded path.

Net: the funded judge cannot run without fuel and cannot be over-billed (it is the house); the cheap debater seats pay their fillers at the cheap rate without ever touching the fuel gate.

---

## 8. Reputation for the debater seats

There is **no separate `deliberation` ledger** — debater seats are `inference` jobs (§4), so they accrue reputation on the existing **`inference` capability**, reusing the machinery in `reputation.mjs` (`recordEvent`, `trustScore`, the Laplace `(accepted+1)/(total+2)`). The standard reliability events apply per seat — `accepted` (+1), `dropped` (−1), `lease_expired` (−0.75), `resumed_successfully` (+0.5) (`reputation.mjs:6-17`) — so a node that claims a debater seat and stalls falls out of rotation exactly as any inference dropper does today. This is the whole reputation story for distribution, and it needs zero new code.

**There are no judge-quality events, because there is no judge node.** A distinct-capability design would have scored "did the adjudicator rule well" against a judge seat's owner (overturned verdicts, unparseable output). The house judge has no owner to reward or punish — it is the broker. So:

- **Overturned-verdict / unparseable-output events are dropped.** They only made sense for a distributed judge. With the judge house-held, a bad verdict is a *broker* failure (caught by normalization, §5, which fails safe to `escalate`), not a node's reputation event.
- **Debater reliability only.** A debater earns/loses ordinary `inference` trust on delivery (did it return a well-formed seat result on time?), **not** on whether the house judge picked its position. Whether a debater "won" is deliberately *not* a reputation signal: the house judge weighs arguments on merit each time, and penalizing a node for losing an honest debate would bias the panel toward conformity. Low-effort noise still self-corrects — a node that submits garbage trips the L1 schema check (`validator.mjs:41-47`) and is `dropped`/rejected like any bad inference result.

Important boundary, retained: **`escalate` is a first-class good outcome, not a failure** (`deliberate.mjs:11-13,67`). Nothing in the reputation path penalizes a correct escalation; the house judge is free to defer to a human without any node taking a reputation hit.

---

## 9. Exposure & rollout

**Team-gated first, always.** Like `MOLT_OPEN_GRID` (`server.mjs:695-702`), distributed deliberation ships behind an explicit opt-in `MOLT_QUORUM_GRID=1` (with `MOLT_QUORUM_SEAT_TIMEOUT_MS` tuning the seat dispatch deadline) that **defaults OFF**. With it off, `deliberate()` runs exactly as today, fully in-broker via `makeProviderInfer` — the flag-off path is unchanged.

**The judge is house-held PERMANENTLY — there is no phase that distributes it.** This is the locked decision (§4), not a late phase to reach. Threats #1 (judge capture), #4 (judge collusion), and #5 (premium fuel abuse via a claimed judge) are *structurally unreachable* at every phase because there is no judge seat to claim, ever. The only thing that gets phased is **debater exposure** — how open the cheap `inference` seats are.

- **Launch posture (chosen): open + one-per-panel.** When `MOLT_QUORUM_GRID=1`, the cheap debater seats (`open_*`, `rebut_*`, `skeptic`) are distributed as `inference` jobs that **any registered inference-capable node may claim**, capped at **one seat per owner per `panel_id`** (R1). This is safe to launch *open* (not high-trust-gated) precisely because the judge is house-held: a fully captured debate — every debater seat filled by colluding owners — can only bias the inputs the house judge reasons over; it can never produce the verdict, and the broker's normalization still fails safe to `escalate` (§5). The binding decision never leaves the house, so the non-binding seats don't need a trust wall in front of them — they need only the one-per-panel independence cap (R1) and the distinct-owner floor (R3) to stop a single owner manufacturing a fake consensus. Requires live: R1 (one-owner-per-panel), R3 (distinct-owner debater floor), the per-seat L1 schema check (`validator.mjs:41-47`), and broker-local fallback (§6). Reuse of the `inference` capability means there is no new reputation ledger to bootstrap first.

- **Tightening (if abuse emerges): trust-gate the debater seats.** Should open debaters prove griefable in practice (e.g. cross-panel sybils per §10, or systematic low-effort noise), the debater seats can be raised to `trust_required > 0` on the **`inference`** ledger via the existing scheduler gate (`scheduler.mjs:113-114`) — no schema or capability change, just a non-zero floor. This is a dial, not a new phase, and it does not touch the judge (already house-held).

The phasing principle, restated for the locked design: **the binding seat (judge) is in-broker forever; only the cheap, non-binding debater seats are exposed, and their chosen launch posture is open + one-per-panel — safe *because* the judge is house-held.**

---

## 10. Open questions / non-goals

**Open questions:**

- **Concurrency vs. distinct-owner floor.** A small or busy grid may not have K distinct online inference-capable owners at panel time. Policy: fall back to in-process (§6) rather than wait — but should the broker *prefer* to wait briefly (up to `MOLT_QUORUM_SEAT_TIMEOUT_MS`) when a debater quorum is nearly reachable? Needs a dispatch-deadline tuning pass.
- **Seat prompt confidentiality.** A debater seat's prompt embeds the full `context` (`deliberate.mjs:48`) — which for the integration agent includes objective titles, PR URLs, branch bases (`integration-agent.mjs:40-62`). Distributing seats exposes that context to seat-fillers — now *any* inference-capable node under the open launch posture (§9). Likely needs a context-redaction or "debater seats only see sanitized context" rule before sensitive panels are distributed; until then, sensitive panels can stay in-broker (the flag is per-broker, and the fallback path always exists).
- **Cross-panel sybil over time.** R1 stops one owner taking multiple seats in *one* panel, but an owner could systematically fill the *same role* across *many* panels to bias the debates the house judge reads. The house judge bounds the damage (it weighs on merit and can `escalate`), but a per-owner cross-panel role-diversity check, or the debater trust-gate dial (§9), is the response if a pattern emerges.
- **Result authenticity beyond schema.** Schema-checking a seat result (§5) proves it's well-formed, not that the node actually reasoned. Is signed-provenance or a spot-check (re-run a sample of debater seats in-broker and compare) worth the cost? Lower urgency than it would be for a distributed judge, since a forged debate can only bias — never decide.

**Non-goals:**

- **No distributed judge, ever.** The premium judge is house-held permanently (§4, §9). There is no phase, trust tier, or flag that hands adjudication to a node. "Judge-of-judges" meta-deliberation is likewise out — `escalate` to a human is the existing, sufficient backstop.
- **No distinct `deliberation` capability.** Debater seats reuse `inference` (§4). No new manifest field, no new reputation ledger; routing falls out of the existing `tier` field (cheap → grid, premium → house).
- **No change to the panel shape.** `NODES`/`deps`/role voices/verdict schema are fixed (§5). This is a distribution layer for the cheap seats, not a redesign of how deliberation reasons.
- **No new code execution surface.** Debater seats are pure text-in/text-out `inference` jobs. They never carry a patch, command, or checkpoint the broker runs — deliberation must not become an RCE vector (threat #6). The `code.implementation` containment story is untouched.
- **Not a replacement for human escalation.** `escalate` stays the last resort and a first-class outcome (`deliberate.mjs:11-13`). Distribution must never make the system *less* willing to defer to a human.
- **Not coupled to `MOLT_OPEN_GRID`.** Distributed deliberation has its own opt-in (`MOLT_QUORUM_GRID`); it does not require — and must not silently inherit — open-grid exposure.
