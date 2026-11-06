import { useState } from "react";
import { GitBranch, Rocket } from "lucide-react";
import { Field, JsonView, Panel } from "../components/ui";
import { useSession } from "../lib/session";

export default function Pipelines() {
  const { act, notify } = useSession();
  const [sha, setSha] = useState("");
  const [out, setOut] = useState<unknown>(null);
  return (
    <Panel title="Production Deployment" icon={<GitBranch className="h-3.5 w-3.5 text-cyan-300" />}>
      <p className="mb-3 text-[12px] leading-relaxed text-slate-400">The Deployment Orchestrator decides: it checks the deploy allow-list, CI status and the deployment lock before dispatching. A 403 or 503 response is expected for most identities.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
        <Field label="Commit SHA (40 hex)"><input className="field mono" maxLength={40} value={sha} onChange={(e) => setSha(e.target.value)} /></Field>
        <div className="flex items-end"><button type="button" className="btn btn-danger" onClick={() => {
          const v = sha.trim().toLowerCase();
          if (!/^[0-9a-f]{40}$/.test(v)) { notify("err", "Commit SHA must be 40 hex characters."); return; }
          act({ route: "orchestrator.deploy", body: { commit_sha: v, confirm_production: "DEPLOY" }, title: `Deploy ${v.slice(0, 12)}`, lines: [`Requests a production deployment of commit ${v}.`], done: "Deployment request sent.",
            after: (d) => setOut(d), onError: (e: any) => setOut({ status: e.status, response: e.data }) });
        }}><Rocket className="h-3.5 w-3.5" />Deploy…</button></div>
      </div>
      {out !== null && <div className="mt-3"><JsonView value={out} /></div>}
    </Panel>
  );
}
