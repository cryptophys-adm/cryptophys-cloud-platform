// Owner 2026-11-13: "buatkan panel alert di menu cerebrum user ... mengaktifkan/nonaktifkan atau menambah/hapus telegram
// alert ... cukup input chat id atau token id telegram". Telegram alert channels managed from the Console, no deploy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { MAX_DELIVERY_RETRIES, reconcileNotices } from "../../ai-kernel/src/owner-notices.ts";
import { vaultOn } from "../../ai-kernel/src/alert-channels.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const TOKEN = "1234567890:AAH" + "x".repeat(32) + "Ab9z";
const OTHER_TOKEN = "1234567890:BBH" + "y".repeat(32) + "Zz12";
const realFetch = globalThis.fetch;

function vaultNs() {
  const store = new Map<string, unknown>();
  const storage = { get: async <T>(k: string) => store.get(k) as T | undefined, put: async <T>(k: string, v: T) => { store.set(k, v); }, delete: async (k: string) => store.delete(k) };
  return { store, ns: { idFromName: (n: string) => n, get: () => vaultOn(storage) } };
}
function env(db: Db, extra: Record<string, unknown> = {}) {
  const vault = vaultNs();
  const tg: any[] = [];
  const e = baseEnv("cryptophys-ai-kernel", db, {
    OPERATOR_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL,
    ALERT_VAULT_NS: vault.ns, OWNER_TELEGRAM: { notify: async (n: any) => { tg.push(n); return { sent: true }; } }, OWNER_NOTICE_CHANNELS: "telegram",
    ...extra,
  });
  return { e, vault, tg };
}
const req = (method: string, path: string, jwt: string, body?: unknown) =>
  new Request(`https://kernel.example${path}`, { method, headers: { "cf-access-jwt-assertion": jwt, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
/** The Telegram Bot API, faked: records each send; a chat id can be made to fail. */
function telegram(failChat?: string) {
  const sent: Array<{ token: string; chat: string; text: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("access/certs")) return (await import("./harness.ts")).accessCertsResponse();
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/sendMessage$/.exec(url);
    if (!m) throw new Error(`unexpected ${url}`);
    const body = JSON.parse(String(init!.body));
    if (body.chat_id === failChat) return Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 });
    sent.push({ token: m[1], chat: body.chat_id, text: body.text });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  return sent;
}
const critical = (db: Db) => db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, 'deployment-orchestrator', 'platform_digest', 'critical', 'Deploy failed', '{}', 'not_used', NULL, ?)")
  .run(`rpt_${crypto.randomUUID()}`, new Date(NOW - 60_000).toISOString());

test("AL1. operators read the channels; only an approver adds, changes, tests or deletes; the token is write-only", async () => {
  const db = migratedDb();
  const { e, vault } = env(db);
  const sent = telegram();
  try {
    let r = await call(kernel, e, req("GET", "/v1/alerts", OPERATOR_JWT));
    assert.equal(r.status, 200);
    let body: any = r.body;
    assert.deepEqual(body.channels.map((c: any) => [c.channel_id, c.kind, c.enabled]), [["alc_default", "telegram_default", true]]);
    assert.equal(body.available, true);
    assert.ok(body.topics.some((t: any) => t.topic === "drift" && t.owner_channel === false));

    const add = { name: "Cerebrum alerts", chat_id: "-1001234567890", bot_token: TOKEN, topics: ["critical_reports", "drift"] };
    assert.equal((await call(kernel, e, req("POST", "/v1/alerts", OPERATOR_JWT, add))).status, 403, "an operator cannot add");
    r = await call(kernel, e, req("POST", "/v1/alerts", APPROVER_JWT, add));
    assert.equal(r.status, 201);
    const created: any = r.body.channel;
    assert.match(created.channel_id, /^alc_[0-9a-f-]{36}$/);
    assert.deepEqual([created.token_hint, created.chat_id, created.topics, created.enabled], ["Ab9z", "-1001234567890", ["drift", "critical_reports"], true]);
    // The token never sits in D1, an audit payload or a response; it is in the vault.
    const everything = JSON.stringify([db.raw.prepare("SELECT * FROM alert_channels").all(), db.raw.prepare("SELECT payload_json FROM audit_events").all(), body, created]);
    assert.ok(!everything.includes(TOKEN) && !everything.includes(TOKEN.slice(0, 20)), "the token is never stored outside the vault or returned");
    assert.equal(vault.store.get(`token:${created.channel_id}`), TOKEN);

    // Test, disable, change topics, rotate the token.
    r = await call(kernel, e, req("POST", `/v1/alerts/${created.channel_id}/test`, APPROVER_JWT, {}));
    assert.deepEqual(r.body, { channel_id: created.channel_id, delivery: "sent" });
    assert.deepEqual([sent.length, sent[0].token, sent[0].chat], [1, TOKEN, "-1001234567890"]);
    r = await call(kernel, e, req("POST", `/v1/alerts/${created.channel_id}`, APPROVER_JWT, { enabled: false, topics: ["critical_reports"] }));
    assert.deepEqual(r.body.channel.enabled, false);
    r = await call(kernel, e, req("POST", `/v1/alerts/${created.channel_id}`, APPROVER_JWT, { bot_token: OTHER_TOKEN }));
    assert.equal(r.body.channel.token_hint, "Zz12");
    assert.equal(vault.store.get(`token:${created.channel_id}`), OTHER_TOKEN);
    assert.equal((await call(kernel, e, req("POST", `/v1/alerts/${created.channel_id}`, OPERATOR_JWT, { enabled: true }))).status, 403);

    // Validation and the default channel's limits.
    assert.equal((await call(kernel, e, req("POST", "/v1/alerts", APPROVER_JWT, { ...add, bot_token: "not-a-token" }))).status, 400);
    assert.equal((await call(kernel, e, req("POST", "/v1/alerts", APPROVER_JWT, { ...add, chat_id: "abc" }))).status, 400);
    assert.equal((await call(kernel, e, req("POST", "/v1/alerts", APPROVER_JWT, { ...add, topics: ["nope"] }))).status, 400);
    assert.equal((await call(kernel, e, req("DELETE", "/v1/alerts/alc_default", APPROVER_JWT))).status, 409, "the default can only be disabled");
    assert.equal((await call(kernel, e, req("POST", "/v1/alerts/alc_default", APPROVER_JWT, { chat_id: "123" }))).status, 409);
    assert.equal((await call(kernel, e, req("POST", "/v1/alerts/alc_default", APPROVER_JWT, { enabled: false }))).status, 200);

    // Delete removes the row and the token.
    r = await call(kernel, e, req("DELETE", `/v1/alerts/${created.channel_id}`, APPROVER_JWT));
    assert.equal(r.status, 200);
    assert.equal(vault.store.has(`token:${created.channel_id}`), false);
    body = (await call(kernel, e, req("GET", "/v1/alerts", OPERATOR_JWT))).body;
    assert.deepEqual(body.channels.map((c: any) => [c.channel_id, c.enabled]), [["alc_default", false]]);
    const events = db.raw.prepare("SELECT event_type FROM audit_events WHERE event_type LIKE 'alerts.%' ORDER BY rowid").all().map((x: any) => x.event_type);
    assert.deepEqual(events, ["alerts.channel_created", "alerts.channel_tested", "alerts.channel_updated", "alerts.channel_updated", "alerts.channel_updated", "alerts.channel_deleted"]);
  } finally { globalThis.fetch = realFetch; }
});

