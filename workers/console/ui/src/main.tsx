import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import NeuralMeshBackground from "./components/NeuralMeshBackground";
import { ACCESS_LOGOUT, ApiError, NEXUS_HOME, whoami } from "./lib/api";
import { SessionProvider, type Who } from "./lib/session";
import { OverviewProvider } from "./lib/overview";

/** Signed in, but this account may use Nexus only (ADR-0011). Offer to switch to one with access. */
function AccessNeeded({ actor }: { actor?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="glass w-full max-w-md p-6 text-[13px]">
        <div className="eyebrow text-cyan-300/80">Cryptophys Cerebrum</div>
        <h1 className="mt-1 text-lg font-semibold text-white">This account cannot open the Cerebrum Console</h1>
        {actor ? <p className="mt-3 text-slate-400">Signed in as <span className="mono break-all text-slate-200">{actor}</span></p> : null}
        <p className="mt-3 text-slate-400">This account can use Nexus. The Cerebrum Console needs an admin account (viewer, operator or approver). Sign in with an account that has access, or ask an owner to grant it on the Users page.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <a href={ACCESS_LOGOUT} className="inline-flex min-h-10 items-center rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-4 font-semibold text-cyan-100 hover:border-cyan-300/60">Switch account</a>
          <a href={NEXUS_HOME} className="inline-flex min-h-10 items-center rounded-lg border border-white/10 px-4 font-semibold text-slate-200 hover:border-white/25">Back to Nexus</a>
        </div>
        <p className="mt-4 text-[11px] text-slate-500">Switch account signs you out of Cloudflare Access. Then open the Console again and sign in with the account that has access.</p>
      </div>
    </div>
  );
}

function Root() {
  const [who, setWho] = useState<Who | null>(null);
  const [err, setErr] = useState<{ status: number; message: string } | null>(null);
  useEffect(() => {
    whoami().then(setWho).catch((e) => setErr({ status: e instanceof ApiError ? e.status : 0, message: e.message }));
  }, []);
  return (
    <>
      <NeuralMeshBackground />
      {err?.status === 403 ? <AccessNeeded /> : err ? (
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="glass max-w-md p-6 text-[13px] text-rose-300">
            <p>Session could not be verified: {err.message}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => location.reload()} className="inline-flex min-h-10 items-center rounded-lg border border-white/10 px-4 font-semibold text-slate-200 hover:border-white/25">Try again</button>
              <a href={ACCESS_LOGOUT} className="inline-flex min-h-10 items-center rounded-lg border border-white/10 px-4 font-semibold text-slate-200 hover:border-white/25">Sign out</a>
            </div>
          </div>
        </div>
      ) : !who ? (
        <div className="flex min-h-screen items-center justify-center"><div className="eyebrow animate-pulse text-cyan-300/80">Verifying session…</div></div>
      ) : (
        <SessionProvider who={who}><OverviewProvider><App /></OverviewProvider></SessionProvider>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
