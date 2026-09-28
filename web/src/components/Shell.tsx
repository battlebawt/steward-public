import type { ReactNode } from "react";
import type { AppMode, Role } from "../domain";

const tabs = [
  ["/portfolio", "Portfolio"], ["/care", "Care"], ["/family", "Family"], ["/record", "Record"], ["/continuity", "Continuity"],
] as const;

export function Shell({ children, mode, role, accountId }: { children: ReactNode; mode: AppMode; role: Role; accountId: string }) {
  return <div className="app-shell">
    <header className="topbar"><a className="wordmark" href="/">Steward</a><span className="role-badge">{role}</span><span className="account-id">Account {accountId}</span><a href="/settings">Settings</a></header>
    {mode === "demo" ? <div className="demo-banner" role="status"><strong>Demo mode</strong> · fake funds · isolated chain 31337 · no real transactions</div> : <div className="live-banner" role="status"><strong>Live mode</strong> · balances and approvals come from the authorized server</div>}
    <nav className="tabs" aria-label="Main sections">{tabs.map(([href, label]) => <a key={href} href={href} className={location.pathname.startsWith(href) ? "active" : ""}>{label}</a>)}</nav>
    <main className="content">{children}</main>
    <footer><a href="/policy">Policy</a><a href="/record">Record</a><span>UTC windows · server authorization required</span></footer>
  </div>;
}

export function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{description ? <p className="lede">{description}</p> : null}</div>{children}</div>;
}

export function LinkButton({ href, children }: { href: string; children: ReactNode }) { return <a className="button" href={href}>{children}</a>; }
