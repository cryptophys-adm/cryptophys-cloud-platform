import { useEffect, useState } from "react";
import AppShell from "./components/AppShell";
import Command from "./pages/Command";
import Agents from "./pages/Agents";
import AgentDetail from "./pages/AgentDetail";
import Cognition from "./pages/Cognition";
import Recovery from "./pages/Recovery";
import RecoveryDetail from "./pages/RecoveryDetail";
import Infrastructure from "./pages/Infrastructure";
import Policy from "./pages/Policy";
import Ledger from "./pages/Ledger";
import Pipelines from "./pages/Pipelines";
import Markets from "./pages/Markets";
import Users from "./pages/Users";
import Consensus from "./pages/Consensus";
import Knowledge from "./pages/Knowledge";
import Code from "./pages/Code";
import Organism from "./pages/Organism";
import Owner from "./pages/Owner";
import Alerts from "./pages/Alerts";
import Vision from "./pages/Vision";
import Ask from "./pages/Ask";
import Councils from "./pages/Councils";
import Proposals from "./pages/Proposals";
import Autonomy from "./pages/Autonomy";

const SAFE = /^[A-Za-z0-9._@+:-]{1,128}$/;
function parse(hash: string) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const id = parts[1] && SAFE.test(parts[1]) ? parts[1] : undefined;
  // A third segment, for #/vision/adr/<id> (ADR Steward step 5).
  const sub = id && parts[2] && SAFE.test(parts[2]) ? parts[2] : undefined;
  return { head: parts[0] ?? "", id, sub };
}

export default function App() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parse(window.location.hash)); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const { head, id, sub } = route;
  let page; let current = head;
  switch (head) {
    // Owner 2026-11-11: the Metabolism page duplicated Organism and is removed; an old #/metabolism link lands on Organism.
    case "organism":
    case "metabolism": page = <Organism />; current = "organism"; break;
    // Owner 2026-11-13: the one page where the platform needs a person; every owner email and Telegram message links here.
    // HAIC H0c: #/owner/<item_id> opens one ranked item (the deep link every owner notice carries since H0d).
    case "owner": page = <Owner item={id} />; break;
    // ADR-0016 T0: the organism's vision (mission, identity, constitution, goals and KPIs), read-only, with the ADR
    // Steward's panel: #/vision/adr scrolls to it and #/vision/adr/<id> opens that ADR's row.
    case "vision": page = <Vision section={id} item={sub} />; break;
    // HAIC H1c: "Ask the organism", owners only; #/ask/<conversation id> opens one conversation.
    case "ask": page = <Ask conversation={id} />; break;
    // HAIC H1.5c: Call for Councils; #/councils/<session id> opens one council (its transcript, options and the pick).
    case "councils": page = <Councils council={id} />; break;
    // HAIC H2: typed proposals; #/proposals/<proposal id> opens one (confirm or reject a draft).
    case "proposals": page = <Proposals proposal={id} />; break;
    // HAIC H4: the autonomy dial, per group of consensus actions.
    case "autonomy": page = <Autonomy />; break;
    case "agents": page = id ? <AgentDetail id={id} /> : <Agents />; break;
    case "cognition": page = <Cognition />; break;
    case "consensus": page = <Consensus />; break;
    case "knowledge": page = <Knowledge />; break;
    case "recovery": page = id ? <RecoveryDetail id={id} /> : <Recovery />; break;
    case "infrastructure": page = <Infrastructure />; break;
    case "policy": page = <Policy />; break;
    case "ledger": page = <Ledger />; break;
    case "pipelines": page = <Pipelines />; break;
    case "markets": page = <Markets />; break;
    case "users": page = <Users />; break;
    // Owner 2026-11-13: Telegram alert channels, from the account menu.
    case "alerts": page = <Alerts />; break;
    case "code": page = <Code />; break;
    default: page = <Command />; current = "";
  }
  return <AppShell current={current}>{page}</AppShell>;
}
