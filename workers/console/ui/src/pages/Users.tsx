import { useState } from "react";
import { Ban, Fingerprint, KeyRound, RefreshCw, Save, ShieldCheck, UserPlus, Users as UsersIcon } from "lucide-react";
import { Badge, Empty, Field, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { DataTable, STATUS, StatusBar } from "../components/viz";

/** Owner decision 2026-11-07: admin = Cerebrum access with a privilege; user = Nexus sign-in only. */
const PRIVILEGE_TEXT: Record<string, string> = {
  viewer: "Viewer: opens the Cerebrum Console and reads everything; cannot act.",
  operator: "Operator: runs routine actions (observe, wake agents, create recovery plans, deploy requests).",
  approver: "Approver: also approves recovery plans and critical actions, and may raise the consensus mode.",
};
const KIND_TEXT: Record<string, string> = {
  admin: "Admin: may open the Cerebrum Console, with the privilege below.",
  user: "User: may sign in to Nexus only; the Cerebrum Console stays closed.",
};

const tone = (a: any) => a.status !== "active" ? "slate" : a.kind === "user" ? "cyan" : a.privilege === "approver" ? "purple" : a.privilege === "operator" ? "green" : "amber";
const label = (a: any) => a.kind === "user" ? "user · Nexus only" : `admin · ${a.privilege}`;

function SyncBanner({ state, onSync, owner }: { state?: any; onSync: () => void; owner: boolean }) {
  if (!state) return null;
  const status = typeof state === "string" ? state : state?.status;
  const synced = status === "synced";
  const failed = status === "failed";
  const groupMissing = status === "group_missing";
  const configured = status === "configured";
  const notConfigured = status === "not_configured";
  const tone = synced ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-200"
    : failed ? "border-rose-400/30 bg-rose-400/5 text-rose-200"
    : "border-amber-400/20 bg-amber-400/5 text-amber-200";
  return (
    <div role={failed || groupMissing ? "alert" : "status"} className={`mb-3 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-[12px] ${tone}`}>
      <KeyRound className="h-3.5 w-3.5" />
      {synced
        ? <span>Nexus sign-in group synchronized for <b>{state.emails}</b> active account(s).</span>
        : failed
          ? <span><b>Access group sync failed.</b> {state.detail || "Cloudflare rejected the update."} Disabled accounts may still sign in to Nexus until a successful sync removes them from the group.</span>
          : groupMissing
            ? <span>Access group <span className="mono">cryptophys-nexus-accounts</span> is missing. Run Provision Access before syncing sign-in.</span>
            : configured
              ? <span>Sync credentials are configured, but group membership has not been verified on this page load. Run Sync sign-in to reconcile it.</span>
              : notConfigured
                ? <span>Access group sync is not configured. New accounts cannot sign in to Nexus, and disabled accounts may remain in the group, until the owner sets <span className="mono">ACCESS_GROUPS_TOKEN</span> on cryptophys-platform-registry.</span>
                : <span>Access group sync status is unknown. Run Sync sign-in to verify membership.</span>}
      {owner && <button type="button" className="btn ml-auto" onClick={onSync}><RefreshCw className="h-3.5 w-3.5" />Sync sign-in</button>}
    </div>
  );
}

const SOURCE_TEXT: Record<string, string> = {
  owner: "saved by an owner",
  seed: "copied from the deployed lists",
  absent: "no list saved",
  invalid: "not a valid list",
  unreadable: "could not be read",
};

/**
 * Owner 2026-11-16 (migration 0073): the emails behind OPERATOR_IDENTITIES and APPROVER_IDENTITIES, the lists every
 * Worker is deployed with (ACCESS_ALLOWED_EMAILS before the GitHub cut-over). Shown to everyone who opens this page
 * (emails, not secrets); an owner edits them with the typed phrase IDENTITIES. Every value comes from GET /v1/identities.
 */
function IdentityLists({ owner, actor }: { owner: boolean; actor: string }) {
  const { act, notify } = useSession();
  const { data, loading, error, refresh } = usePoll(() => call("registry.identities"), 120_000);
  const [draft, setDraft] = useState<string | null>(null);
  const source = data?.source ?? null;
  const status: string = typeof source?.status === "string" ? source.status : "";
  const emails: string[] = Array.isArray(source?.approver_emails) ? source.approver_emails : [];
  const revision: number | null = typeof source?.revision === "number" ? source.revision : null;
  const max: number | null = typeof data?.limits?.max_emails === "number" ? data.limits.max_emails : null;
  const history: any[] = Array.isArray(data?.history) ? data.history : [];
  const parsed = (draft ?? "").split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(parsed)];
  const save = () => {
    if (!unique.length) { notify("err", "Enter at least one email address."); return; }
    if (!unique.every((e) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e))) { notify("err", "Every entry must be a valid email address."); return; }
    if (max !== null && unique.length > max) { notify("err", `At most ${max} email addresses.`); return; }
    if (!unique.includes(actor)) { notify("err", "Your own email stays in the list."); return; }
    act({
      route: "registry.identities_update", body: { emails: unique, revision, confirm: "IDENTITIES" }, title: "Change the operator and approver emails",
      lines: [
        `${unique.length} email(s): ${unique.join(", ")}.`,
        "They become the operators (after the CI service token) and the approvers of every Worker, with each unit's next native deploy.",
        "A unit whose Workers carry other lists is then redeployed at the commit it runs (a consensus deploy, within the deploy limits), so no unrelated deploy is needed.",
        "Recorded in the audit chain under your identity.",
      ],
      done: "Identity lists saved. Each unit whose Workers differ is redeployed at its running commit; its native deploy applies them.", after: () => { setDraft(null); void refresh(); },
    });
  };
  return (
    <Panel title="Operator and approver emails" icon={<Fingerprint className="h-3.5 w-3.5 text-fuchsia-300" />}
      right={status ? <Badge tone={status === "owner" ? "purple" : status === "invalid" || status === "unreadable" ? "red" : "slate"}>{SOURCE_TEXT[status] ?? status}</Badge> : undefined}>
      <p className="mb-3 text-[12px] leading-relaxed text-slate-400">
        The configured identities every Worker is deployed with: the operators are the CI service token, then these emails; the approvers (owners) are these emails.
      </p>
      {loading && !data ? <Skeleton rows={2} /> : error ? <Empty>Could not load the identity lists: {String(error)}</Empty> : (<>
        {typeof data?.in_effect?.detail === "string" && (
          <div role={status === "invalid" ? "alert" : "status"} className={`mb-3 rounded-xl border px-3 py-2 text-[12px] ${status === "invalid" || status === "unreadable" ? "border-rose-400/30 bg-rose-400/5 text-rose-200" : "border-slate-400/20 bg-slate-400/5 text-slate-300"}`}>
            {data.in_effect.detail}
          </div>
        )}
        {emails.length ? (
          <ul className="mb-2 flex min-w-0 flex-wrap gap-1.5">{emails.map((e) => (
            <li key={e} className="mono max-w-full break-all rounded-md border border-fuchsia-400/25 bg-fuchsia-400/10 px-2 py-0.5 text-[11px] text-fuchsia-100">{e}</li>
          ))}</ul>
        ) : <Empty>No list saved{status === "invalid" ? " that is valid" : ""}.</Empty>}
        <p className="text-[11px] text-slate-500">
          {revision !== null ? <>revision {revision}{source?.updated_by ? <> · by {source.updated_by}</> : null}{source?.updated_at ? <> · {ago(source.updated_at)}</> : null}</> : "—"}
        </p>
        {history.length > 0 && (
          <details className="mt-2 text-[11px] text-slate-400">
            <summary className="cursor-pointer">Changes ({history.length})</summary>
            <ul className="mt-1 space-y-1">{history.map((h, i) => (
              <li key={i} className="break-all">{h.event_type === "identity_source.seeded" ? "seeded" : "changed"} by {h.actor} · {ago(h.created_at)}{Array.isArray(h.emails) ? <>: <span className="mono">{h.emails.join(", ")}</span></> : null}</li>
            ))}</ul>
          </details>
        )}
        {owner ? (draft === null
          ? <button type="button" className="btn mt-3" onClick={() => setDraft(emails.join("\n"))}><Fingerprint className="h-3.5 w-3.5" />Edit emails</button>
          : (
            <div className="mt-3">
              <Field label={`Emails, one per line or comma-separated${max !== null ? ` (up to ${max})` : ""}`}>
                <textarea className="field mono min-h-[96px]" aria-label="Operator and approver emails" autoComplete="off" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
              </Field>
              <p className="mt-1 text-[11px] text-slate-400">Lower case, duplicates removed, your own email kept. {unique.length} address(es).</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="btn btn-approve" onClick={save}><Save className="h-3.5 w-3.5" />Save…</button>
                <button type="button" className="btn" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          )) : <p className="mt-2 text-[11px] text-slate-500">Only an owner changes these emails.</p>}
      </>)}
    </Panel>
  );
}

