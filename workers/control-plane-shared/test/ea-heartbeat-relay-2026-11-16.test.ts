// Owner 2026-11-16 ("pakai cara 2 lewat kernel"): the xauusd EA heartbeat messages go to the Cerebrum chat through the
// AI Kernel. The xauusd Worker publishes them as agent reports; the kernel relays each qualifying report once to the
// alert channels that list the topic ea_heartbeat (ai-kernel/src/report-relay.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, OPERATOR_EMAIL, OPERATOR_JWT, accessCertsResponse, baseEnv, call, migratedDb } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { MAX_DELIVERY_RETRIES, TOPICS } from "../../ai-kernel/src/owner-notices.ts";
import { vaultOn } from "../../ai-kernel/src/alert-channels.ts";
import { CHANNEL_TOPICS, RELAY_HOSTS, RELAY_MAX_AGE_MS, RELAY_MAX_PER_HOUR, RELAY_TEXT_MAX, RELAY_TOPICS, relayReports, sanitizeRelayText } from "../../ai-kernel/src/report-relay.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-16T12:07:00.000Z");
const MIN = 60_000;
const TOKEN = "1234567890:AAH" + "x".repeat(32) + "Ab9z";
const OTHER_TOKEN = "1234567890:BBH" + "y".repeat(32) + "Zz12";
const CEREBRUM = "alc_9f684a63-0be7-4a89-b692-b9f9ef7e3d9f";
const realFetch = globalThis.fetch;

function setup(opts: { cerebrumTopics?: string[]; failChat?: string } = {}) {
  const db = migratedDb();
  const store = new Map<string, unknown>();
  const storage = { get: async <T>(k: string) => store.get(k) as T | undefined, put: async <T>(k: string, v: T) => { store.set(k, v); }, delete: async (k: string) => store.delete(k) };
  const vault = vaultOn(storage);
  const tg: any[] = [];
  const at = new Date(NOW - 86_400_000).toISOString();
  const channel = (id: string, name: string, chat: string, topics: string[], enabled = 1) =>
    db.raw.prepare("INSERT INTO alert_channels (channel_id, name, kind, chat_id, topics_json, enabled, token_hint, created_by, created_at, updated_by, updated_at) VALUES (?, ?, 'telegram', ?, ?, ?, 'Ab9z', 'test', ?, 'test', ?)")
      .run(id, name, chat, JSON.stringify(topics), enabled, at, at);
  channel(CEREBRUM, "Cerebrum alerts", "-100111", opts.cerebrumTopics ?? ["owner_attention", "critical_reports", "production_unhandled", "ea_heartbeat"]);
  channel("alc_00000000-0000-4000-8000-000000000002", "Drift only", "-100222", ["drift", "critical_reports"]);
  channel("alc_00000000-0000-4000-8000-000000000003", "Disabled", "-100333", ["ea_heartbeat"], 0);
  // The default (xauusd bot) channel lists every owner topic; the kernel never relays through it.
  db.raw.prepare("UPDATE alert_channels SET topics_json = ? WHERE channel_id = 'alc_default'").run(JSON.stringify(["owner_attention", "critical_reports", "production_unhandled", "ea_heartbeat"]));
  const sent: Array<{ token: string; chat: string; text: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("access/certs")) return accessCertsResponse();
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/sendMessage$/.exec(url);
    if (!m) throw new Error(`unexpected ${url}`);
    const body = JSON.parse(String(init!.body));
    if (body.chat_id === opts.failChat) return Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 });
    sent.push({ token: m[1], chat: body.chat_id, text: body.text });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  const env = () => ({ DB: db, ALERT_VAULT: vault, OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); return { sent: true }; } } });
  return { db, vault, store, sent, tg, env, channel, ready: (async () => { for (const id of [CEREBRUM, "alc_00000000-0000-4000-8000-000000000002", "alc_00000000-0000-4000-8000-000000000003"]) await vault.put(id, TOKEN); })() };
}

