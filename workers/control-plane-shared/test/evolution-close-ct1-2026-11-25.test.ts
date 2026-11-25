// Owner via the coordinator, 2026-11-25 ("CT1 closed not supported"): the owner closes an evolution intent that waits for
// another repository (waiting_external) with a reason in words; the reason reaches xauusd-moderator through
// council.decisions.read (ai-kernel/src/evolution-close.ts, POST /v1/evolution/intents/{id}/close).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { CLOSE_EVENT, EvolutionCloseError, closeExternalIntent, closeReason } from "../../ai-kernel/src/evolution-close.ts";
import { readCouncilDecisions } from "../../ai-kernel/src/council-decisions.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { textCarriesPrice } from "../src/correction.ts";
import type { D1Database } from "../src/types.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-25T10:00:00.000Z");
const ID = "int_0a1b2c3d4e5f";
const PROPOSAL = "cp_mwkvn9ec_1en88v";
const MOD = "xauusd-moderator";
/** The owner's CT1 decision, verbatim: rates, counts and R multiples, no price. It must pass. */
const CT1 = "not_supported: replay on 11 filled limit trades, BE at 30% of TP1 mean +0.39R vs SLG1 BE +0.52R (−0.13R), fails its own criterion (mean R must not fall more than 0.1R); revisit at ≥30 limit trades.";
/** The owner's CT2 decision as sent (words for the count), and its first wording with a 3-digit count, which the price rule refuses. */
const CT2 = "Not supported: replay on about four hundred resolved zone_pullback setups and 44 realised trades, no N×X passes (mean R falls or the large-loss share does not drop ≥5pp); in high-ranging regimes the filtered entries had fewer large losses than the kept ones.";
const CT2_DIGITS = CT2.replace("about four hundred resolved zone_pullback setups", "398 resolved zone_pullback setups");
const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const rows = (db: Db, sql: string, ...args: unknown[]) => (db.raw.prepare(sql).all(...(args as never[])) as any[]).map((r) => ({ ...r }));

