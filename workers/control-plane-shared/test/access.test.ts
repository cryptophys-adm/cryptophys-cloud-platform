import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, call, migratedDb, ADMIN } from "./harness.ts";
import { accessGate, resetAccessKeyCache, verifyAccessJwt } from "../src/access.ts";
import audit from "../../audit-ledger/src/index.ts";
import platformApi from "../../platform-api/src/index.ts";
import orchestrator from "../../deployment-orchestrator/src/index.ts";

const TEAM = "cryptophys.cloudflareaccess.com";
const AUD = "test-audience-tag";
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

const enc = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

let keyPair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let certFetches = 0;
const realFetch = globalThis.fetch;

async function rsa() {
  return crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

async function sign(claims: Record<string, unknown>, pair = keyPair, kid = "k1", alg = "RS256"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = `${enc({ alg, kid, typ: "JWT" })}.${enc({ aud: [AUD], iss: `https://${TEAM}`, iat: now, exp: now + 300, ...claims })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(sig).toString("base64url")}`;
}

beforeEach(async () => {
  keyPair ??= await rsa();
  otherPair ??= await rsa();
  resetAccessKeyCache();
  certFetches = 0;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1" };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), `https://${TEAM}/cdn-cgi/access/certs`);
    certFetches++;
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("valid user and service-token JWTs verify; identity is extracted", async () => {
  assert.deepEqual(await verifyAccessJwt(await sign({ email: "ops@cryptophys.work" }), env),
    { ok: true, identity: { subject: "ops@cryptophys.work", type: "user" } });
  assert.deepEqual(await verifyAccessJwt(await sign({ common_name: "github-actions.access" }), env),
    { ok: true, identity: { subject: "github-actions.access", type: "service_token" } });
  assert.equal(certFetches, 1, "signing keys are cached");
});

test("forged, foreign, stale and mis-scoped tokens are rejected", async () => {
  const reason = async (t: string, e = env) => ((await verifyAccessJwt(t, e)) as { reason: string }).reason;
  assert.equal(await reason(await sign({ email: "a@b" }, otherPair)), "invalid_signature");
  assert.equal(await reason(await sign({ email: "a@b" }, keyPair, "unknown-kid")), "unknown_signing_key");
  assert.equal(await reason(await sign({ email: "a@b" }, keyPair, "k1", "HS256")), "unsupported_algorithm");
  assert.equal(await reason(await sign({ email: "a@b", aud: ["other-app"] })), "wrong_audience");
  assert.equal(await reason(await sign({ email: "a@b", iss: "https://evil.cloudflareaccess.com" })), "wrong_issuer");
  assert.equal(await reason(await sign({ email: "a@b", exp: Math.floor(Date.now() / 1000) - 3600 })), "expired");
  assert.equal(await reason(await sign({ email: "a@b", nbf: Math.floor(Date.now() / 1000) + 3600 })), "not_yet_valid");
  assert.equal(await reason(await sign({})), "no_identity");
  const t = await sign({ email: "a@b" });
  const [h, p, s] = t.split(".");
  const tampered = `${h}.${enc({ ...JSON.parse(Buffer.from(p, "base64url").toString()), email: "admin@b" })}.${s}`;
  assert.equal(await reason(tampered), "invalid_signature");
  assert.equal(await reason("not-a-jwt"), "malformed_token");
  assert.equal(await reason(t, { ACCESS_TEAM_DOMAIN: "evil.example.com", ACCESS_AUD: AUD }), "access_not_configured");
});

test("gate: public hostnames need a valid JWT, .internal service-binding calls do not", async () => {
  const pub = (headers: Record<string, string> = {}) => new Request("https://cryptophys-audit-ledger.acme.workers.dev/health", { headers });
  assert.equal((await accessGate(pub(), env))!.status, 403);
  assert.equal((await accessGate(pub({ "cf-access-jwt-assertion": await sign({ email: "a@b" }, otherPair) }), env))!.status, 403);
  assert.equal(await accessGate(pub({ "cf-access-jwt-assertion": await sign({ email: "a@b" }) }), env), null);
  assert.equal(await accessGate(new Request("https://cryptophys-policy-engine.internal/v1/evaluate"), env), null);
  assert.equal((await accessGate(pub(), {}))!.status, 503, "fails closed when Access is not configured");
  assert.equal((await accessGate(new Request("https://deploy-orchestrator.cryptophys.work/health"), env))!.status, 403, "custom domain without Access is closed");
});

test("every Worker enforces the gate before any route, including /health", async () => {
  const workersDev = (name: string, path: string, token?: string) =>
    new Request(`https://${name}.acme.workers.dev${path}`, { headers: token ? { "cf-access-jwt-assertion": token } : {} });
  const auditEnv = baseEnv("cryptophys-audit-ledger", migratedDb());
  assert.equal((await call(audit, auditEnv, workersDev("cryptophys-audit-ledger", "/health"))).status, 403);
  const ok = await call(audit, auditEnv, workersDev("cryptophys-audit-ledger", "/ready", await sign({ common_name: "ci" })));
  assert.deepEqual([ok.status, ok.body.checks.access_configured], [200, true]);
  const withAdminButNoJwt = new Request("https://cryptophys-audit-ledger.acme.workers.dev/v1/verify", { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal((await call(audit, auditEnv, withAdminButNoJwt)).status, 403, "admin token alone is not enough on a public hostname");

  const apiEnv = { PLATFORM_NAME: "cryptophys-cloud-platform", PLATFORM_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1", ...env };
  assert.equal((await call(platformApi, apiEnv, workersDev("cryptophys-platform-api", "/health"))).status, 403);
  assert.equal((await call(platformApi, apiEnv, workersDev("cryptophys-platform-api", "/health", await sign({ email: "a@b" })))).status, 200);
  assert.equal((await call(platformApi, apiEnv, new Request("https://cryptophys-platform-api.internal/health"))).status, 200, "drift probe via service binding");

  const orchEnv = { SERVICE_NAME: "cryptophys-deployment-orchestrator", SERVICE_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1", ...env };
  assert.equal((await call(orchestrator, orchEnv, new Request("https://cryptophys-deployment-orchestrator.acme.workers.dev/v1/deployments", { method: "POST" }))).status, 403);
});
