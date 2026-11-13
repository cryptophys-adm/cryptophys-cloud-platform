// Owner 2026-11-10 ("tutup #269, buatkan panel usage Cloudflare yang asli"): the Cerebrum Console
// shows measured data only. #267, #269 and #271 put invented numbers, a usage "simulator" and a
// "treasury auto-pay" card into it; these checks keep any agent from doing that again. See AGENTS.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const SRC = new URL("../../console/ui/src/", import.meta.url);
const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.(tsx?|css)$/.test(String(f)));
const read = (f: string) => readFileSync(new URL(f, SRC), "utf8");

test("T1. the Console never claims to move funds or pay from trading (ADR-0009: no trading, no funds)", () => {
  const banned = /auto[-_ ]?pay|drawdown|withdraw|transfer\s+funds|self[- ]funding|fund(s|ing)?\s+(the\s+)?(cloud|infrastructure)|profit buffer/i;
  for (const f of files) {
    const hit = read(f).split("\n").find((l) => banned.test(l));
    assert.equal(hit, undefined, `console/ui/src/${f}: ${hit?.trim()}`);
  }
});

test("T2. no simulated or demo data in the Console", () => {
  for (const f of files) {
    const hit = read(f).split("\n").find((l) => /simulat|mock(ed)?\s*data|demo\s*data|fake\s*data/i.test(l));
    assert.equal(hit, undefined, `console/ui/src/${f}: ${hit?.trim()}`);
  }
});

test("T3. no dollar amounts written into the UI: money values are formatted from API data only", () => {
  for (const f of files) {
    const hit = read(f).split("\n").find((l) => /["'`]\$\d/.test(l));
    assert.equal(hit, undefined, `console/ui/src/${f}: ${hit?.trim()}`);
  }
});

test("T4. the metabolism and usage views read the live endpoints and default to a dash, not a number or a mode", () => {
  // The Metabolism page duplicated Organism and was removed (owner 2026-11-11); Organism and Command read the endpoint.
  for (const f of ["pages/Organism.tsx", "pages/Command.tsx"]) {
    const s = read(f);
    assert.match(s, /call\("kernel\.metabolism"\)/, `${f} reads GET /v1/metabolism`);
    assert.doesNotMatch(s, /power_mode \?\? "(growth|survival|homeostasis)"/, `${f}: an unknown power mode must not default to a mode`);
  }
  assert.match(read("components/CloudflareUsage.tsx"), /call\("platform\.usage"\)/);
});

test("T5. hardening 2026-11-11: one metabolism view (Organism), no unmeasured status, no default mode, no browser-computed quota", () => {
  // One view: no Metabolism page and no nav entry; an old #/metabolism link lands on Organism.
  assert.ok(!files.some((f) => /pages[\\/]Metabolism\.tsx$/.test(String(f))), "pages/Metabolism.tsx is gone");
  assert.doesNotMatch(read("components/AppShell.tsx"), /#\/metabolism|label: "Metabolism"/);
  assert.match(read("App.tsx"), /case "metabolism": page = <Organism \/>/);
  const org = read("pages/Organism.tsx"), cmd = read("pages/Command.tsx");
  // No status claimed without a reading (a hardcoded green status or a fallback state).
  for (const phrase of ["SELF-SUSTAINING", "OPEN (ACTIVE)", "15m Heartbeat", "15m SSOT Awareness", "Days Autonomous", "Genesis Liquidity Buffer"]) {
    assert.ok(!org.includes(phrase), `Organism must not claim "${phrase}"`);
  }
  // A mode the kernel did not report is unknown, never homeostasis; the AI quota is not computed in the browser.
  assert.doesNotMatch(org, /: "homeostasis"\);/, "modeKey must not default to homeostasis");
  assert.doesNotMatch(org, /mode === "survival" \? 25/, "no browser-computed AI quota");
  assert.doesNotMatch(org, /cost_usd \?\? 0/, "a missing burn is left out, never drawn as 0");
  // The pulsing green dots follow the reported power mode.
  for (const [name, s] of [["Organism", org], ["Command", cmd]] as const) {
    assert.doesNotMatch(s, /animate-ping/, `${name}: no always-on pulsing indicator`);
  }
  assert.doesNotMatch(cmd, /#\/metabolism/);
  // Owner 2026-11-11: the treasury placeholder is labelled wherever the reserve is shown.
  assert.match(org, /treasury_source === "placeholder"/);
  assert.match(org, /treasury reserve\{placeholder \? " · placeholder" : ""\}/);
  assert.match(org, /c\.treasury_placeholder \?/);
  assert.match(cmd, /treasury_source === "placeholder" \? " \(placeholder\)"/);
});


test("T6. Knowledge (owner 2026-11-13): the training view reads Aether's model report, and the owner is asked only for approvals and critical failures", () => {
  const k = read("pages/Knowledge.tsx");
  // The training module comes from overview().model only: no number without a reading.
  assert.match(k, /const m = o\?\.model;/);
  assert.match(k, /No model report has reached Aether yet/);
  // The decision model (LightGBM) comes from overview().model.gbm only, is shown in shadow while not connected,
  // and an empty prospective record is "waiting for outcomes", never a number.
  assert.match(k, /<DecisionModel g=\{m\.gbm\} \/>/);
  assert.match(k, /g\.connected === true \? "connected" : "shadow"/);
  assert.match(k, /prospective · waiting for outcomes/);
  // "Batasi User/Owner hanya untuk critical dan permintaan approval only": text proposals run by themselves,
  // the approve button is only for the kinds that still need a person, and the owner panel lists only those
  // approvals and the loop's failing checks while the market is open.
  assert.match(k, /const AUTONOMOUS_KINDS = new Set\(\["caution", "role_reminder"\]\);/);
  assert.match(k, /\{needsOwner\(p\) && \(who\.approver \? \(/);
  assert.match(k, /const critical = o\?\.sync\?\.market_open \? checks : \[\];/);
  assert.match(k, /Nothing needs you\. The knowledge loop is running by itself\./);
});
