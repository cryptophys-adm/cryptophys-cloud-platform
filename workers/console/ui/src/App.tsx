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

const SAFE = /^[A-Za-z0-9._@+:-]{1,128}$/;
function parse(hash: string) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const id = parts[1] && SAFE.test(parts[1]) ? parts[1] : undefined;
  return { head: parts[0] ?? "", id };
}

export default function App() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parse(window.location.hash)); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const { head, id } = route;
  let page; let current = head;
  switch (head) {
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
    default: page = <Command />; current = "";
  }
  return <AppShell current={current}>{page}</AppShell>;
}