function seed(o: { id?: string; state?: string; source?: string; source_ref?: string; origin?: Record<string, unknown> } = {}): Db {
  const db = migratedDb();
  db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES (?, 'Council moderator', 'xauusd-ai-trading-assistant', 'test', 1, '["reports.publish"]', 'enabled', NULL, 'consensus:test', ?, ?, 0)`)
    .run(MOD, "2026-11-17T00:00:00.000Z", "2026-11-17T00:00:00.000Z");
  return addIntent(db, o);
}
function addIntent(db: Db, o: { id?: string; state?: string; source?: string; source_ref?: string; origin?: Record<string, unknown> } = {}): Db {
  const at = "2026-11-20T08:00:00.000Z";
  db.raw.prepare(`INSERT INTO evolution_intents_v2 (intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, state_reason, evolution_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'cryptophys-adm/xauusd-ai-trading-assistant', 'Break even at a third of TP1', 'Move the stop to break even earlier.', '[]', ?, 'adr_0018_x1_x2', NULL, ?, ?)`)
    .run(o.id ?? ID, o.source ?? "council", o.source_ref ?? PROPOSAL, JSON.stringify(o.origin ?? { proposal_id: PROPOSAL, origin: "xauusd", agent_id: MOD }), o.state ?? "waiting_external", at, at);
  // The intake's own update for the hand-off (as evolution-intake.ts writes it).
  if ((o.source ?? "council") === "council") {
    db.raw.prepare("INSERT INTO evolution_updates_v2 (update_id, intent_id, origin, proposal_id, state, reason, refs_json, created_at) VALUES (?, ?, 'xauusd', ?, 'waiting_external', 'adr_0018_x1_x2', ?, ?)")
      .run(`evu_${crypto.randomUUID()}`, o.id ?? ID, o.source_ref ?? PROPOSAL, JSON.stringify({ intent_id: o.id ?? ID }), at);
  }
  return db;
}
const intent = (db: Db, id = ID) => rows(db, "SELECT * FROM evolution_intents_v2 WHERE intent_id = ?", id)[0];
const closeUpdates = (db: Db) => rows(db, "SELECT * FROM evolution_updates_v2 WHERE state = 'closed' ORDER BY rowid");
const closeEvents = (db: Db) => rows(db, "SELECT * FROM audit_events WHERE event_type = ? ORDER BY rowid", CLOSE_EVENT).map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));
const env = (db: Db) => baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
const close = (db: Db, body: unknown, jwt = APPROVER_JWT, id = ID) => call(kernel, env(db), req("POST", `/v1/evolution/intents/${id}/close`, body, jwt));

test("XC1. the owner closes a waiting_external intent: 200, the intent closed with the reason, one update for the council, one audit row", async () => {
  const db = seed();
  const res = await close(db, { reason: "  not supported   by the replay " });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.intent_id, ID);
  assert.equal(res.body.state, "closed");
  assert.equal(res.body.changed, true);
  assert.match(res.body.update_id, /^evu_[0-9a-f-]{36}$/);
  const row = intent(db);
  assert.deepEqual([row.state, row.state_reason], ["closed", "not supported by the replay"], "stored normalised");
  const ups = closeUpdates(db);
  assert.equal(ups.length, 1);
  assert.deepEqual({ ...ups[0], created_at: undefined }, { update_id: res.body.update_id, intent_id: ID, origin: "xauusd", proposal_id: PROPOSAL, state: "closed", reason: "not supported by the replay", refs_json: JSON.stringify({ intent_id: ID }), created_at: undefined });
  const ev = closeEvents(db);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].actor, ev[0].subject, ev[0].outcome], [APPROVER_EMAIL, `intent:${ID}`, "closed"]);
  assert.deepEqual(ev[0].payload, { intent_id: ID, proposal_id: PROPOSAL, reason: "not supported by the replay" });
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("XC2. the owner's CT1 and CT2 texts are accepted verbatim; CT2's first wording with 398 is refused as a price", async () => {
  assert.equal(textCarriesPrice(CT1), false);
  assert.equal(closeReason(CT1), CT1);
  assert.equal(textCarriesPrice(CT2), false);
  assert.equal(closeReason(CT2), CT2);
  assert.ok(CT2_DIGITS.includes("398 resolved zone_pullback setups") && CT2_DIGITS !== CT2);
  assert.equal(textCarriesPrice(CT2_DIGITS), true);
  const db = seed();
  const res = await close(db, { reason: CT1 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(intent(db).state_reason, CT1);
  assert.equal(closeUpdates(db)[0].reason, CT1);
  const db2 = seed();
  const refused = await close(db2, { reason: CT2_DIGITS });
  assert.deepEqual([refused.status, refused.body.error], [400, "reason_carries_price"]);
  assert.equal(intent(db2).state, "waiting_external");
  const ok2 = await close(db2, { reason: CT2 });
  assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
  assert.equal(intent(db2).state_reason, CT2);
});

test("XC3. a non-owner (operator, CI token) is 403 owner_required and nothing is written; Access still gates", async () => {
  const db = seed();
  for (const jwt of [OPERATOR_JWT, CI_JWT]) {
    const res = await close(db, { reason: "not supported" }, jwt);
    assert.deepEqual([res.status, res.body.error], [403, "owner_required"]);
  }
  assert.equal((await close(db, { reason: "not supported" }, null as never)).status, 403);
  assert.equal(intent(db).state, "waiting_external");
  assert.equal(closeUpdates(db).length, 0);
  assert.equal(closeEvents(db).length, 0);
});

test("XC4. the reason: a price, a secret, empty, over 300, not a string; unknown keys and invalid JSON are 400; nothing is written", async () => {
  const db = seed();
  const cases: Array<[unknown, string]> = [
    [{ reason: "closed below 4095" }, "reason_carries_price"],
    [{ reason: "closed below 4,095.50" }, "reason_carries_price"],
    [{ reason: "closed below ４０９５" }, "reason_carries_price"],
    [{ reason: "my key sk-abcdefghijklmnopqrstuvwxyzABCD" }, "reason_carries_secret"],
    [{ reason: "" }, "invalid_reason"],
    [{ reason: "   ​  " }, "invalid_reason"],
    [{ reason: 12 }, "invalid_reason"],
    [{}, "invalid_reason"],
    [{ reason: "a".repeat(301) }, "reason_too_long"],
    [{ reason: "fine", state: "closed" }, "unknown_field"],
    [{ reason: "fine", proposal_id: PROPOSAL }, "unknown_field"],
  ];
  for (const [body, code] of cases) {
    const res = await close(db, body);
    assert.deepEqual([res.status, res.body.error], [400, code], JSON.stringify(body));
  }
  // 300 characters after normalisation are accepted (the whitespace around them is not counted).
  assert.equal(closeReason(`  ${"a".repeat(300)}  `).length, 300);
  const bad = await kernel.fetch(new Request(`https://svc.example.workers.dev/v1/evolution/intents/${ID}/close`, {
    method: "POST", headers: { "cf-access-jwt-assertion": APPROVER_JWT, "content-type": "application/json" }, body: "{reason:",
  }), env(db) as never);
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "invalid_json");
  assert.equal(intent(db).state, "waiting_external");
  assert.equal(closeUpdates(db).length, 0);
  assert.equal(closeEvents(db).length, 0);
});

