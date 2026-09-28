import { useEffect, useMemo, useState } from "react";
import { Shell } from "./components/Shell";
import { MarketingHome } from "./pages/MarketingHome";
import type { AppMode } from "./domain";
import { AssetPage, CarePage, ContinuityWorkflowPage, FamilyPage, InvitePage, PolicyPage, PortfolioPage, ProductOverview, RecordPage, SettingsPage, StartPage } from "./pages/ApiPages";
import type { AccountSnapshot } from "@steward/shared";

export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [mode, setModeValue] = useState<AppMode>();
  const [environmentError,setEnvironmentError]=useState("");
  useEffect(()=>{void fetch("/api/v1/health/ready").then(async r=>{if(!r.ok)throw Error("Account service unavailable");const body=await r.json();if(!["demo","live"].includes(body.data?.mode))throw Error("Unknown environment");setModeValue(body.data.mode);}).catch(e=>setEnvironmentError(e.message));},[]);
  const [account, setAccount] = useState<AccountSnapshot>();
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    const onClick = (event: MouseEvent) => { const anchor = (event.target as HTMLElement).closest("a"); if (!anchor || anchor.target || anchor.origin !== location.origin || anchor.hasAttribute("download")) return; if (anchor.pathname === location.pathname && anchor.search === location.search && anchor.hash) return; event.preventDefault(); history.pushState({}, "", anchor.href); setPath(location.pathname); };
    window.addEventListener("popstate", onPop); document.addEventListener("click", onClick);
    return () => { window.removeEventListener("popstate", onPop); document.removeEventListener("click", onClick); };
  }, []);
  const page = useMemo(() => {
    if(!mode)return null;
    if (path === "/start") return <StartPage mode={mode} onSession={(next) => { if (next) setAccount(next); }} />;
    if (path.startsWith("/invite/")) return <InvitePage />;
    if (path === "/portfolio") return <PortfolioPage mode={mode} />;
    if (path.startsWith("/portfolio/assets/")) return <AssetPage mode={mode} />;
    if (path === "/care") return <CarePage />;
    if (path === "/family") return <FamilyPage />;
    if (path === "/policy") return <PolicyPage />;
    if (path === "/record") return <RecordPage />;
    if (path === "/continuity") return <ContinuityWorkflowPage />;
    if (path === "/settings") return <SettingsPage />;
    return <ProductOverview mode={mode} />;
  }, [mode, path]);
  if (path === "/" || path === "") return <MarketingHome mode={mode} environmentError={environmentError} />;
  if(!mode)return <main><h1>Steward</h1><p role="status">{environmentError||"Checking configured environment…"}</p></main>;
  return <Shell mode={mode} role={account?.role ?? "viewer"} accountId={account?.id ?? "not-loaded"}>{page}</Shell>;
}