export default function Users() {
  const { who, act, notify } = useSession();
  const { data, loading, error, refresh } = usePoll(() => call("registry.accounts"), 60_000);
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState("admin");
  const [privilege, setPrivilege] = useState("viewer");
  const [note, setNote] = useState("");
  const [sync, setSync] = useState<any>(null);
  const accounts = listOf(data, "accounts");
  const owners: string[] = data?.owners ?? [];
  const operators: string[] = data?.configured_operators ?? [];
  const owner = who.owner === true;
  const reload = () => void refresh();
  const after = (d: any) => { if (d?.login_sync) setSync(d.login_sync); reload(); };

  const submit = (target?: any) => {
    const e = (target?.email ?? email).trim().toLowerCase();
    const k = target?.kind ?? kind;
    const body: any = { email: e, kind: k, confirm: "GRANT" };
    if (k === "admin") body.privilege = target?.privilege ?? privilege;
    const n = target ? target.note : note.trim();
    if (n) body.note = n;
    act({
      route: "registry.account_upsert", body, title: `${target ? "Change" : "Add"} ${e}`,
      lines: [KIND_TEXT[k], ...(k === "admin" ? [PRIVILEGE_TEXT[body.privilege]] : []), "Recorded in the audit chain under your identity."],
      done: "Account record saved. Check the Nexus sign-in status below.", after: (d) => { after(d); if (!target) { setEmail(""); setNote(""); } },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Users & Privileges" icon={<UsersIcon className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{accounts.filter((a: any) => a.status === "active").length} active</Badge>}>
        <p className="mb-3 text-[12px] leading-relaxed text-slate-400">
          <b className="text-slate-200">Admin</b> accounts open the Cerebrum Console as viewer, operator or approver. <b className="text-slate-200">User</b> accounts sign in to Nexus only.
          Only the owners manage this list; nobody changes their own access, and accounts are disabled, never deleted.
        </p>
        <SyncBanner state={sync ?? data?.login_sync} owner={owner}
          onSync={() => act({ route: "registry.accounts_sync", body: { confirm: "SYNC" }, title: "Sync Nexus sign-in", done: "Nexus sign-in sync request completed; check the status below.", after })} />
        {loading && !data ? <Skeleton rows={4} /> : error ? <Empty>Could not load accounts: {String(error)}</Empty> : (<>
          <StatusBar className="mb-3" segments={[
            { key: "approver", label: "approver", value: accounts.filter((a: any) => a.status === "active" && a.kind === "admin" && a.privilege === "approver").length + owners.length, color: STATUS.owner },
            { key: "operator", label: "operator", value: accounts.filter((a: any) => a.status === "active" && a.kind === "admin" && a.privilege === "operator").length + operators.length, color: STATUS.good },
            { key: "viewer", label: "viewer", value: accounts.filter((a: any) => a.status === "active" && a.kind === "admin" && a.privilege === "viewer").length, color: STATUS.info },
            { key: "user", label: "Nexus only", value: accounts.filter((a: any) => a.status === "active" && a.kind === "user").length, color: STATUS.warning },
            { key: "disabled", label: "disabled", value: accounts.filter((a: any) => a.status !== "active").length, color: STATUS.neutral },
          ]} />
          <DataTable rows={[...owners.map((e) => ({ email: e, cfg: "owner" })), ...operators.map((e) => ({ email: e, cfg: "operator" })), ...accounts]} rowKey={(a: any) => `${a.cfg ?? "acc"}:${a.email}`}
            initialSort={{ key: "role", dir: "asc" }} maxHeight={480} empty={<>No accounts yet. {owner ? "Add the first one below." : "An owner adds them."}</>} columns={[
              { key: "email", header: "email", sort: (a: any) => a.email, cell: (a: any) => <span className={`mono text-slate-100 ${a.status && a.status !== "active" ? "opacity-60" : ""}`}>{a.cfg && <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-fuchsia-300" />}{a.email}</span> },
              { key: "role", header: "access", sort: (a: any) => a.cfg ? `0${a.cfg}` : a.status !== "active" ? "9" : `1${label(a)}`, cell: (a: any) => a.cfg
                ? <Badge tone="purple">{a.cfg === "owner" ? "owner · approver" : "operator"}</Badge>
                : <span className="inline-flex gap-1"><Badge tone={tone(a) as any}>{label(a)}</Badge>{a.status !== "active" && <Badge tone="slate">disabled</Badge>}</span> },
              { key: "note", header: "note", className: "wrap", cell: (a: any) => <span className="text-[11px] text-slate-400">{a.cfg ? "configured · not editable here" : a.note ?? ""}</span> },
              { key: "updated", header: "changed", sort: (a: any) => Date.parse(a.updated_at) || 0, cell: (a: any) => a.cfg ? <span className="text-slate-600">—</span> : <span className="text-[11px] text-slate-500">by {a.updated_by} · {ago(a.updated_at)}</span> },
              ...(owner ? [{ key: "act", header: "change", cell: (a: any) => a.cfg || a.email === who.actor ? <span className="text-slate-600">—</span> : (
                <div className="flex flex-wrap gap-1.5">
                  <select aria-label={`Role of ${a.email}`} className="field w-auto! py-1! text-[11px]" value={a.status === "active" ? (a.kind === "user" ? "user" : a.privilege) : ""}
                    onChange={(ev) => { const v = ev.target.value; if (!v) return; submit({ email: a.email, note: a.note, kind: v === "user" ? "user" : "admin", privilege: v === "user" ? undefined : v }); }}>
                    {a.status !== "active" && <option value="">re-enable as…</option>}
                    <option value="viewer">admin · viewer</option>
                    <option value="operator">admin · operator</option>
                    <option value="approver">admin · approver</option>
                    <option value="user">user · Nexus only</option>
                  </select>
                  {a.status === "active" && (
                    <button type="button" className="btn btn-danger py-1!" onClick={() => act({
                      route: "registry.account_disable", params: a.email, body: { confirm: "REVOKE" }, title: `Disable ${a.email}`,
                      lines: ["Their control-plane role ends at once. Nexus sign-in removal depends on a successful Access group sync; an existing Access session can last up to 8 hours. If sync fails, the account may still pass Access until you retry Sync sign-in."],
                      done: "Control-plane role disabled. Check the Nexus sign-in status below.", after,
                    })}><Ban className="h-3.5 w-3.5" />Disable…</button>
                  )}
                </div>
              ) }] : []),
            ]} />
        </>)}
      </Panel>

      <IdentityLists owner={owner} actor={who.actor} />

      {owner ? (
        <Panel title="Add a user" icon={<UserPlus className="h-3.5 w-3.5 text-emerald-300" />}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px_180px]">
            <Field label="Email"><input className="field" type="email" autoComplete="off" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
            <Field label="Account"><select className="field" value={kind} onChange={(e) => setKind(e.target.value)}><option value="admin">admin (Cerebrum)</option><option value="user">user (Nexus only)</option></select></Field>
            <Field label="Privilege"><select className="field" disabled={kind !== "admin"} value={privilege} onChange={(e) => setPrivilege(e.target.value)}><option value="viewer">viewer</option><option value="operator">operator</option><option value="approver">approver</option></select></Field>
          </div>
          <Field label="Note (optional, up to 200)" className="mt-2"><input className="field" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <p className="mt-2 text-[11px] text-slate-400">{KIND_TEXT[kind]} {kind === "admin" && PRIVILEGE_TEXT[privilege]}</p>
          <button type="button" className="btn btn-approve mt-2" onClick={() => {
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { notify("err", "Enter a valid email address."); return; }
            submit();
          }}><UserPlus className="h-3.5 w-3.5" />Add…</button>
        </Panel>
      ) : (
        <Panel><Empty>Only the owners add or change users. You can see the list{who.viewer ? " (read only)" : ""}.</Empty></Panel>
      )}
    </div>
  );
}
