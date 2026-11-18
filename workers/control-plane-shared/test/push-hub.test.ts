// HAIC push hub (docs/design/HAIC-H0-H1.md §4.5; ADR-0015 phase 1, minimal slice): the ConsoleHub's rules (subscribe
// and unsubscribe only, change signals only, limits), the kernel's GET /v1/hub for operators, the Console's same-origin
// upgrade path (no cross-site WebSocket hijacking), what a council publishes, and the wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CI_CLIENT_ID, OPERATOR_EMAIL, APPROVER_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, accessEnv, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import consoleWorker, { CONSOLE_ALLOW_LIST, SERVICE_BINDINGS } from "../../console/src/index.ts";
import { HUB_LIMITS, admit, councilEvents, eventFrame, handleClientMessage, isChannel, publishHub, type HubAttachment } from "../../ai-kernel/src/hub.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";

const CS = "cs_00000000-0000-4000-8000-0000000000c1";
const ORIGIN = "https://nexus.cryptophys.work";

test("P1. a socket only subscribes and unsubscribes, to known channels, at most 10; anything else is an error frame", () => {
  let att: HubAttachment = { actor: "ops@example.com", channels: [] };
  const send = (raw: unknown) => { const r = handleClientMessage(att, raw); att = r.attachment; return JSON.parse(r.reply); };
  assert.deepEqual(send(JSON.stringify({ op: "subscribe", channel: "inbox" })), { kind: "subscribed", channel: "inbox" });
  assert.deepEqual(send(JSON.stringify({ op: "subscribe", channel: `council:${CS}` })), { kind: "subscribed", channel: `council:${CS}` });
  send(JSON.stringify({ op: "subscribe", channel: "inbox" }));
  assert.deepEqual(att.channels, ["inbox", `council:${CS}`], "subscribing twice keeps one");
  for (const bad of [JSON.stringify({ op: "subscribe", channel: "conversation:cnv_0123456789abcdef" }), JSON.stringify({ op: "publish", channel: "inbox" }),
    JSON.stringify({ op: "subscribe", channel: "council:../x" }), "not json", JSON.stringify({ op: "subscribe", channel: "inbox", pad: "x".repeat(600) }), 42]) {
    assert.deepEqual(send(bad), { kind: "error", code: "invalid_message" }, String(bad).slice(0, 40));
  }
  assert.deepEqual(send(JSON.stringify({ op: "unsubscribe", channel: "inbox" })), { kind: "unsubscribed", channel: "inbox" });
  assert.deepEqual(att.channels, [`council:${CS}`]);
  att = { actor: "a", channels: [] };
  for (let i = 0; i < HUB_LIMITS.max_channels_per_socket; i++) send(JSON.stringify({ op: "subscribe", channel: `council:cs_00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
  assert.deepEqual(send(JSON.stringify({ op: "subscribe", channel: "inbox" })), { kind: "error", code: "channel_limit" });
  assert.deepEqual([isChannel("councils"), isChannel("inbox"), isChannel(`council:${CS}`), isChannel("audit")], [true, true, true, false]);
});

test("P2. an event is a change signal: flat scalars only, no text, a bounded frame; admission needs an actor and room", () => {
  const f = JSON.parse(eventFrame(`council:${CS}`, 7, "council_changed", { session_id: CS, state: "awaiting_owner", messages: 12, text: "a long sentence with spaces", nested: { a: 1 }, "Bad Key": 1 }, Date.parse("2026-11-18T11:00:00Z"))!);
  assert.deepEqual(f, { channel: `council:${CS}`, seq: 7, at: "2026-11-18T11:00:00.000Z", kind: "council_changed", data: { session_id: CS, state: "awaiting_owner", messages: 12 } });
  assert.equal(eventFrame("audit", 1, "x", {}), null);
  assert.equal(eventFrame("inbox", 1, "Not A Kind", {}), null);
  assert.deepEqual(admit(null, 0), { ok: false, status: 403, code: "forbidden" });
  assert.deepEqual(admit("ops@example.com", HUB_LIMITS.max_sockets), { ok: false, status: 503, code: "hub_full" });
  assert.deepEqual(admit("ops@example.com", 3), { ok: true });
});

test("P3. what a council publishes: its channel on any change, the list on a state change, the inbox when it starts or stops waiting on the owner", () => {
  const after = (state: string, messages: number) => ({ session_id: CS, state, messages });
  assert.deepEqual(councilEvents({ state: "positions", messages: 3 }, after("positions", 3)), []);
  assert.deepEqual(councilEvents({ state: "positions", messages: 3 }, after("positions", 4)).map((e) => e.channel), [`council:${CS}`]);
  assert.deepEqual(councilEvents({ state: "rebuttals", messages: 8 }, after("synthesis", 9)).map((e) => e.channel), [`council:${CS}`, "councils"]);
  assert.deepEqual(councilEvents({ state: "synthesis", messages: 9 }, after("awaiting_owner", 10)).map((e) => e.channel), [`council:${CS}`, "councils", "inbox"]);
  assert.deepEqual(councilEvents({ state: "awaiting_owner", messages: 10 }, after("decided", 10)).map((e) => e.channel), [`council:${CS}`, "councils", "inbox"]);
  assert.deepEqual(councilEvents(null, after("proposed", 1)).map((e) => e.channel), [`council:${CS}`, "councils", "inbox"]);
  assert.deepEqual(councilEvents(null, after("convening", 0))[0].data, { session_id: CS, state: "convening", messages: 0 });
});

test("P4. publishHub never fails its caller: no binding, or a hub that throws", async () => {
  await publishHub({}, [{ channel: "inbox", kind: "inbox_changed", data: {} }]);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m: string) => { errs.push(String(m)); };
  try { await publishHub({ HUB: { idFromName: (n: string) => n, get: () => ({ publish: async () => { throw new Error("down"); } }) } }, [{ channel: "inbox", kind: "inbox_changed", data: {} }]); } finally { console.error = orig; }
  assert.ok(errs.some((e) => e.includes("hub_publish_failed")));
  const sent: unknown[] = [];
  await publishHub({ HUB: { idFromName: (n: string) => n, get: (n: unknown) => ({ publish: async (ev: unknown) => { sent.push([n, ev]); return {}; } }) } }, []);
  assert.deepEqual(sent, [], "nothing to publish, no call");
});

test("P5. the kernel's GET /v1/hub: operators only, a WebSocket upgrade only, forwarded to the one hub object with the actor", async () => {
  const db = migratedDb();
  const seen: Request[] = [];
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    HUB: { idFromName: (n: string) => `id:${n}`, get: (id: string) => ({ fetch: async (r: Request) => { seen.push(r); return new Response(JSON.stringify({ id }), { status: 200 }); } }) } };
  assert.equal((await call(kernel, env, req("GET", "/v1/hub", undefined, OPERATOR_JWT))).status, 426, "not an upgrade");
  assert.equal((await call(kernel, env, req("POST", "/v1/hub", {}, OPERATOR_JWT, { upgrade: "websocket" }))).status, 405);
  const outsider = await call(kernel, env, req("GET", "/v1/hub", undefined, OUTSIDER_JWT, { upgrade: "websocket" }));
  assert.ok([401, 403].includes(outsider.status), String(outsider.status));
  const ok = await call(kernel, env, req("GET", "/v1/hub", undefined, OPERATOR_JWT, { upgrade: "websocket" }));
  assert.deepEqual([ok.status, ok.body], [200, { id: "id:console" }]);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].headers.get("upgrade"), seen[0].headers.get("x-hub-actor")], ["websocket", OPERATOR_EMAIL]);
  assert.equal((await call(kernel, { ...env, HUB: undefined }, req("GET", "/v1/hub", undefined, OPERATOR_JWT, { upgrade: "websocket" }))).status, 503);
});

test("P6. the Console forwards the upgrade only from its own origin, and passes the 101 through untouched", async () => {
  const upgraded = { status: 101, headers: new Headers(), body: null, webSocket: {} } as unknown as Response;
  const calls: Request[] = [];
  const bindings: Record<string, unknown> = {};
  for (const name of Object.values(SERVICE_BINDINGS)) bindings[name] = { fetch: async () => new Response("{}", { status: 404 }) };
  bindings[SERVICE_BINDINGS.kernel] = { fetch: async (r: Request) => { calls.push(r); return upgraded; } };
  const env = { SERVICE_NAME: "cryptophys-console", SERVICE_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1", ACCESS_TEAM_DOMAIN: accessEnv().ACCESS_TEAM_DOMAIN, ACCESS_AUD: accessEnv().ACCESS_AUD,
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL, ASSETS: { fetch: async () => new Response("") }, ...bindings };
  const hub = (headers: Record<string, string>) => consoleWorker.fetch(new Request(`${ORIGIN}/console/api/kernel/v1/hub`, { headers: { "cf-access-jwt-assertion": OPERATOR_JWT, ...headers } }), env as never);
  assert.equal((await hub({ upgrade: "websocket", origin: "https://evil.example" })).status, 403, "a cross-site page cannot open the hub");
  assert.equal((await hub({ upgrade: "websocket" })).status, 403, "no Origin, no hub");
  assert.equal((await hub({ origin: ORIGIN })).status, 426, "not an upgrade");
  assert.equal(calls.length, 0);
  const res = await hub({ upgrade: "websocket", origin: ORIGIN });
  assert.equal(res, upgraded, "the 101 and its socket pass through as they came");
  assert.equal(calls.length, 1);
  assert.deepEqual([new URL(calls[0].url).pathname, calls[0].headers.get("upgrade"), calls[0].headers.get("cf-access-jwt-assertion")], ["/v1/hub", "websocket", OPERATOR_JWT]);
  const anon = await consoleWorker.fetch(new Request(`${ORIGIN}/console/api/kernel/v1/hub`, { headers: { upgrade: "websocket", origin: ORIGIN } }), env as never);
  assert.ok([401, 403].includes(anon.status), "the Access gate runs first");
  assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "kernel" && a.method === "GET" && a.path === "/v1/hub"));
  assert.ok(!CONSOLE_ALLOW_LIST.some((a) => a.path === "/v1/hub" && a.method !== "GET"));
  assert.deepEqual(UI_ROUTES.find((r) => r.id === "kernel.hub"), { id: "kernel.hub", service: "kernel", method: "GET", path: "/v1/hub", approverOnly: false, confirm: null });
});

test("P7. wiring: the HUB object and migration v9; the council object publishes; the hub writes nothing outside itself", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  const toml = read("workers/ai-kernel/wrangler.toml");
  assert.match(toml, /\[\[durable_objects\.bindings\]\]\nname = "HUB"\nclass_name = "ConsoleHub"/);
  assert.match(toml, /\[\[migrations\]\]\ntag = "v9"\nnew_sqlite_classes = \["ConsoleHub"\]/);
  const worker = read("workers/ai-kernel/src/worker.ts");
  assert.match(worker, /export class ConsoleHub extends DurableObject<Env>/);
  assert.match(worker, /this\.state\.acceptWebSocket\(server\)/, "the Hibernation API");
  assert.match(worker, /const value = await this\.ops\.run\(op\); await this\.archive\(\); await this\.notify\(before\);/, "each council operation publishes its change");
  const hub = read("workers/ai-kernel/src/hub.ts");
  assert.doesNotMatch(hub, /^import /m, "hub.ts imports nothing");
  const cls = worker.slice(worker.indexOf("export class ConsoleHub"));
  assert.doesNotMatch(cls, /env\.DB|prepare\(|consensus|syscall|\.dispatch\(/, "the hub reads and writes no D1 and acts on nothing");
  assert.match(read("workers/ai-kernel/src/index.ts"), /\.then\(\(r\) => \(r \? publishHub\(env, \[\{ channel: "inbox", kind: "inbox_changed"/);
});