function report(db: Db, o: { agent?: string; severity?: string; kind?: string; body?: Record<string, unknown>; at?: number } = {}): string {
  const id = `rpt_${crypto.randomUUID()}`;
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, ?, ?, 'EA heartbeat', ?, 'deterministic', NULL, ?)")
    .run(id, o.agent ?? "xauusd-risk-manager", o.kind ?? "xauusd_digest", o.severity ?? "info",
      JSON.stringify(o.body ?? { telegram_topic: "ea_heartbeat", text: "Cerebrum Self-Healing Action\nDirective: restart_terminal\nReason: terminal_disconnected" }),
      new Date(o.at ?? NOW - 2 * MIN).toISOString());
  return id;
}
const events = (db: Db, type?: string) => (db.raw.prepare("SELECT event_type, subject, outcome, payload_json FROM audit_events WHERE event_type LIKE 'owner.relay_%' ORDER BY rowid").all() as any[])
  .filter((e) => !type || e.event_type === type).map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));

test("EH1. a qualifying xauusd report is sent once to the subscribed channel, never twice; unsubscribed, disabled and default channels get nothing", async () => {
  const s = setup();
  try {
    await s.ready;
    const id = report(s.db);
    const r1 = await relayReports(s.env() as never, NOW);
    assert.deepEqual(r1, [{ report_id: id, topic: "ea_heartbeat", outcome: "forwarded", delivery: "sent" }]);
    assert.deepEqual(s.sent.map((m) => [m.chat, m.token === TOKEN]), [["-100111", true]], "Cerebrum only: not the drift-only or the disabled channel");
    assert.equal(s.sent[0].text, "Cerebrum Self-Healing Action\nDirective: restart_terminal\nReason: terminal_disconnected", "the text as published, plain");
    assert.equal(s.tg.length, 0, "never through the xauusd bot (the default channel), whatever its topics");
    for (let i = 1; i <= 4; i++) assert.deepEqual(await relayReports(s.env() as never, NOW + i * 15 * MIN), []);
    assert.equal(s.sent.length, 1, "never twice");
    const ev = events(s.db);
    assert.deepEqual(ev.map((e) => [e.event_type, e.subject, e.outcome]), [["owner.relay_forwarded", `relay:${id}`, "forwarded"]]);
    assert.deepEqual([ev[0].payload.report_id, ev[0].payload.agent_id, ev[0].payload.topic, ev[0].payload.channels], [id, "xauusd-risk-manager", "ea_heartbeat", { [CEREBRUM]: "sent" }]);
    const all = JSON.stringify(s.db.raw.prepare("SELECT payload_json FROM audit_events").all());
    assert.ok(!all.includes("Self-Healing") && !all.includes(TOKEN), "the audit holds ids and outcomes, never the text or a token");
  } finally { globalThis.fetch = realFetch; }
});

test("EH2. critical, a non-xauusd agent, another kind, a missing or other telegram_topic are ignored; an unusable text is dropped, never sent", async () => {
  const s = setup();
  try {
    await s.ready;
    assert.ok(RELAY_HOSTS.includes("xauusd-ai-trading-assistant") && !RELAY_HOSTS.some((h) => h.startsWith("cryptophys-")));
    report(s.db, { severity: "critical" });
    report(s.db, { agent: "platform-api", kind: "platform_digest" });
    report(s.db, { agent: "signal-analyst" });
    report(s.db, { kind: "hud_digest", agent: "hud-prophet" });
    report(s.db, { body: { text: "no topic" } });
    report(s.db, { body: { telegram_topic: "owner_attention", text: "not a relay topic" } });
    report(s.db, { body: { telegram_topic: "EA_HEARTBEAT", text: "wrong case" } });
    const bad1 = report(s.db, { body: { telegram_topic: "ea_heartbeat", text: { nested: true } } });
    const bad2 = report(s.db, { body: { telegram_topic: "ea_heartbeat", text: " <b></b>\u0000\u0007 " } });
    const r = await relayReports(s.env() as never, NOW);
    assert.deepEqual(r.map((x) => [x.report_id, x.outcome, x.delivery]).sort(), [[bad1, "dropped", "invalid_text"], [bad2, "dropped", "invalid_text"]].sort());
    assert.equal(s.sent.length, 0);
    assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM agent_report_acknowledgements").get() as any).n, 0, "the relay touches no report or acknowledgement");
    assert.deepEqual(await relayReports(s.env() as never, NOW + 15 * MIN), [], "a dropped report is not looked at again");
    // A warning qualifies like info.
    report(s.db, { severity: "warning", agent: "xauusd-moderator", at: NOW + 14 * MIN });
    assert.deepEqual((await relayReports(s.env() as never, NOW + 15 * MIN)).map((x) => x.delivery), ["sent"]);
  } finally { globalThis.fetch = realFetch; }
});