test("XC5. an intent in another state is 409 not_waiting_external; an unknown id 404; a malformed path 404; GET 405", async () => {
  for (const state of ["queued", "deployed", "in_progress", "merged", "rejected"]) {
    const db = seed({ state });
    const res = await close(db, { reason: "not supported" });
    assert.deepEqual([res.status, res.body.error], [409, "not_waiting_external"], state);
    assert.equal(intent(db).state, state);
    assert.equal(closeUpdates(db).length, 0);
    assert.equal(closeEvents(db).length, 0);
  }
  const db = seed();
  const missing = await close(db, { reason: "not supported" }, APPROVER_JWT, "int_ffffffffffff");
  assert.deepEqual([missing.status, missing.body.error], [404, "intent_not_found"]);
  for (const p of ["/v1/evolution/intents/int_0A1B2C3D4E5F/close", "/v1/evolution/intents/tp_0123456789abcdef/close", "/v1/evolution/intents/int_0a1b2c3d4e5f", "/v1/evolution/intents/int_0a1b2c3d4e5f/reopen"]) {
    const res = await call(kernel, env(db), req("POST", p, { reason: "x" }, APPROVER_JWT));
    assert.deepEqual([res.status, res.body.error], [404, "not_found"], p);
  }
  assert.equal((await call(kernel, env(db), req("GET", `/v1/evolution/intents/${ID}/close`, undefined, APPROVER_JWT))).status, 405);
  await assert.rejects(closeExternalIntent(db, "x", "int_bad", "not supported", NOW), (e: unknown) => e instanceof EvolutionCloseError && e.code === "intent_not_found");
});

test("XC6. a repeat is the no-op (changed false, update_id null): still exactly one close update and one audit row", async () => {
  const db = seed();
  assert.equal((await close(db, { reason: "not supported" })).body.changed, true);
  const again = await close(db, { reason: "another reason" });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { intent_id: ID, state: "closed", changed: false, update_id: null });
  assert.equal(intent(db).state_reason, "not supported", "the first reason stays");
  assert.equal(closeUpdates(db).length, 1);
  assert.equal(closeEvents(db).length, 1);
});

test("XC7. a race of two closes: one wins, the loser answers the no-op and leaves neither an update nor an audit row", async () => {
  const db = seed();
  const both = await Promise.all([closeExternalIntent(db, "a@x", ID, "first reason", NOW), closeExternalIntent(db, "b@x", ID, "second reason", NOW)]);
  assert.deepEqual(both.map((r) => r.changed).sort(), [false, true]);
  const winner = both.find((r) => r.changed)!;
  assert.equal(closeUpdates(db).length, 1);
  assert.equal(closeUpdates(db)[0].update_id, winner.update_id);
  assert.equal(closeEvents(db).length, 1);
  assert.equal(both.find((r) => !r.changed)!.update_id, null);

  // Deterministic: the loser read the intent as waiting_external, then the winner closed it before the loser's batch.
  const db2 = seed();
  const stale = { ...intent(db2) };
  await closeExternalIntent(db2, "a@x", ID, "first reason", NOW);
  let served = false;
  const staleDb: D1Database = {
    prepare(sql: string) {
      const st = db2.prepare(sql);
      if (!served && sql.startsWith("SELECT intent_id, source, source_ref, origin_json, state FROM evolution_intents_v2")) {
        served = true;
        return { ...st, bind: () => ({ ...st, first: async () => stale as never }) } as never;
      }
      return st;
    },
    batch: (s) => db2.batch(s),
  } as D1Database;
  const loser = await closeExternalIntent(staleDb, "b@x", ID, "second reason", NOW);
  assert.equal(served, true);
  assert.deepEqual(loser, { intent_id: ID, state: "closed", changed: false, update_id: null });
  assert.equal(closeUpdates(db2).length, 1);
  assert.equal(closeEvents(db2).length, 1);
  assert.equal(intent(db2).state_reason, "first reason");
  assert.equal((await verifyAuditChain(db2)).valid, true);
});

