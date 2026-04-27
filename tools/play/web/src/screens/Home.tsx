import { CURIOSITIES, ENVIRONMENTS, ROLES } from "../data";
import type { Screen } from "../types";
import { RaccoonAvatar } from "../components/RaccoonAvatar";

interface Props {
  go: (s: Screen) => void;
}

export function Home({ go }: Props) {
  return (
    <div className="screen home" data-screen-label="01 Home">
      <div className="home-bg">
        <div className="home-bg-graffiti">RAGE</div>
        <div className="home-bg-graffiti g2">TRASH</div>
        <div className="home-bg-graffiti g3">BITE</div>
        <div className="home-vignette" />
      </div>
      <header className="home-top">
        <div className="brand">
          <span className="brand-glyph">⚙</span>
          <span className="brand-text">RAGINGYOONS</span>
          <span className="brand-ver">v0.4 · OPEN BETA</span>
        </div>
        <nav className="home-nav">
          <a className="active">PLAY</a>
          <a onClick={() => go("progression")}>ROSTER</a>
          <a onClick={() => go("progression")}>PROGRESSION</a>
          <a>STORE</a>
          <a>NEWS</a>
        </nav>
        <div className="home-user">
          <div className="user-currency"><span className="gold-glyph">¢</span> 14,820</div>
          <div className="user-currency"><span style={{ color: "var(--accent)" }}>★</span> 2,140</div>
          <div className="user-av">
            <RaccoonAvatar archetype="splinter" size={36} />
          </div>
        </div>
      </header>

      <main className="home-main">
        <div className="home-left">
          <div className="home-tag">SEASON 03 · GARBAGE GLAM</div>
          <h1 className="home-title">
            BUILD A<br />
            <span className="title-rage">RAGING</span><br />
            FAMILY.
          </h1>
          <p className="home-sub">
            6-strategist auto-battler. 64 raccoons across <b>4 environments</b>, <b>4 curiosities</b>, <b>4 combat roles</b>.
            Stack synergies. Drop bins. Bite necks.
          </p>

          <div className="home-cta">
            <button className="btn primary" onClick={() => go("lobby")}>
              <span className="btn-label">FIND MATCH</span>
              <span className="btn-sub">RANKED · ~38s queue</span>
            </button>
            <button className="btn ghost" onClick={() => go("lobby")}>
              <span className="btn-label">CASUAL</span>
            </button>
            <button className="btn ghost" onClick={() => go("battle")}>
              <span className="btn-label">PRACTICE</span>
            </button>
          </div>

          <div className="home-rank">
            <div className="rank-tier">
              <div className="rank-tier-name">TRASHLORD III</div>
              <div className="rank-tier-bar">
                <div className="rank-tier-fill" style={{ width: "62%" }} />
              </div>
              <div className="rank-tier-meta"><span>1,840 LP</span><span className="muted">+24 LAST GAME</span></div>
            </div>
            <div className="rank-stats">
              <div><b>62%</b><span>TOP-3</span></div>
              <div><b>18%</b><span>WIN</span></div>
              <div><b>3.2</b><span>AVG</span></div>
            </div>
          </div>
        </div>

        <div className="home-right">
          <div className="hero-stage">
            <div className="hero-spotlight" />
            <div className="hero-raccoon">
              <RaccoonAvatar archetype="glitch" size={320} raging />
            </div>
            <div className="hero-trash hero-trash-1" />
            <div className="hero-trash hero-trash-2" />
            <div className="hero-trash hero-trash-3" />
            <div className="hero-name-card">
              <div className="hcn-row"><span className="muted">FEATURED</span></div>
              <div className="hcn-name">GLITCH</div>
              <div className="hcn-traits">
                <span style={{ color: ENVIRONMENTS.city.color }}>⌬ CITY</span>
                <span style={{ color: CURIOSITIES.tinkerers.color }}>⚡ TINKERER</span>
                <span style={{ color: ROLES.archer.color }}>◆ ARCHER</span>
              </div>
              <div className="hcn-flavor">"the dumpster sang her name."</div>
            </div>
          </div>
        </div>
      </main>

      <footer className="home-foot">
        <div className="foot-pill"><span className="dot live" /> 142,308 RACCOONS ONLINE</div>
        <div className="foot-pill">PATCH 0.4.7 · BARBARIANS BUFFED · KELP NERFED</div>
        <div className="foot-pill">NEXT EVENT · TRASH NIGHT · 2D 14H</div>
      </footer>
    </div>
  );
}
