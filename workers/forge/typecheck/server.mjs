// The Forge type-check Container (ADR-0012 §5c, owner decision 2026-11-08: Containers for the
// type-check only, because the compiler needs more memory than a Workers isolate has).
// It runs `tsc --noEmit -p <config>` on a commit's files that the Forge sends; it has no internet.
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const MODULES = path.join(path.dirname(require.resolve("typescript/package.json")), "..");
export const TOOLCHAIN = { typescript: ts.version, "@types/node": require("@types/node/package.json").version };
const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY_BYTES = 40_000_000;
const MAX_FILES = 5_000;
const MAX_DIAGNOSTICS = 100;
const SAFE_PATH = /^[A-Za-z0-9_@.+-]+(\/[A-Za-z0-9_@.+-]+)*$/;

/** A repository-relative path: no absolute paths, no "..", no hidden traversal. */
export function safePath(p) {
  return typeof p === "string" && p.length <= 300 && SAFE_PATH.test(p) && !p.split("/").some((s) => s === "." || s === "..");
}

function format(d, root) {
  const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file) return `error TS${d.code}: ${message}`;
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
  return `${path.relative(root, d.file.fileName)}(${line + 1},${character + 1}): error TS${d.code}: ${message}`;
}

/**
 * Write the files to a fresh directory, link the locked compiler packages at `modules` (the
 * tsconfig's typeRoots parent), and type-check `config` exactly as `tsc --noEmit -p` does.
 */
export async function typecheck({ files, config, modules }) {
  if (!safePath(config) || !safePath(modules)) throw Object.assign(new Error("invalid_path"), { status: 400 });
  const entries = Object.entries(files ?? {});
  if (entries.length === 0 || entries.length > MAX_FILES) throw Object.assign(new Error("invalid_files"), { status: 400 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-tc-"));
  try {
    for (const [p, text] of entries) {
      if (!safePath(p) || typeof text !== "string") throw Object.assign(new Error("invalid_file: " + String(p).slice(0, 80)), { status: 400 });
      await fs.mkdir(path.join(root, path.dirname(p)), { recursive: true });
      await fs.writeFile(path.join(root, p), text);
    }
    await fs.mkdir(path.dirname(path.join(root, modules)), { recursive: true });
    await fs.symlink(MODULES, path.join(root, modules), "dir");
    const started = Date.now();
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw Object.assign(new Error(format(d, root)), { status: 422 }); } };
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, config), {}, host);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
    const all = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
    const errors = all.filter((d) => d.category === ts.DiagnosticCategory.Error);
    return {
      toolchain: TOOLCHAIN, files: program.getSourceFiles().length, errors: errors.length,
      diagnostics: errors.slice(0, MAX_DIAGNOSTICS).map((d) => format(d, root)), ms: Date.now() - started,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

let queue = Promise.resolve();
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ok", toolchain: TOOLCHAIN });
  if (req.method !== "POST" || req.url !== "/typecheck") return json(res, 404, { error: "not_found" });
  const chunks = [];
  let size = 0;
  req.on("data", (c) => { size += c.length; if (size > MAX_BODY_BYTES) { req.destroy(); } else chunks.push(c); });
  req.on("end", () => {
    // One check at a time: the instance has 1 GiB and one program needs about 300 MB.
    queue = queue.then(async () => {
      try {
        json(res, 200, await typecheck(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch (e) {
        json(res, e.status ?? 500, { error: String(e.message ?? e).slice(0, 500) });
      }
    });
  });
});

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(JSON.stringify({ event: "typecheck.listening", port: PORT, toolchain: TOOLCHAIN })));
}