test("XC8. council.decisions.read for xauusd-moderator returns the closed update with the reason", async () => {
  const db = seed();
  const before = await readCouncilDecisions({ DB: db }, MOD, {});
  assert.deepEqual((before.updates as any[]).map((u) => u.state), ["waiting_external"]);
  const res = await close(db, { reason: CT1 });
  assert.equal(res.status, 200);
  const out = await readCouncilDecisions({ DB: db }, MOD, { cursor: before.next_cursor });
  assert.equal(out.origin, "xauusd");
  const updates = out.updates as any[];
  assert.equal(updates.length, 1);
  const u = updates[0];
  assert.deepEqual([u.schema, u.proposal_id, u.state, u.reason, u.refs], ["typed_proposal.v1", PROPOSAL, "closed", CT1, { intent_id: ID }]);
});

test("XC9. an intent without a proposal id (recorded under its report) or not from a council closes with no update; audited", async () => {
  const db = seed({ source_ref: "report:rpt_1" });
  const res = await close(db, { reason: "not supported" });
  assert.deepEqual([res.status, res.body.changed, res.body.update_id], [200, true, null]);
  assert.equal(closeUpdates(db).length, 0);
  assert.deepEqual(closeEvents(db).map((e) => e.payload), [{ intent_id: ID, proposal_id: null, reason: "not supported" }]);
  const db2 = seed({ source: "inventory", source_ref: "undeclared_worker:x", origin: { metric: "undeclared_worker" } });
  const r2 = await close(db2, { reason: "handled elsewhere" });
  assert.deepEqual([r2.status, r2.body.changed, r2.body.update_id], [200, true, null]);
  assert.equal(intent(db2).state, "closed");
  assert.equal(closeEvents(db2).length, 1);
});

test("XC10. wiring: the kernel lists the route, the Console forwards it and GET /v1/evolution, the SSOT documents it", async () => {
  const { CONSOLE_ALLOW_LIST } = await import("../../console/src/index.ts");
  const { UI_ROUTES } = await import("../../console/src/ui/routes.ts");
  assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "kernel" && a.method === "GET" && a.path === "/v1/evolution"));
  assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "kernel" && a.method === "POST" && a.path === "/v1/evolution/intents/{id}/close"));
  assert.deepEqual(UI_ROUTES.filter((r) => r.id === "kernel.evolution" || r.id === "kernel.intent_close").map((r) => ({ ...r })), [
    { id: "kernel.evolution", service: "kernel", method: "GET", path: "/v1/evolution", approverOnly: false, confirm: null },
    { id: "kernel.intent_close", service: "kernel", method: "POST", path: "/v1/evolution/intents/{id}/close", approverOnly: true, confirm: null },
  ]);
  const meta = await call(kernel, env(seed()), req("GET", "/", undefined, OPERATOR_JWT));
  assert.ok(JSON.stringify(meta.body).includes("POST /v1/evolution/intents/{id}/close"));
  const page = read("workers/console/ui/src/pages/Proposals.tsx");
  for (const s of ["External intents", "kernel.intent_close", "kernel.evolution", "waiting_external", 'role="alert"', "Words only, no prices; the moderator in xauusd reads this reason.", "maxLength={CLOSE_MAX}"]) assert.ok(page.includes(s), s);
  const src = read("workers/ai-kernel/src/evolution-close.ts");
  assert.ok(src.includes("textCarriesPrice") && !/\\p\{Nd\}/.test(src), "the shared price rule, not a copy");
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?close external intent, 2026-11-25 \(owner via the coordinator: CT1 closed not supported;/m);
  assert.ok(ssot.includes("POST /v1/evolution/intents/{id}/close"));
});
