// node:sqlite DatabaseSync subset over sql.js (initialized by the runner entry as globalThis.__SQL).
const databases = globalThis.__SQL_DATABASES ??= new Set();
const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "bigint" ? Number(v) : v));
export class DatabaseSync {
  constructor() {
    this.db = new globalThis.__SQL.Database();
    this.closed = false;
    databases.add(this);
  }
  exec(sql) { this.db.exec(sql); }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { databases.delete(this); }
  }
  prepare(sql) {
    const db = this.db;
    const withStmt = (p, f) => { const st = db.prepare(sql); try { st.bind(norm(p)); return f(st); } finally { st.free(); } };
    return {
      get: (...p) => withStmt(p, (st) => (st.step() ? st.getAsObject() : undefined)),
      all: (...p) => withStmt(p, (st) => { const out = []; while (st.step()) out.push(st.getAsObject()); return out; }),
      run: (...p) => {
        withStmt(p, (st) => { st.step(); });
        const changes = db.getRowsModified();
        const id = db.exec("SELECT last_insert_rowid()")[0]?.values?.[0]?.[0] ?? 0;
        return { changes, lastInsertRowid: id };
      },
    };
  }
}
export default { DatabaseSync };
