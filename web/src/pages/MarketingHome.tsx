import type { AppMode } from "../domain";

const areas = [
  { number: "01", name: "Portfolio", detail: "See holdings and review available asset routes." },
  { number: "02", name: "Care", detail: "Give a caregiver bounded ways to help." },
  { number: "03", name: "Family", detail: "Know who has access, and change it when needed." },
  { number: "04", name: "Record", detail: "Keep proposals, approvals, and receipts together." },
  { number: "05", name: "Continuity", detail: "Prepare for recovery and succession with separate checks." },
];

function EntryLink({ mode }: { mode?: AppMode }) {
  if (mode === "demo") return <a className="marketing-button" href="/start?mode=demo">Explore the fake-funds demo <span aria-hidden="true">↗</span></a>;
  if (mode === "live") return <a className="marketing-button" href="/start?mode=live">Open your account <span aria-hidden="true">↗</span></a>;
  return <span className="marketing-button marketing-button-disabled" aria-disabled="true">Checking account service…</span>;
}

export function MarketingHome({ mode, environmentError }: { mode?: AppMode; environmentError: string }) {
  return <div className="marketing-home">
    <a className="marketing-skip" href="#main-content">Skip to content</a>
    <header className="marketing-header">
      <a className="marketing-wordmark" href="/" aria-label="Steward home">Steward<span className="marketing-mark" aria-hidden="true">✳</span></a>
      <nav aria-label="About Steward"><a href="#the-idea">The idea</a><a href="#five-areas">Five areas</a><a href="#status">Status</a></nav>
      <a className="marketing-nav-cta" href="/start">Enter app <span aria-hidden="true">↗</span></a>
    </header>

    <main id="main-content">
      <section className="marketing-hero" aria-labelledby="marketing-heading">
        <picture><source media="(prefers-reduced-motion: reduce)" srcSet="/brand/steward-paper-banner.jpg" /><img className="marketing-banner-art" src="/brand/steward-paper-banner.gif" alt="Steward in folded paper lettering, with the orange-capped paper mascot peeking over it" /></picture>
        <div className="marketing-hero-grid">
          <div className="marketing-hero-copy">
            <span className="marketing-pill">Parent-owned · Family-supported</span>
            <h1 id="marketing-heading">Help for the family.<br /><em>Control for the parent.</em></h1>
            <p>Steward lets a parent set clear boundaries for a caregiver who helps manage an account. The rules, records, and continuity plan stay connected, while ownership stays with the parent.</p>
            <div className="marketing-hero-actions"><EntryLink mode={mode} /><a className="marketing-text-link" href="#the-idea">See how it works <span aria-hidden="true">↓</span></a></div>
            <p className="marketing-honesty">{environmentError || "In development · Demo uses fake funds · No real-money trading through this app yet"}</p>
          </div>
          <div className="marketing-mascot-frame"><img src="/brand/steward-mascot.jpg" alt="Friendly folded-paper Steward character wearing an orange cap and sage jacket" /></div>
        </div>
      </section>

      <section className="marketing-principle" id="the-idea" aria-labelledby="principle-heading">
        <div className="marketing-principle-mark" aria-hidden="true">✳</div>
        <div><p className="marketing-kicker">THE SIMPLE RULE</p><h2 id="principle-heading">A family relationship alone <em>does not grant access.</em></h2><p>A parent chooses who may help, what they may do, and how much. Caregiver permission can be limited and revoked. A family case record is separate from the on-chain authority that controls an account.</p></div>
      </section>

      <section className="marketing-areas" id="five-areas" aria-labelledby="areas-heading">
        <div className="marketing-section-heading"><div><p className="marketing-kicker">ONE FAMILY · FIVE CONNECTED AREAS</p><h2 id="areas-heading">The care picture, together.</h2></div><span className="marketing-planned">Planned experience</span></div>
        <div className="marketing-area-grid">{areas.map((area) => <article className="marketing-area" key={area.name}><span>{area.number}</span><h3>{area.name}</h3><p>{area.detail}</p></article>)}</div>
        <p className="marketing-small-note">The areas exist in the working app; individual workflows are still being developed and tested. An asset appears only when its route is available to that account.</p>
      </section>

      <section className="marketing-approval" aria-labelledby="approval-heading">
        <div className="marketing-approval-copy"><p className="marketing-kicker">DEVELOPER NOTE · PROPOSED</p><h2 id="approval-heading">Specific actions deserve specific approval.</h2><p>Steward already separates caregiver authority from app access. An additional exact-action approval flow is proposed so a parent could review a particular amount, destination, and deadline before it is used.</p><p className="marketing-small-note">This proposed flow is not being presented as a live control.</p></div>
        <img src="/brand/steward-approval-note.jpg" alt="Paper-cut developer note reading Exact-action approvals, Proposed" loading="lazy" />
      </section>

      <section className="marketing-status" id="status" aria-labelledby="status-heading">
        <img src="/brand/steward-in-development.jpg" alt="The Steward paper mascot above an In Development sign" loading="lazy" />
        <div><p className="marketing-kicker">WHERE THINGS STAND</p><h2 id="status-heading">Built to test. Still in development.</h2><p>Steward has a local fake-funds demo and mock-asset testnet rehearsals. Real-money use needs reviewed contracts, live operations, and a separately cleared asset route for each relevant market and user.</p><EntryLink mode={mode} /><p className="marketing-small-note">Testnet assets have no value. A disclaimer or successful test does not make a stock-linked token available to everyone.</p></div>
      </section>
    </main>

    <footer className="marketing-footer"><span>Steward · Parent-owned care, with boundaries.</span><span>In development · © 2026 Steward</span><a href="/start">Open app</a></footer>
  </div>;
}