test("EH3. the text is sanitized and bounded", async () => {
  assert.equal(sanitizeRelayText("🤖 <b>Cerebrum Self-Healing Action</b>\nDirective: <code>restart_terminal</code>"), "🤖 Cerebrum Self-Healing Action\nDirective: restart_terminal");
  assert.equal(sanitizeRelayText("price < 2400 and > 2300"), "price < 2400 and > 2300", "a comparison is not a tag");
  assert.equal(sanitizeRelayText("a\u0000b\u001bc\u202ed\u200be\r\nf\tg\n\n\n\nh"), "abcde\nf g\n\nh");
  assert.equal(sanitizeRelayText(`token ${TOKEN} here`), "token [redacted] here");
  for (const v of [null, 42, {}, "", "   ", "<i></i>"]) assert.equal(sanitizeRelayText(v), null);
  const long = sanitizeRelayText("x".repeat(RELAY_TEXT_MAX + 500))!;
  assert.equal(Array.from(long).length, RELAY_TEXT_MAX);
  assert.ok(long.endsWith("…"));
  const s = setup();
  try {
    await s.ready;
    report(s.db, { body: { telegram_topic: "ea_heartbeat", text: `<b>EA</b> alive\u0000 ${"y".repeat(5000)}` } });
    await relayReports(s.env() as never, NOW);
    assert.equal(s.sent.length, 1);
    assert.ok(s.sent[0].text.startsWith("EA alive yyy") && Array.from(s.sent[0].text).length === RELAY_TEXT_MAX && !/[<>\u0000]/.test(s.sent[0].text));
  } finally { globalThis.fetch = realFetch; }
});

test("EH4. rate limit: at most RELAY_MAX_PER_HOUR an hour per topic; the newest are sent, the excess folded into one summary line", async () => {
  assert.ok(RELAY_MAX_PER_HOUR >= 20, "xauusd 2026-11-16: up to about 20 an hour");
  const s = setup();
  try {
    await s.ready;
    const ids: string[] = [];
    for (let i = 0; i < RELAY_MAX_PER_HOUR + 5; i++) ids.push(report(s.db, { at: NOW - 60 * MIN + i * MIN, body: { telegram_topic: "ea_heartbeat", text: `alert ${i}` } }));
    const r = await relayReports(s.env() as never, NOW);
    assert.deepEqual(r.filter((x) => x.outcome === "dropped").map((x) => x.report_id), ids.slice(0, 5), "the five oldest are dropped");
    assert.equal(s.sent.length, RELAY_MAX_PER_HOUR);
    assert.equal(s.sent[0].text, `alert 5\n(5 more ea_heartbeat messages not forwarded: at most ${RELAY_MAX_PER_HOUR} an hour)`, "one summary line, on the first message sent");
    assert.ok(s.sent.slice(1).every((m) => !m.text.includes("not forwarded")));
    // Within the hour the budget is spent: a new one is dropped, and folded into the next message once there is room.
    const late = report(s.db, { at: NOW + 10 * MIN, body: { telegram_topic: "ea_heartbeat", text: "late" } });
    assert.deepEqual((await relayReports(s.env() as never, NOW + 15 * MIN)).map((x) => [x.report_id, x.delivery]), [[late, "rate_limited"]]);
    report(s.db, { at: NOW + 65 * MIN, body: { telegram_topic: "ea_heartbeat", text: "next hour" } });
    await relayReports(s.env() as never, NOW + 67 * MIN);
    assert.equal(s.sent.at(-1)!.text, `next hour\n(1 more ea_heartbeat message not forwarded: at most ${RELAY_MAX_PER_HOUR} an hour)`);
    report(s.db, { at: NOW + 80 * MIN, body: { telegram_topic: "ea_heartbeat", text: "plain again" } });
    await relayReports(s.env() as never, NOW + 82 * MIN);
    assert.equal(s.sent.at(-1)!.text, "plain again", "the summary is given once");
    assert.equal(events(s.db, "owner.relay_dropped").length, 6, "each drop is audited");
  } finally { globalThis.fetch = realFetch; }
});

