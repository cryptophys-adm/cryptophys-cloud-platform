import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import NeuralMeshBackground from "./components/NeuralMeshBackground";
import { whoami } from "./lib/api";
import { SessionProvider, type Who } from "./lib/session";
import { OverviewProvider } from "./lib/overview";

function Root() {
  const [who, setWho] = useState<Who | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { whoami().then(setWho).catch((e) => setErr(e.message)); }, []);
  return (
    <>
      <NeuralMeshBackground />
      {err ? (
        <div className="flex min-h-screen items-center justify-center p-6"><div className="glass max-w-md p-6 text-[13px] text-rose-300">Session could not be verified: {err}</div></div>
      ) : !who ? (
        <div className="flex min-h-screen items-center justify-center"><div className="eyebrow animate-pulse text-cyan-300/80">Verifying session…</div></div>
      ) : (
        <SessionProvider who={who}><OverviewProvider><App /></OverviewProvider></SessionProvider>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
