import { useState } from "react";
import { BellRing, Plus, Send, Trash2 } from "lucide-react";
import { Badge, Empty, Field, Panel, Skeleton } from "../components/ui";
import { call, phraseFor } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago } from "../lib/format";

/**
 * Owner 2026-11-13: "buatkan panel alert di menu cerebrum user ... mengaktifkan/nonaktifkan atau menambah/hapus
 * telegram alert ... cukup input chat id atau token id telegram". The owner's Telegram alert channels (GET /v1/alerts).
 * A channel receives the owner notices of the topics it lists while enabled. The bot token is write-only: it is kept in
 * the AI Kernel's vault, never shown again; the page shows its last four characters. Only an approver changes channels.
 */
const TOPIC_TEXT: Record<string, string> = {
  owner_attention: "Approvals waiting for you",
  critical_reports: "Open critical reports",
  production_unhandled: "Production problems no agent is handling",
  drift: "Drift (normally Console only)",
  organism: "Organism changes (normally Console only)",
  build_minutes: "Build minutes at 80% (normally Console only)",
  dependencies: "High dependency advisories (normally Console only)",
};

function TopicPicker({ topics, value, onChange, disabled }: { topics: any[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {topics.map((t) => (
        <label key={t.topic} className="flex items-start gap-2 text-[12px] text-slate-300">
          <input type="checkbox" disabled={disabled} className="mt-0.5" checked={value.includes(t.topic)}
            onChange={(e) => onChange(e.target.checked ? [...value, t.topic] : value.filter((x) => x !== t.topic))} />
          <span>{TOPIC_TEXT[t.topic] ?? t.topic}</span>
        </label>
      ))}
    </div>
  );
}

function ChannelCard({ c, topics, reload }: { c: any; topics: any[]; reload: () => void }) {
  const { who, act, notify } = useSession();
  const [editing, setEditing] = useState<string[] | null>(null);
  const isDefault = c.kind === "telegram_default";
  return (
    <div className="glass-inner space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <BellRing className={`h-4 w-4 ${c.enabled ? "text-emerald-300" : "text-slate-500"}`} />
        <span className="min-w-0 flex-1 break-words text-slate-200">{c.name}</span>
        <Badge tone={c.enabled ? "green" : "slate"}>{c.enabled ? "enabled" : "disabled"}</Badge>
      </div>
      <div className="text-[11px] text-slate-500">
        {isDefault ? "The xauusd bot (the platform's existing owner bot)." : <>Bot token ending <span className="mono text-slate-300">…{c.token_hint}</span> · chat <span className="mono text-slate-300">{c.chat_id}</span></>}
        {" "}· changed {ago(c.updated_at)} by <span className="mono">{c.updated_by}</span>
      </div>
      <div className="text-[11px] text-slate-400">Sends: {c.topics.length ? c.topics.map((t: string) => TOPIC_TEXT[t] ?? t).join(" · ") : "nothing"}</div>
      {editing && <TopicPicker topics={topics} value={editing} onChange={setEditing} />}
      {who.approver ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn !py-1" onClick={() => act({ route: "kernel.alert_update", params: c.channel_id, body: { enabled: !c.enabled }, title: `${c.enabled ? "Disable" : "Enable"} ${c.name}`, done: c.enabled ? "Disabled." : "Enabled.", after: reload })}>
            {c.enabled ? "Disable" : "Enable"}
          </button>
          {editing ? (
            <button type="button" className="btn btn-approve !py-1" disabled={!editing.length} onClick={() => act({ route: "kernel.alert_update", params: c.channel_id, body: { topics: editing }, title: `Topics of ${c.name}`, done: "Saved.", after: () => { setEditing(null); reload(); } })}>Save topics</button>
          ) : (
            <button type="button" className="btn !py-1" onClick={() => setEditing([...c.topics])}>Topics…</button>
          )}
          <button type="button" className="btn !py-1" onClick={() => act({ route: "kernel.alert_test", params: c.channel_id, title: `Test ${c.name}`, done: "Test requested.", after: (r: any) => { if (r?.delivery !== "sent") notify("err", `Test not delivered: ${r?.delivery}`); reload(); } })}><Send className="h-3.5 w-3.5" />Test</button>
          {!isDefault && (
            <button type="button" className="btn btn-danger !py-1" onClick={() => act({ route: "kernel.alert_delete", params: c.channel_id, title: `Delete ${c.name}`, lines: ["The channel and its bot token are removed. Alerts stop going to this chat.", "The bot itself is not changed in Telegram."], done: "Deleted.", after: reload })}><Trash2 className="h-3.5 w-3.5" />Delete…</button>
          )}
        </div>
      ) : <div className="text-[11px] text-slate-500">Only an approver can change alert channels.</div>}
    </div>
  );
}