test("EH5. a failed channel alone is retried, at most MAX_DELIVERY_RETRIES times, then given up", async () => {
  const s = setup({ failChat: "-100999" });
  try {
    await s.ready;
    s.channel("alc_00000000-0000-4000-8000-000000000009", "Broken chat", "-100999", ["ea_heartbeat"]);
    await s.vault.put("alc_00000000-0000-4000-8000-000000000009", OTHER_TOKEN);
    const id = report(s.db);
    const first = await relayReports(s.env() as never, NOW);
    assert.match(first[0].delivery, /alc_00000000-0000-4000-8000-000000000009: failed: telegram_400 Bad Request: chat not found/);
    for (let i = 1; i <= MAX_DELIVERY_RETRIES + 3; i++) await relayReports(s.env() as never, NOW + i * 15 * MIN);
    assert.deepEqual(s.sent.map((m) => m.chat), ["-100111"], "the channel that delivered gets it once");
    const ev = events(s.db).filter((e) => e.subject === `relay:${id}`);
    assert.deepEqual(ev.map((e) => e.event_type), ["owner.relay_forwarded", ...Array(MAX_DELIVERY_RETRIES).fill("owner.relay_delivery_retry")]);
    assert.deepEqual(ev.at(-1)!.payload.retries, MAX_DELIVERY_RETRIES);
    assert.equal(ev.at(-1)!.payload.channels[CEREBRUM], "sent");
  } finally { globalThis.fetch = realFetch; }
});

test("EH5b. a failure that recovers is sent once, on the retry, and not again", async () => {
  let fail = true;
  const s = setup();
  try {
    await s.ready;
    const ok = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => fail ? Response.json({ ok: false, description: "Too Many Requests" }, { status: 429 }) : ok(input, init)) as typeof fetch;
    report(s.db);
    assert.match((await relayReports(s.env() as never, NOW))[0].delivery, /failed: telegram_429/);
    fail = false;
    assert.deepEqual((await relayReports(s.env() as never, NOW + 15 * MIN)).map((x) => [x.outcome, x.delivery]), [["retried", "sent"]]);
    assert.equal(s.sent.length, 1);
    assert.deepEqual(await relayReports(s.env() as never, NOW + 30 * MIN), [], "delivered: no further retry");
  } finally { globalThis.fetch = realFetch; }
});

