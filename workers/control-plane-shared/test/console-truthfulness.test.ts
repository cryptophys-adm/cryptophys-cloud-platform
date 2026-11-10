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
  for (const f of ["pages/Organism.tsx", "pages/Metabolism.tsx", "pages/Command.tsx"]) {
    const s = read(f);
    assert.match(s, /call\("kernel\.metabolism"\)/, `${f} reads GET /v1/metabolism`);
    assert.doesNotMatch(s, /power_mode \?\? "(growth|survival|homeostasis)"/, `${f}: an unknown power mode must not default to a mode`);
  }
  assert.match(read("components/CloudflareUsage.tsx"), /call\("platform\.usage"\)/);
});
