// The strict TOML subset of this repository's workers/*/wrangler.toml, shared by the Deployment Orchestrator's
// configuration plan (deployment-orchestrator/src/config-diff.ts, which re-exports it) and the Recovery Manager's
// rescue executor (executor-rescue.ts), which must not depend on the Orchestrator's own code. Moved here unchanged
// on 2026-11-16 (binding props lost out of band) so both paths read a Worker's declared service bindings the same way.
// Pure: no I/O.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }

class TomlError extends Error {}
const fail = (why: string): never => { throw new TomlError(why); };

/**
 * Parse the TOML subset this repository uses: comments, `[a.b]` tables, `[[a.b]]` arrays of tables, bare or
 * basic-quoted keys, basic and literal one-line strings, integers and simple decimals, booleans, inline arrays
 * (multi-line, trailing comma, comments) and one-line inline tables. Dotted keys, multi-line strings, dates,
 * duplicate keys and redefined tables are refused. Returns null for anything outside the subset.
 */
export function parseToml(text: string): TomlTable | null {
  if (typeof text !== "string" || text.length > 256 * 1024) return null;
  try { return new TomlParser(text).parse(); } catch (e) { if (e instanceof TomlError) return null; throw e; }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

class TomlParser {
  private i = 0;
  private readonly root: TomlTable = {};
  private current: TomlTable = this.root;
  private readonly defined = new WeakSet<TomlTable>();
  private readonly inline = new WeakSet<object>();
  private readonly arraysOfTables = new WeakSet<TomlValue[]>();
  private readonly s: string;
  constructor(s: string) { this.s = s.replace(/\r\n/g, "\n"); }

  parse(): TomlTable {
    this.defined.add(this.root);
    for (;;) {
      this.skipBlank();
      if (this.i >= this.s.length) return this.root;
      const c = this.s[this.i];
      if (c === "[") this.header();
      else this.keyValue(this.current);
      this.endOfLine();
    }
  }

  private peek(n = 0) { return this.s[this.i + n]; }
  private skipSpaces() { while (this.peek() === " " || this.peek() === "\t") this.i++; }
  private skipComment() { if (this.peek() === "#") { while (this.i < this.s.length && this.peek() !== "\n") this.i++; } }
  /** Spaces, tabs, newlines and comments. */
  private skipBlank() {
    for (;;) {
      this.skipSpaces();
      if (this.peek() === "#") { this.skipComment(); continue; }
      if (this.peek() === "\n") { this.i++; continue; }
      return;
    }
  }
  private endOfLine() {
    this.skipSpaces();
    this.skipComment();
    if (this.i < this.s.length && this.peek() !== "\n") fail("trailing_content");
  }

  private key(): string {
    this.skipSpaces();
    if (this.peek() === "\"") return this.basicString();
    if (this.peek() === "'") return this.literalString();
    const start = this.i;
    while (this.i < this.s.length && BARE_KEY.test(this.peek())) this.i++;
    if (this.i === start) fail("key_expected");
    return this.s.slice(start, this.i);
  }

  private headerPath(): string[] {
    const path = [this.key()];
    for (;;) {
      this.skipSpaces();
      if (this.peek() !== ".") return path;
      this.i++;
      path.push(this.key());
    }
  }

  /** Walk to the parent table of a header path: implicit tables are created; an array of tables means its last element. */
  private walk(path: string[]): TomlTable {
    let t = this.root;
    for (const k of path) {
      const v = t[k];
      if (v === undefined) { const n: TomlTable = {}; t[k] = n; t = n; continue; }
      if (Array.isArray(v)) {
        if (!this.arraysOfTables.has(v)) fail("not_a_table");
        t = v[v.length - 1] as TomlTable;
        continue;
      }
      if (typeof v !== "object" || this.inline.has(v)) fail("not_a_table");
      t = v as TomlTable;
    }
    return t;
  }

  private header() {
    const double = this.peek(1) === "[";
    this.i += double ? 2 : 1;
    const path = this.headerPath();
    this.skipSpaces();
    if (this.peek() !== "]" || (double && this.peek(1) !== "]")) fail("header_unclosed");
    this.i += double ? 2 : 1;
    const parent = this.walk(path.slice(0, -1));
    const last = path[path.length - 1];
    const existing = parent[last];
    if (double) {
      let arr: TomlValue[];
      if (existing === undefined) { arr = []; parent[last] = arr; this.arraysOfTables.add(arr); }
      else if (Array.isArray(existing) && this.arraysOfTables.has(existing)) arr = existing;
      else return fail("redefined");
      const t: TomlTable = {};
      arr.push(t);
      this.defined.add(t);
      this.current = t;
      return;
    }
    if (existing === undefined) { const t: TomlTable = {}; parent[last] = t; this.defined.add(t); this.current = t; return; }
    if (typeof existing !== "object" || Array.isArray(existing) || this.inline.has(existing) || this.defined.has(existing)) fail("redefined");
    this.defined.add(existing as TomlTable);
    this.current = existing as TomlTable;
  }

  private keyValue(into: TomlTable) {
    const k = this.key();
    this.skipSpaces();
    if (this.peek() === ".") fail("dotted_key");
    if (this.peek() !== "=") fail("equals_expected");
    this.i++;
    this.skipSpaces();
    if (Object.prototype.hasOwnProperty.call(into, k)) fail("duplicate_key");
    into[k] = this.value();
  }

  private value(): TomlValue {
    const c = this.peek();
    if (c === "\"") { if (this.s.startsWith("\"\"\"", this.i)) fail("multiline_string"); return this.basicString(); }
    if (c === "'") { if (this.s.startsWith("'''", this.i)) fail("multiline_string"); return this.literalString(); }
    if (c === "[") return this.array();
    if (c === "{") return this.inlineTable();
    if (this.s.startsWith("true", this.i) && this.terminates(4)) { this.i += 4; return true; }
    if (this.s.startsWith("false", this.i) && this.terminates(5)) { this.i += 5; return false; }
    const m = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i, this.i + 64));
    if (m && this.terminates(m[0].length)) {
      this.i += m[0].length;
      const n = Number(m[0].replace(/_/g, ""));
      if (!Number.isFinite(n)) fail("number");
      return n;
    }
    return fail("value_expected");
  }

  /** A scalar ends at whitespace, a separator, a comment or the end. A date such as 2026-11-01 does not. */
  private terminates(len: number): boolean {
    const n = this.s[this.i + len];
    return n === undefined || n === " " || n === "\t" || n === "\n" || n === "," || n === "]" || n === "}" || n === "#";
  }

  private basicString(): string {
    this.i++;
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined || c === "\n") return fail("string_unclosed");
      if (c === "\"") return out;
      if (c === "\\") {
        const e = this.s[this.i++];
        const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", "\"": "\"", "\\": "\\" };
        if (e in simple) { out += simple[e]; continue; }
        if (e === "u" || e === "U") {
          const len = e === "u" ? 4 : 8;
          const hex = this.s.slice(this.i, this.i + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail("escape");
          const cp = parseInt(hex, 16);
          if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail("escape");
          out += String.fromCodePoint(cp);
          this.i += len;
          continue;
        }
        return fail("escape");
      }
      if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(c)) fail("control_char");
      out += c;
    }
  }

  private literalString(): string {
    this.i++;
    const end = this.s.indexOf("'", this.i);
    const nl = this.s.indexOf("\n", this.i);
    if (end < 0 || (nl >= 0 && nl < end)) fail("string_unclosed");
    const out = this.s.slice(this.i, end);
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(out)) fail("control_char");
    this.i = end + 1;
    return out;
  }

  private array(): TomlValue[] {
    this.i++;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") { this.i++; return out; }
      out.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") { this.i++; continue; }
      if (this.peek() === "]") { this.i++; return out; }
      return fail("array_separator");
    }
  }

  private inlineTable(): TomlTable {
    this.i++;
    const t: TomlTable = {};
    this.inline.add(t);
    this.skipSpaces();
    if (this.peek() === "}") { this.i++; return t; }
    for (;;) {
      this.keyValue(t);
      this.skipSpaces();
      if (this.peek() === ",") { this.i++; this.skipSpaces(); continue; }
      if (this.peek() === "}") { this.i++; return t; }
      return fail("inline_table_separator");
    }
  }
}
