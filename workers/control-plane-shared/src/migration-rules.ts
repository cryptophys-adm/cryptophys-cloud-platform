/**
 * ADR-0012 G2c-1: the rules a D1 migration must meet before the Deployment Orchestrator applies it itself,
 * without `wrangler d1 migrations apply`.
 *
 * - DESTRUCTIVE_SQL is the Forge's owner-only rule for migrations (workers/forge/src/changes.ts, ADR-0012 §2.4):
 *   a migration that drops, deletes or rewrites data needs the owner. A test keeps the two regular expressions
 *   equal. A migration that matches it is never applied natively; it stays on the GitHub workflow.
 * - D1 runs one statement per prepared statement, so a migration file is split into its statements here and
 *   applied as one D1 batch (one transaction). The splitter knows SQLite's quoting, comments and the
 *   BEGIN … END body of CREATE TRIGGER. A test applies every repository migration through it and compares the
 *   schema with a plain `exec` of each file.
 * - Statements that control transactions or the connection (BEGIN, COMMIT, PRAGMA, ATTACH, …) cannot run inside
 *   a D1 batch the way they run in a file; a migration that has one stays on the GitHub workflow.
 */

export const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)|DELETE\s+FROM|UPDATE\s+[A-Za-z_][A-Za-z0-9_]*\s+SET|ALTER\s+TABLE\s+[A-Za-z_][A-Za-z0-9_]*\s+(RENAME|DROP))\b/i;

/** The Forge's comment stripping (line and block comments), kept identical so both read a file the same way. */
export const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** The migration ledger `wrangler d1 migrations apply` keeps (its default `migrations_table`). */
export const D1_MIGRATIONS_TABLE = "d1_migrations";
/** The row wrangler inserts after a migration: `INSERT INTO "d1_migrations" (name) values ('<file>')`; id and applied_at are the column defaults. */
export const D1_MIGRATION_INSERT = `INSERT INTO ${D1_MIGRATIONS_TABLE} (name) VALUES (?)`;

const UNSUPPORTED_FIRST_WORD = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "PRAGMA", "ATTACH", "DETACH", "VACUUM"]);

/**
 * Split SQL text into its statements, without the trailing semicolon. Comments inside a statement are kept as
 * written (SQLite stores a CREATE statement's text, so the schema reads exactly as after a plain `exec` of the
 * file); a piece with comments only is dropped. Quoted strings and identifiers ('…', "…", `…`, […]) and comments
 * never end a statement; inside CREATE TRIGGER the statement ends only after the END that closes its BEGIN
 * (CASE … END is counted). Throws on an unterminated quote or comment, or a trigger without its END.
 */
export function splitSqlStatements(sql: string): string[] {
  return scanStatements(sql, true);
}

/** The SQL text with every comment removed (quoted text kept), statements joined by ";\n". */
export function sqlWithoutComments(sql: string): string {
  return scanStatements(sql, false).join(";\n");
}

function scanStatements(sql: string, keepComments: boolean): string[] {
  const out: string[] = [];
  let cur = "";
  let hasCode = false;
  let words: string[] = [];
  let depth = 0;
  let word = "";
  const isTrigger = (ws: string[]) => ws[0] === "CREATE" && (ws[1] === "TRIGGER" || ((ws[1] === "TEMP" || ws[1] === "TEMPORARY") && ws[2] === "TRIGGER"));
  const flushWord = () => {
    if (!word) return;
    const w = word.toUpperCase();
    word = "";
    words.push(w);
    if (!isTrigger(words)) return;
    if (w === "BEGIN" || w === "CASE") depth++;
    else if (w === "END") depth--;
  };
  const end = () => {
    flushWord();
    const s = cur.trim();
    if (s && hasCode) out.push(s);
    cur = ""; hasCode = false; words = []; depth = 0;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      flushWord();
      const nl = sql.indexOf("\n", i);
      const stop = nl < 0 ? sql.length : nl;
      cur += keepComments ? sql.slice(i, stop) : " ";
      i = stop;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      flushWord();
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) throw new Error("unterminated_comment");
      cur += keepComments ? sql.slice(i, close + 2) : " ";
      i = close + 2;
      continue;
    }
    if (!/\s/.test(c) && c !== ";") hasCode = true;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      flushWord();
      const closer = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(closer, j);
        if (k < 0) throw new Error("unterminated_quote");
        // A doubled quote inside a quoted string is an escaped quote ([…] has no escape).
        if (closer !== "]" && sql[k + 1] === closer) { j = k + 2; continue; }
        j = k + 1;
        break;
      }
      cur += sql.slice(i, j);
      i = j;
      continue;
    }
    if (c === ";") {
      flushWord();
      if (depth <= 0) { end(); i++; continue; }
      cur += c; i++;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) word += c;
    else flushWord();
    cur += c;
    i++;
  }
  flushWord();
  if (depth > 0) throw new Error("unterminated_trigger");
  end();
  return out;
}

/** The first statement a D1 batch cannot run as the file means it, or null. */
export function unsupportedStatement(statements: string[]): string | null {
  for (const s of statements) {
    const first = /^[A-Za-z]+/.exec(sqlWithoutComments(s).trim())?.[0]?.toUpperCase() ?? "";
    if (UNSUPPORTED_FIRST_WORD.has(first)) return first;
  }
  return null;
}

/**
 * True when the migration drops, deletes or rewrites data: the Forge's own reading (its comment stripping), or
 * the same rule over the text without comments as the splitter reads it (a `--` inside a quoted string does not
 * hide the rest of its line here). Either one is enough.
 */
export function destructiveMigration(sql: string): boolean {
  return DESTRUCTIVE_SQL.test(stripSqlComments(sql)) || DESTRUCTIVE_SQL.test(sqlWithoutComments(sql));
}