test("EH6. the cursor survives a restart; a stale report is not sent; a report seen without a subscriber is not replayed later", async () => {
  const s = setup({ cerebrumTopics: ["critical_reports"] });
  try {
    await s.ready;
    const stale = report(s.db, { at: NOW - RELAY_MAX_AGE_MS - MIN });
    const unsubscribed = report(s.db);
    const r = await relayReports(s.env() as never, NOW);
    assert.deepEqual(r.map((x) => [x.report_id, x.delivery]).sort(), [[stale, "stale"], [unsubscribed, "no_channel"]].sort());
    assert.equal(s.sent.length, 0);
    // The owner ticks ea_heartbeat on the Cerebrum channel; the kernel restarts (a fresh vault and env, the same D1).
    s.db.raw.prepare("UPDATE alert_channels SET topics_json = ? WHERE channel_id = ?").run(JSON.stringify(["critical_reports", "ea_heartbeat"]), CEREBRUM);
    const fresh = { DB: s.db, ALERT_VAULT: vaultOn({ get: async <T>(k: string) => s.store.get(k) as T | undefined, put: async () => {}, delete: async () => true }) };
    assert.deepEqual(await relayReports(fresh as never, NOW + 15 * MIN), [], "nothing already seen is sent");
    const next = report(s.db, { at: NOW + 20 * MIN });
    assert.deepEqual((await relayReports(fresh as never, NOW + 22 * MIN)).map((x) => [x.report_id, x.delivery]), [[next, "sent"]]);
    assert.deepEqual(await relayReports(fresh as never, NOW + 37 * MIN), []);
    assert.equal(s.sent.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("EH7. the Console's Alerts page offers ea_heartbeat; an approver subscribes a channel to it; the default channel refuses it", async () => {
  const s = setup({ cerebrumTopics: ["critical_reports"] });
  try {
    await s.ready;
    assert.deepEqual([...RELAY_TOPICS], ["ea_heartbeat"]);
    assert.deepEqual([...CHANNEL_TOPICS], [...TOPICS, "ea_heartbeat"]);
    assert.ok(!(TOPICS as readonly string[]).includes("ea_heartbeat"), "a relay topic is not a notice topic");
    const e = baseEnv("cryptophys-ai-kernel", s.db, {
      OPERATOR_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL, OWNER_NOTICE_CHANNELS: "telegram",
      ALERT_VAULT_NS: { idFromName: (n: string) => n, get: () => s.vault }, OWNER_TELEGRAM: { notify: async () => ({ sent: true }) },
    });
    const rq = (method: string, path: string, jwt: string, body?: unknown) =>
      new Request(`https://kernel.example${path}`, { method, headers: { "cf-access-jwt-assertion": jwt, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const list: any = (await call(kernel, e, rq("GET", "/v1/alerts", OPERATOR_JWT))).body;
    assert.deepEqual(list.topics.find((t: any) => t.topic === "ea_heartbeat"), { topic: "ea_heartbeat", owner_channel: false, relay: true });
    assert.equal(list.topics.find((t: any) => t.topic === "drift").relay, false);
    assert.equal((await call(kernel, e, rq("POST", `/v1/alerts/${CEREBRUM}`, OPERATOR_JWT, { topics: ["critical_reports", "ea_heartbeat"] }))).status, 403, "an operator cannot");
    const r = await call(kernel, e, rq("POST", `/v1/alerts/${CEREBRUM}`, APPROVER_JWT, { topics: ["critical_reports", "ea_heartbeat"] }));
    assert.equal(r.status, 200);
    assert.deepEqual((r.body as any).channel.topics, ["critical_reports", "ea_heartbeat"]);
    const d = await call(kernel, e, rq("POST", "/v1/alerts/alc_default", APPROVER_JWT, { topics: ["owner_attention", "ea_heartbeat"] }));
    assert.equal(d.status, 400);
    assert.match(JSON.stringify(d.body), /relayed from the xauusd Worker/);
    const add = await call(kernel, e, rq("POST", "/v1/alerts", APPROVER_JWT, { name: "EA only", chat_id: "-100444", bot_token: OTHER_TOKEN, topics: ["ea_heartbeat"] }));
    assert.equal(add.status, 201, "a new channel may list only the relay topic");
  } finally { globalThis.fetch = realFetch; }
});

test("EH8. wiring: every kernel tick relays; the Alerts page names the topic; the contract is documented", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  const idx = read("workers/ai-kernel/src/index.ts");
  const sched = idx.slice(idx.indexOf("async scheduled("));
  assert.match(sched, /\n    ctx\.waitUntil\(trackJob\(env, "report_relay", relayReports\(/, "the cron calls relayReports at the top level of scheduled, not behind a minute condition");
  assert.match(read("workers/ai-kernel/wrangler.toml"), /crons = \["7,22,37,52 \* \* \* \*"\]/);
  const ui = read("workers/console/ui/src/pages/Alerts.tsx");
  assert.match(ui, /ea_heartbeat: "XAUUSD EA heartbeat/);
  assert.match(ui, /isDefault \? topics\.filter\(\(t\) => !t\.relay\)/);
  const xau = read("docs/XAUUSD-INTEGRATION.md");
  for (const s of ["telegram_topic", "ea_heartbeat", "xauusd_digest", String(RELAY_TEXT_MAX), String(RELAY_MAX_PER_HOUR), "xauusd-risk-manager"]) assert.ok(xau.includes(s), `XAUUSD-INTEGRATION names ${s}`);
  assert.match(read("docs/OPERATIONS.md"), /ea_heartbeat/);
  assert.match(read("docs/SSOT.md"), /Last reviewed: (?:[^\n]*\); )?2026-11-16 \([^\n]*ea_heartbeat/, "the 2026-11-16 entry (newer entries come first)");
});