test("AL2. notices go to every enabled channel whose topics list them; a failed channel alone is retried, at most three times", async () => {
  const db = migratedDb();
  const { e, tg } = env(db);
  const sent = telegram("-100999");
  try {
    const mk = async (body: Record<string, unknown>) => (await call(kernel, e, req("POST", "/v1/alerts", APPROVER_JWT, body))).body.channel;
    const good = await mk({ name: "Cerebrum", chat_id: "-100111", bot_token: TOKEN, topics: ["critical_reports"] });
    await mk({ name: "Broken chat", chat_id: "-100999", bot_token: OTHER_TOKEN, topics: ["critical_reports"] });
    await mk({ name: "Disabled", chat_id: "-100222", bot_token: TOKEN, topics: ["critical_reports"], enabled: false });
    await mk({ name: "Drift only", chat_id: "-100333", bot_token: TOKEN, topics: ["drift"] });
    critical(db);
    const run = (t: number) => reconcileNotices({ ...e, ALERT_VAULT: (e as any).ALERT_VAULT_NS.get() } as never, t);
    let r = (await run(NOW)).find((x) => x.topic === "critical_reports")!;
    assert.equal(r.change, "opened");
    const crit = () => sent.filter((s) => /critical agent report/.test(s.text));
    assert.deepEqual(crit().map((s) => s.chat), ["-100111"], "the enabled channel for the topic; not the disabled or drift-only ones");
    assert.ok(sent.filter((s) => s.chat === "-100333").every((s) => !/critical agent report/.test(s.text)), "the drift-only channel gets drift notices only");
    assert.ok(!sent.some((s) => s.chat === "-100222"), "a disabled channel gets nothing");
    const tgCrit = () => tg.filter((n) => /critical agent report/.test(n.title));
    assert.equal(tgCrit().length, 1, "the default xauusd bot also lists critical reports");
    assert.match(crit()[0].text, /open critical agent report/);
    assert.match(r.delivery ?? "", /chat not found/);
    // The next runs retry the broken channel only, and stop after MAX_DELIVERY_RETRIES.
    for (let i = 1; i <= MAX_DELIVERY_RETRIES + 2; i++) await run(NOW + i * 1_800_000);
    assert.deepEqual(crit().map((s) => s.chat), ["-100111"], "a channel that delivered is not sent the same alert again");
    assert.equal(tgCrit().length, 1);
    const retries = db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'owner.notice_delivery_retry' AND subject = 'critical_reports'").get() as any;
    assert.equal(retries.n, MAX_DELIVERY_RETRIES, "at most three retries");
    assert.ok(!JSON.stringify(db.raw.prepare("SELECT payload_json FROM audit_events").all()).includes(TOKEN), "no token in any audit payload");
    void good;
  } finally { globalThis.fetch = realFetch; }
});

test("AL3. wiring: the vault Durable Object, the Console routes and page, the menu link; migration 0056 seeds the existing bot", () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  const toml = read("ai-kernel/wrangler.toml");
  assert.match(toml, /name = "ALERT_VAULT_NS"\nclass_name = "AlertVault"/);
  assert.match(toml, /tag = "v4"\nnew_sqlite_classes = \["AlertVault"\]/);
  assert.match(read("ai-kernel/src/worker.ts"), /export class AlertVault extends DurableObject<Env>/);
  assert.match(read("console/ui/src/components/AppShell.tsx"), /href="#\/alerts"/);
  assert.match(read("console/ui/src/App.tsx"), /case "alerts": page = <Alerts \/>/);
  const page = read("console/ui/src/pages/Alerts.tsx");
  assert.match(page, /type="password"/, "the token field is masked");
  assert.doesNotMatch(page, /bot_token\s*:\s*c\./, "the page never reads a token back");
  assert.match(read("control-plane-migrations/0056_alert_channels.sql"), /'alc_default', 'Owner Telegram \(xauusd bot\)', 'telegram_default'/);
});