function AddChannel({ topics, reload }: { topics: any[]; reload: () => void }) {
  const { act } = useSession();
  const [name, setName] = useState("Cerebrum alerts");
  const [chat, setChat] = useState("");
  const [token, setToken] = useState("");
  const [picked, setPicked] = useState<string[]>(["owner_attention", "critical_reports", "production_unhandled"]);
  const ready = name.trim() && /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chat.trim()) && /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token.trim()) && picked.length;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name"><input className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Chat id (numeric, groups are negative, or @channel)"><input className="field mono" value={chat} inputMode="text" autoComplete="off" onChange={(e) => setChat(e.target.value)} /></Field>
        <Field label="Bot token (from @BotFather)"><input className="field mono" type="password" value={token} autoComplete="off" spellCheck={false} onChange={(e) => setToken(e.target.value)} /></Field>
      </div>
      <TopicPicker topics={topics} value={picked} onChange={setPicked} />
      <p className="text-[11px] text-slate-500">The token is stored in the AI Kernel's private vault and never shown again; only its last four characters are kept here. Send the bot a message once (or add it to the group) before testing.</p>
      <button type="button" className="btn btn-approve" disabled={!ready} onClick={() => act({
        route: "kernel.alert_create", body: { name: name.trim(), chat_id: chat.trim(), bot_token: token.trim(), topics: picked, enabled: true, confirm: phraseFor("kernel.alert_create") },
        title: `Add the alert channel "${name.trim()}"`, lines: ["Alerts of the chosen topics go to this chat from now on.", "Use Test on the new channel to check the bot and the chat id."],
        done: "Channel added.", after: () => { setToken(""); setChat(""); reload(); },
      })}><Plus className="h-4 w-4" />Add channel…</button>
    </div>
  );
}

export default function Alerts() {
  const { who } = useSession();
  const { data, loading, error, refresh } = usePoll(() => call("kernel.alerts"), 60_000);
  const channels: any[] = data?.channels ?? [];
  const topics: any[] = data?.topics ?? [];
  return (
    <div className="space-y-4">
      <Panel title="Telegram alerts" icon={<BellRing className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="slate">{channels.filter((c) => c.enabled).length} enabled</Badge>}>
        <p className="mb-3 text-[12px] leading-relaxed text-slate-400">
          Where the platform's owner alerts go. A message is sent when an alert opens, changes or is resolved; a failed send is retried at most three times, on that channel only. Changes here take effect at the next run, without a deploy.
        </p>
        {loading && !data ? <Skeleton rows={4} /> : error && !data ? <Empty>{error}</Empty> : data?.available === false ? (
          <Empty>The alert channels table is not there yet: the AI Kernel's next deploy applies migration 0056.</Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">{channels.map((c) => <ChannelCard key={c.channel_id} c={c} topics={topics} reload={refresh} />)}</div>
        )}
      </Panel>
      {who.approver && data?.available !== false && (
        <Panel title="Add a Telegram channel" icon={<Plus className="h-3.5 w-3.5 text-emerald-300" />}>
          {data?.vault === false ? <Empty>The alert vault is not bound yet: the AI Kernel's next deploy adds it.</Empty> : <AddChannel topics={topics} reload={refresh} />}
        </Panel>
      )}
    </div>
  );
}
