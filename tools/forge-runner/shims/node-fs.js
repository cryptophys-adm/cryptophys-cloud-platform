// node:fs subset over the repository snapshot (globalThis.__VFS: repo-relative path -> text).
const ROOT = "/repo/";
function rel(p) {
  let s = typeof p === "string" ? p : p instanceof URL ? p.href : String(p);
  if (s.startsWith("file://")) s = new URL(s).pathname;
  s = decodeURIComponent(s);
  const parts = [];
  for (const seg of s.split("/")) { if (!seg || seg === ".") continue; if (seg === "..") parts.pop(); else parts.push(seg); }
  const abs = "/" + parts.join("/");
  return abs.startsWith(ROOT) ? abs.slice(ROOT.length) : abs.startsWith("/tmp/") ? abs : abs.slice(1);
}
const vfs = () => globalThis.__VFS;
const mem = (globalThis.__MEMFS ??= {});
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
export function readFileSync(p, enc) {
  const r = rel(p);
  const v = mem[r] ?? vfs()[r];
  if (v === undefined) throw enoent(r);
  const e = typeof enc === "string" ? enc : enc?.encoding;
  return e ? v : Buffer.from(v);
}
export function existsSync(p) { const r = rel(p); return r in mem || r in vfs() || isDir(r); }
function children(r) {
  const pre = r.endsWith("/") ? r : r + "/";
  const names = new Set();
  for (const k of [...Object.keys(vfs()), ...Object.keys(mem)]) if (k.startsWith(pre)) names.add(k.slice(pre.length).split("/")[0]);
  return [...names].sort();
}
function isDir(r) { return children(r).length > 0; }
export function readdirSync(p, opts) {
  const r = rel(p); if (!isDir(r)) throw enoent(r);
  const names = children(r);
  if (!opts?.withFileTypes) return names;
  return names.map((name) => { const k = (r ? r + "/" : "") + name; const file = k in mem || k in vfs(); return { name, isFile: () => file, isDirectory: () => !file }; });
}
export function statSync(p) {
  const r = rel(p); const f = mem[r] ?? vfs()[r];
  if (f === undefined && !isDir(r)) throw enoent(r);
  return { isFile: () => f !== undefined, isDirectory: () => f === undefined, size: f?.length ?? 0 };
}
export function writeFileSync(p, data) { mem[rel(p)] = String(data); }
export function mkdtempSync(prefix) { const d = rel(prefix) + Math.random().toString(36).slice(2, 8); mem[d + "/.keep"] = ""; return "/" + d.replace(/^\//, ""); }
export function rmSync(p) { const r = rel(p); for (const k of Object.keys(mem)) if (k === r || k.startsWith(r + "/")) delete mem[k]; }
export function mkdirSync() {}
export default { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync, mkdirSync };
