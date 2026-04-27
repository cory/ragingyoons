import { useEffect, useMemo, useState } from "react";
import yaml from "js-yaml";
import {
  type Card,
  type CardRef,
  type CardType,
  type CardsByType,
  type ChatMessage,
  fetchAllCards,
  importInlineSynergies,
  saveCard,
  streamChat,
} from "./api";
import { BattleViewer } from "./BattleViewer";

const ENVS = ["city", "suburban", "park", "coastal"] as const;
const CURIOSITIES = ["lockpickers", "tinkerers", "farmers", "barbarians"] as const;
const ROLES = ["tank", "archer", "cavalry", "infantry"] as const;
const TABS: ViewTab[] = ["units", "comps", "battles", "environments", "curiosities", "roles", "synergies", "statuses"];

type ViewTab = "units" | "comps" | "battles" | "environments" | "curiosities" | "roles" | "synergies" | "statuses";

interface CompBin {
  id: string;
  count: number;
}

export function App() {
  const [cards, setCards] = useState<CardsByType | null>(null);
  const [selected, setSelected] = useState<CardRef | null>(null);
  const [tab, setTab] = useState<ViewTab>("units");
  const [chatFocus, setChatFocus] = useState<CardRef[]>([]);
  const [compsInWorkspace, setCompsInWorkspace] = useState<string[]>([]);

  async function reload() {
    setCards(await fetchAllCards());
  }
  useEffect(() => {
    reload().catch(console.error);
  }, []);

  // Live updates: subscribe to /api/events and refetch on cards-changed.
  // Debounce so a burst of writes (claude editing many cards at once) folds
  // into a single refetch.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource("/api/events");
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => reload().catch(console.error), 200);
    };
    es.addEventListener("cards-changed", onChange);
    es.addEventListener("error", () => {
      // EventSource auto-reconnects; nothing to do here.
    });
    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, []);

  const selectedCard: Card | null = useMemo(() => {
    if (!cards || !selected) return null;
    return cards[selected.type].find((c) => c.id === selected.id) ?? null;
  }, [cards, selected]);

  const isDraft = !!selected && !selectedCard;
  const draftCard: Card | null = useMemo(() => {
    if (!isDraft || !selected) return null;
    return synthesizeDraft(selected.type, selected.id);
  }, [isDraft, selected]);

  const editingCard = selectedCard ?? draftCard;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Raging Yoons — Designer</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={tab === t ? "tab tab-active" : "tab"}
              onClick={() => setTab(t)}
            >
              {t}
              {t !== "battles" && (
                <span className="tab-count">
                  {(cards?.[t as keyof CardsByType])?.length ?? 0}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>
      <main className="main">
        <aside className="sidebar">
          {tab === "battles" ? (
            <div className="hint" style={{ padding: 12 }}>
              Use the controls in the canvas pane to pick comps and run battles.
              Each run produces a tile here you can scrub through.
            </div>
          ) : tab === "units" ? (
            <UnitGrid
              units={cards?.units ?? []}
              selected={selected}
              onSelect={setSelected}
              chatFocus={chatFocus}
              onToggleFocus={(ref) => toggleFocus(setChatFocus, ref)}
            />
          ) : tab === "comps" ? (
            <CompSidebar
              comps={cards?.comps ?? []}
              workspace={compsInWorkspace}
              onToggleWorkspace={(id) =>
                setCompsInWorkspace((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                )
              }
              onNew={() => {
                const id = `comp-${Date.now().toString(36)}`;
                setSelected({ type: "comps", id });
                setCompsInWorkspace((prev) => (prev.includes(id) ? prev : [...prev, id]));
              }}
              chatFocus={chatFocus}
              onToggleFocus={(ref) => toggleFocus(setChatFocus, ref)}
            />
          ) : tab === "synergies" ? (
            <SynergyList
              cards={cards?.synergies ?? []}
              selected={selected}
              onSelect={setSelected}
              chatFocus={chatFocus}
              onToggleFocus={(ref) => toggleFocus(setChatFocus, ref)}
              onImport={async () => {
                await importInlineSynergies();
                await reload();
              }}
              onNew={() => setSelected({ type: "synergies", id: "synergy-new" })}
            />
          ) : (
            <CardList
              type={tab}
              cards={cards?.[tab] ?? []}
              selected={selected}
              onSelect={setSelected}
              chatFocus={chatFocus}
              onToggleFocus={(ref) => toggleFocus(setChatFocus, ref)}
              onNew={() => setSelected({ type: tab, id: `${tab.slice(0, -1)}-new` })}
            />
          )}
        </aside>
        <section className="editor">
          {tab === "battles" ? (
            <BattleViewer />
          ) : tab === "comps" && cards ? (
            <CompWorkspace
              workspace={compsInWorkspace}
              cards={cards}
              draftSelected={selected?.type === "comps" ? selected : null}
              onCloseComp={(id) =>
                setCompsInWorkspace((prev) => prev.filter((x) => x !== id))
              }
              onSaved={async (savedId) => {
                await reload();
                setCompsInWorkspace((prev) => (prev.includes(savedId) ? prev : [...prev, savedId]));
              }}
              onChatPin={(id) => toggleFocus(setChatFocus, { type: "comps", id })}
              chatFocus={chatFocus}
            />
          ) : editingCard ? (
            <CardEditor
              key={`${editingCard.type}/${editingCard.id}`}
              card={editingCard}
              isDraft={isDraft}
              onSaved={(saved) => {
                reload().then(() => setSelected({ type: saved.type, id: saved.id }));
              }}
            />
          ) : (
            <div className="empty">select a card</div>
          )}
        </section>
        <section className="chat">
          <ChatPanel focus={chatFocus} />
        </section>
      </main>
    </div>
  );
}

function toggleFocus(setFocus: React.Dispatch<React.SetStateAction<CardRef[]>>, ref: CardRef) {
  setFocus((prev) => {
    const i = prev.findIndex((r) => r.type === ref.type && r.id === ref.id);
    if (i >= 0) return prev.filter((_, j) => j !== i);
    return [...prev, ref];
  });
}

// ---------- unit grid ----------

function UnitGrid(props: {
  units: Card[];
  selected: CardRef | null;
  onSelect: (ref: CardRef) => void;
  chatFocus: CardRef[];
  onToggleFocus: (ref: CardRef) => void;
}) {
  const byCell = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const u of props.units) {
      const env = String(u.frontmatter.environment ?? "");
      const cur = String(u.frontmatter.curiosity ?? "");
      const role = String(u.frontmatter.role ?? "");
      const key = `${env}|${cur}|${role}`;
      const list = m.get(key) ?? [];
      list.push(u);
      m.set(key, list);
    }
    return m;
  }, [props.units]);

  return (
    <div className="grid">
      <div className="grid-help">
        Cells = environment × curiosity. Each role can hold multiple units at different costs.
      </div>
      <table className="grid-table">
        <thead>
          <tr>
            <th></th>
            {CURIOSITIES.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {ENVS.map((env) => (
            <tr key={env}>
              <th>{env}</th>
              {CURIOSITIES.map((cur) => (
                <td key={cur}>
                  <div className="cell">
                    {ROLES.map((role) => {
                      const list = (byCell.get(`${env}|${cur}|${role}`) ?? []).slice().sort(
                        (a, b) =>
                          (Number(a.frontmatter.cost) || 0) - (Number(b.frontmatter.cost) || 0),
                      );
                      const used = new Set(list.map((u) => u.id));
                      let draftId = `${env}-${cur}-${role}-new`;
                      let n = 2;
                      while (used.has(draftId)) draftId = `${env}-${cur}-${role}-new${n++}`;
                      const isDraftSelected =
                        !!props.selected &&
                        props.selected.type === "units" &&
                        props.selected.id.startsWith(`${env}-${cur}-${role}-`) &&
                        !used.has(props.selected.id);
                      return (
                        <div key={role} className="role-slot">
                          {list.map((u) => (
                            <CardChip
                              key={u.id}
                              card={u}
                              label={`${role[0].toUpperCase()}${String(u.frontmatter.cost ?? "?")} · ${String(u.frontmatter.name ?? u.id)}`}
                              selected={
                                !!props.selected &&
                                props.selected.type === "units" &&
                                props.selected.id === u.id
                              }
                              inFocus={props.chatFocus.some((r) => r.id === u.id)}
                              onClick={() => props.onSelect({ type: "units", id: u.id })}
                              onToggleFocus={() => props.onToggleFocus({ type: "units", id: u.id })}
                            />
                          ))}
                          <button
                            className={`cell-empty ${isDraftSelected ? "cell-empty-active" : ""}`}
                            title={`new ${env}-${cur}-${role} unit`}
                            onClick={() => props.onSelect({ type: "units", id: draftId })}
                          >
                            + {role[0].toUpperCase()}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- card list (envs / curiosities / roles) ----------

function CardList(props: {
  type: ViewTab;
  cards: Card[];
  selected: CardRef | null;
  onSelect: (ref: CardRef) => void;
  chatFocus: CardRef[];
  onToggleFocus: (ref: CardRef) => void;
  onNew: () => void;
}) {
  return (
    <div className="card-list">
      <button className="new-btn" onClick={props.onNew}>+ new {props.type.slice(0, -1)}</button>
      {props.cards.map((c) => (
        <CardChip
          key={c.id}
          card={c}
          label={String(c.frontmatter.name ?? c.id)}
          selected={
            !!props.selected &&
            props.selected.type === c.type &&
            props.selected.id === c.id
          }
          inFocus={props.chatFocus.some((r) => r.id === c.id && r.type === c.type)}
          onClick={() => props.onSelect({ type: c.type, id: c.id })}
          onToggleFocus={() => props.onToggleFocus({ type: c.type, id: c.id })}
        />
      ))}
    </div>
  );
}

// ---------- synergy list ----------

function SynergyList(props: {
  cards: Card[];
  selected: CardRef | null;
  onSelect: (ref: CardRef) => void;
  chatFocus: CardRef[];
  onToggleFocus: (ref: CardRef) => void;
  onImport: () => Promise<void>;
  onNew: () => void;
}) {
  const [importing, setImporting] = useState(false);
  return (
    <div className="card-list">
      <div className="row">
        <button className="new-btn" onClick={props.onNew}>+ new synergy</button>
        <button
          className="new-btn"
          disabled={importing}
          onClick={async () => {
            setImporting(true);
            try {
              await props.onImport();
            } finally {
              setImporting(false);
            }
          }}
        >
          {importing ? "importing…" : "import inline"}
        </button>
      </div>
      <div className="hint">"import inline" generates a card per synergy from the env/curiosity arrays.</div>
      {props.cards.map((c) => {
        const fm = c.frontmatter as Record<string, unknown>;
        const label = `${String(fm.owner ?? "?")} · ${String(fm.threshold ?? "?")} · ${String(fm.effect ?? "")}`.slice(0, 80);
        return (
          <CardChip
            key={c.id}
            card={c}
            label={label}
            selected={
              !!props.selected &&
              props.selected.type === c.type &&
              props.selected.id === c.id
            }
            inFocus={props.chatFocus.some((r) => r.id === c.id && r.type === c.type)}
            onClick={() => props.onSelect({ type: c.type, id: c.id })}
            onToggleFocus={() => props.onToggleFocus({ type: c.type, id: c.id })}
          />
        );
      })}
    </div>
  );
}

// ---------- comp sidebar ----------

function CompSidebar(props: {
  comps: Card[];
  workspace: string[];
  onToggleWorkspace: (id: string) => void;
  onNew: () => void;
  chatFocus: CardRef[];
  onToggleFocus: (ref: CardRef) => void;
}) {
  return (
    <div className="card-list">
      <button className="new-btn" onClick={props.onNew}>+ new comp</button>
      <div className="hint">click a comp to add to workspace; ★ pins to chat.</div>
      {props.comps.map((c) => {
        const inWorkspace = props.workspace.includes(c.id);
        return (
          <div
            key={c.id}
            className={`chip ${inWorkspace ? "chip-selected" : ""} ${props.chatFocus.some((r) => r.id === c.id && r.type === "comps") ? "chip-focus" : ""}`}
          >
            <button
              className="chip-main"
              onClick={() => props.onToggleWorkspace(c.id)}
              title={c.id}
            >
              {String(c.frontmatter.name ?? c.id)}
            </button>
            <button
              className="chip-focus-btn"
              onClick={() => props.onToggleFocus({ type: "comps", id: c.id })}
              title="pin to chat"
            >
              {props.chatFocus.some((r) => r.id === c.id && r.type === "comps") ? "★" : "☆"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------- chip ----------

function CardChip(props: {
  card: Card;
  label: string;
  selected: boolean;
  inFocus: boolean;
  onClick: () => void;
  onToggleFocus: () => void;
}) {
  const { card, label, selected, inFocus, onClick, onToggleFocus } = props;
  return (
    <div className={`chip ${selected ? "chip-selected" : ""} ${inFocus ? "chip-focus" : ""}`}>
      <button className="chip-main" onClick={onClick} title={card.id}>
        {label}
      </button>
      <button
        className="chip-focus-btn"
        onClick={onToggleFocus}
        title={inFocus ? "remove from chat focus" : "add to chat focus"}
      >
        {inFocus ? "★" : "☆"}
      </button>
    </div>
  );
}

// ---------- card editor ----------

function CardEditor(props: {
  card: Card;
  isDraft: boolean;
  onSaved: (saved: { type: Card["type"]; id: string }) => void;
}) {
  const { card, isDraft } = props;
  const [draftId, setDraftId] = useState(card.id);
  const [yamlText, setYamlText] = useState(() => yaml.dump(card.frontmatter, { sortKeys: false, lineWidth: 100 }));
  const [body, setBody] = useState(card.body);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraftId(card.id);
    setYamlText(yaml.dump(card.frontmatter, { sortKeys: false, lineWidth: 100 }));
    setBody(card.body);
    setError(null);
  }, [card.id, card.type]);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const fm = yaml.load(yamlText);
      if (!fm || typeof fm !== "object") throw new Error("frontmatter must be an object");
      const id = isDraft ? draftId.trim() : card.id;
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
        throw new Error("id must be lowercase letters, digits, _ or - (no spaces)");
      }
      const fmWithId = { ...(fm as Record<string, unknown>), id };
      await saveCard({ ...card, id, frontmatter: fmWithId, body });
      props.onSaved({ type: card.type, id });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="editor-pane">
      <div className="editor-head">
        {isDraft ? (
          <span className="editor-id">
            <span className="badge-new">NEW</span>
            <span className="editor-type">{card.type}/</span>
            <input
              className="editor-id-input"
              value={draftId}
              onChange={(e) => setDraftId(e.target.value)}
              spellCheck={false}
            />
          </span>
        ) : (
          <span className="editor-id">{card.type}/{card.id}</span>
        )}
        <button onClick={onSave} disabled={saving}>
          {saving ? "saving…" : isDraft ? "create (commit + push)" : "save (commit + push)"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <label className="editor-label">frontmatter (yaml)</label>
      <textarea
        className="editor-yaml"
        value={yamlText}
        onChange={(e) => setYamlText(e.target.value)}
        spellCheck={false}
      />
      <label className="editor-label">notes (markdown)</label>
      <textarea
        className="editor-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

// ---------- comp workspace ----------

interface CompMetrics {
  totalCost: number;
  totalBins: number;
  totalRaccoons: number;
  hp: number;
  dps: number;
  roleMix: Record<string, number>;
  envCount: Record<string, number>;
  curCount: Record<string, number>;
  activeSynergies: Array<{ axis: "environment" | "curiosity"; owner: string; threshold: number; effect: string; count: number }>;
}

function computeMetrics(bins: CompBin[], cards: CardsByType): CompMetrics {
  const m: CompMetrics = {
    totalCost: 0,
    totalBins: 0,
    totalRaccoons: 0,
    hp: 0,
    dps: 0,
    roleMix: {},
    envCount: {},
    curCount: {},
    activeSynergies: [],
  };
  for (const b of bins) {
    const u = cards.units.find((x) => x.id === b.id);
    if (!u) continue;
    const fm = u.frontmatter as Record<string, any>;
    const stats = fm.stats ?? {};
    const bin = fm.bin ?? {};
    const garrison = Number(bin.garrison_cap) || 0;
    const cost = Number(fm.cost) || 0;
    m.totalCost += cost * b.count;
    m.totalBins += b.count;
    m.totalRaccoons += garrison * b.count;
    m.hp += (Number(stats.hp) || 0) * garrison * b.count;
    m.dps += (Number(stats.damage) || 0) * (Number(stats.attack_rate) || 0) * garrison * b.count;
    const role = String(fm.role ?? "");
    if (role) m.roleMix[role] = (m.roleMix[role] ?? 0) + b.count;
    const env = String(fm.environment ?? "");
    if (env) m.envCount[env] = (m.envCount[env] ?? 0) + b.count;
    const cur = String(fm.curiosity ?? "");
    if (cur) m.curCount[cur] = (m.curCount[cur] ?? 0) + b.count;
  }
  for (const env of cards.environments) {
    const id = env.id;
    const count = m.envCount[id] ?? 0;
    const list = (env.frontmatter as any).synergies ?? [];
    for (const s of list) {
      if (s && count >= Number(s.threshold)) {
        m.activeSynergies.push({ axis: "environment", owner: id, threshold: Number(s.threshold), effect: String(s.effect ?? ""), count });
      }
    }
  }
  for (const cur of cards.curiosities) {
    const id = cur.id;
    const count = m.curCount[id] ?? 0;
    const list = (cur.frontmatter as any).synergies ?? [];
    for (const s of list) {
      if (s && count >= Number(s.threshold)) {
        m.activeSynergies.push({ axis: "curiosity", owner: id, threshold: Number(s.threshold), effect: String(s.effect ?? ""), count });
      }
    }
  }
  m.activeSynergies.sort((a, b) => b.threshold - a.threshold || a.owner.localeCompare(b.owner));
  return m;
}

function CompWorkspace(props: {
  workspace: string[];
  cards: CardsByType;
  draftSelected: CardRef | null;
  onCloseComp: (id: string) => void;
  onSaved: (id: string) => void;
  onChatPin: (id: string) => void;
  chatFocus: CardRef[];
}) {
  const compsToShow: Card[] = [];
  for (const id of props.workspace) {
    const real = props.cards.comps.find((c) => c.id === id);
    if (real) {
      compsToShow.push(real);
    } else if (props.draftSelected && props.draftSelected.id === id) {
      compsToShow.push(synthesizeDraft("comps", id));
    }
  }
  if (props.draftSelected && !props.workspace.includes(props.draftSelected.id)) {
    compsToShow.push(synthesizeDraft("comps", props.draftSelected.id));
  }

  if (compsToShow.length === 0) {
    return (
      <div className="empty">
        click a comp in the sidebar to add it to the workspace, or "+ new comp" to start one.
      </div>
    );
  }

  return (
    <div className="comp-workspace">
      {compsToShow.map((c) => (
        <CompPanel
          key={c.id}
          comp={c}
          isDraft={!props.cards.comps.some((x) => x.id === c.id)}
          allCards={props.cards}
          onClose={() => props.onCloseComp(c.id)}
          onSaved={props.onSaved}
          onChatPin={() => props.onChatPin(c.id)}
          isPinned={props.chatFocus.some((r) => r.type === "comps" && r.id === c.id)}
        />
      ))}
    </div>
  );
}

function CompPanel(props: {
  comp: Card;
  isDraft: boolean;
  allCards: CardsByType;
  onClose: () => void;
  onSaved: (id: string) => void;
  onChatPin: () => void;
  isPinned: boolean;
}) {
  const { comp, isDraft, allCards } = props;
  const initialBins: CompBin[] = useMemo(() => {
    const arr = (comp.frontmatter.bins as CompBin[]) ?? [];
    return arr.map((b) => ({ id: String((b as any).id), count: Number((b as any).count) || 1 }));
  }, [comp.id]);
  const [name, setName] = useState(String(comp.frontmatter.name ?? comp.id));
  const [bins, setBins] = useState<CompBin[]>(initialBins);
  const [notes, setNotes] = useState(comp.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [draftId, setDraftId] = useState(comp.id);

  useEffect(() => {
    setName(String(comp.frontmatter.name ?? comp.id));
    setBins(initialBins);
    setNotes(comp.body);
    setDraftId(comp.id);
    setError(null);
  }, [comp.id]);

  const metrics = useMemo(() => computeMetrics(bins, allCards), [bins, allCards]);

  function setBinCount(id: string, count: number) {
    setBins((prev) => {
      if (count <= 0) return prev.filter((b) => b.id !== id);
      const i = prev.findIndex((b) => b.id === id);
      if (i >= 0) {
        const next = prev.slice();
        next[i] = { ...next[i], count };
        return next;
      }
      return [...prev, { id, count }];
    });
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const id = isDraft ? draftId.trim() : comp.id;
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("bad id");
      const frontmatter = {
        type: "comp",
        id,
        name,
        bins,
      };
      await saveCard({ ...comp, id, frontmatter, body: notes });
      props.onSaved(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onDuplicate() {
    const newId = `${comp.id}-copy-${Date.now().toString(36).slice(-4)}`;
    try {
      await saveCard({
        type: "comps",
        id: newId,
        frontmatter: { type: "comp", id: newId, name: `${name} (copy)`, bins },
        body: notes,
      });
      props.onSaved(newId);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="comp-panel">
      <div className="comp-head">
        <input
          className="comp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="comp name"
        />
        <div className="comp-actions">
          <button onClick={props.onChatPin} title="pin to chat">{props.isPinned ? "★" : "☆"}</button>
          {!isDraft && <button onClick={onDuplicate} title="duplicate">⧉</button>}
          <button onClick={onSave} disabled={saving} className="primary">
            {saving ? "…" : isDraft ? "create" : "save"}
          </button>
          <button onClick={props.onClose} title="close">×</button>
        </div>
      </div>
      {isDraft && (
        <div className="comp-id-row">
          <span className="editor-type">comps/</span>
          <input
            className="editor-id-input"
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="comp-stats">
        <div><span>cost</span><b>{metrics.totalCost}</b></div>
        <div><span>bins</span><b>{metrics.totalBins}</b></div>
        <div><span>raccoons</span><b>{metrics.totalRaccoons}</b></div>
        <div><span>HP</span><b>{Math.round(metrics.hp)}</b></div>
        <div><span>DPS</span><b>{Math.round(metrics.dps)}</b></div>
      </div>

      <div className="comp-section-label">role mix</div>
      <div className="role-mix">
        {ROLES.map((r) => (
          <div key={r} className={`role-pill ${(metrics.roleMix[r] ?? 0) === 0 ? "dim" : ""}`}>
            {r[0].toUpperCase()} {metrics.roleMix[r] ?? 0}
          </div>
        ))}
      </div>

      <div className="comp-section-label">bins</div>
      <div className="comp-bins">
        {bins.length === 0 && <div className="hint">no bins yet</div>}
        {bins.map((b) => {
          const u = allCards.units.find((x) => x.id === b.id);
          const role = String(u?.frontmatter.role ?? "?");
          const cost = String(u?.frontmatter.cost ?? "?");
          const env = String(u?.frontmatter.environment ?? "");
          const cur = String(u?.frontmatter.curiosity ?? "");
          return (
            <div key={b.id} className="bin-row">
              <div className="bin-label">
                <b>{u ? String(u.frontmatter.name ?? u.id) : b.id}</b>
                <span className="bin-tags">{role[0]?.toUpperCase()}{cost} · {env} · {cur}</span>
              </div>
              <div className="bin-count">
                <button onClick={() => setBinCount(b.id, b.count - 1)}>−</button>
                <span>{b.count}</span>
                <button onClick={() => setBinCount(b.id, b.count + 1)}>+</button>
              </div>
            </div>
          );
        })}
        {picking ? (
          <BinPicker
            units={allCards.units}
            existing={bins.map((b) => b.id)}
            onPick={(id) => {
              setBinCount(id, 1);
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <button className="add-bin" onClick={() => setPicking(true)}>+ add bin</button>
        )}
      </div>

      <div className="comp-section-label">active synergies</div>
      <div className="comp-synergies">
        {metrics.activeSynergies.length === 0 && <div className="hint">none</div>}
        {metrics.activeSynergies.map((s, i) => (
          <div key={i} className={`synergy-row synergy-${s.axis}`}>
            <span className="synergy-tag">{s.owner} · {s.threshold}</span>
            <span className="synergy-effect">{s.effect}</span>
          </div>
        ))}
      </div>

      <div className="comp-section-label">notes</div>
      <textarea
        className="comp-notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="notes…"
      />
    </div>
  );
}

function BinPicker(props: {
  units: Card[];
  existing: string[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered = props.units
    .filter((u) => !props.existing.includes(u.id))
    .filter((u) => {
      const f = filter.toLowerCase();
      if (!f) return true;
      const fm = u.frontmatter as any;
      return [u.id, fm.name, fm.role, fm.environment, fm.curiosity, fm.cost]
        .map((x) => String(x ?? "").toLowerCase())
        .some((s) => s.includes(f));
    })
    .sort((a, b) => (Number(a.frontmatter.cost) || 0) - (Number(b.frontmatter.cost) || 0));

  return (
    <div className="bin-picker">
      <div className="bin-picker-head">
        <input
          autoFocus
          value={filter}
          placeholder="filter (cost, role, env, curiosity, name)…"
          onChange={(e) => setFilter(e.target.value)}
        />
        <button onClick={props.onCancel}>×</button>
      </div>
      <div className="bin-picker-list">
        {filtered.length === 0 && <div className="hint">no matching units</div>}
        {filtered.slice(0, 30).map((u) => {
          const fm = u.frontmatter as any;
          return (
            <button key={u.id} className="bin-picker-item" onClick={() => props.onPick(u.id)}>
              <b>{String(fm.name ?? u.id)}</b>
              <span>{String(fm.role ?? "?")[0]?.toUpperCase()}{fm.cost ?? "?"} · {fm.environment ?? "?"} · {fm.curiosity ?? "?"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- chat panel ----------

function ChatPanel(props: { focus: CardRef[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    const newMsgs: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(newMsgs);
    setInput("");
    setStreaming(true);
    setPartial("");
    let acc = "";
    try {
      await streamChat(newMsgs, props.focus, (evt) => {
        if (evt.type === "text") {
          acc += evt.text;
          setPartial(acc);
        } else if (evt.type === "error") {
          acc += `\n[error] ${evt.error}`;
          setPartial(acc);
        }
      });
    } catch (e) {
      acc += `\n[fetch error] ${String(e)}`;
    }
    setMessages([...newMsgs, { role: "assistant", content: acc }]);
    setPartial("");
    setStreaming(false);
  }

  return (
    <div className="chat-pane">
      <div className="chat-head">
        chat — focus: {props.focus.length
          ? props.focus.map((r) => `${r.type[0]}:${r.id}`).join(", ")
          : "(none — design docs only)"}
      </div>
      <div className="chat-log">
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-role">{m.role}</div>
            <div className="msg-content">{m.content}</div>
          </div>
        ))}
        {streaming && (
          <div className="msg msg-assistant">
            <div className="msg-role">assistant</div>
            <div className="msg-content">{partial}<span className="cursor">▋</span></div>
          </div>
        )}
      </div>
      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="ask about the design… (cmd/ctrl+enter to send)"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={streaming || !input.trim()}>send</button>
      </div>
    </div>
  );
}

// ---------- draft synthesis ----------

function synthesizeDraft(type: CardType, id: string): Card {
  if (type === "units") {
    const parts = id.split("-");
    const env = ENVS.find((e) => parts.includes(e));
    const cur = CURIOSITIES.find((c) => parts.includes(c));
    const role = ROLES.find((r) => parts.includes(r));
    const frontmatter: Record<string, unknown> = {
      type: "unit",
      id,
      name: id,
      role: role ?? "",
      environment: env ?? "",
      curiosity: cur ?? "",
      cost: 1,
      stats: { hp: 0, damage: 0, attack_rate: 1, range: 0, speed: 0, armor: 0 },
      bin: { hp: 0, garrison_cap: 0, spawn_cadence: "continuous" },
      rage: {
        capacity: 50,
        attack: { shape: "single-target", damage: 0, range: 0, notes: "" },
      },
      visual: { silhouette: "", color: "", item: "" },
    };
    return { id, type, frontmatter, body: "\n# Notes\n\n" };
  }
  if (type === "environments") {
    return {
      id,
      type,
      frontmatter: {
        type: "environment",
        id,
        name: id,
        color: "",
        vibe: "",
        synergy_theme: "",
        cost_distribution: "",
        synergies: [
          { threshold: 2, effect: "" },
          { threshold: 3, effect: "" },
        ],
      },
      body: "\n# Notes\n\n",
    };
  }
  if (type === "curiosities") {
    return {
      id,
      type,
      frontmatter: {
        type: "curiosity",
        id,
        name: id,
        item: "",
        particle: "",
        synergy_theme: "",
        synergies: [
          { threshold: 2, effect: "" },
          { threshold: 3, effect: "" },
        ],
      },
      body: "\n# Notes\n\n",
    };
  }
  if (type === "roles") {
    return {
      id,
      type,
      frontmatter: {
        type: "role",
        id,
        name: id,
        shape: "",
        behavior: {},
        rage_gain: "",
      },
      body: "\n# Notes\n\n",
    };
  }
  if (type === "synergies") {
    return {
      id,
      type,
      frontmatter: {
        type: "synergy",
        id,
        axis: "environment",
        owner: "",
        threshold: 2,
        modifies: "",
        effect: "",
      },
      body: "\n# Notes\n\n",
    };
  }
  if (type === "statuses") {
    return {
      id,
      type,
      frontmatter: {
        type: "status",
        id,
        name: id,
        kind: "debuff", // debuff / dot / buff / control
        modifies: "",
        magnitude: 0,
        duration: 0,
        stack: "refresh", // refresh / stack / ignore
      },
      body: "\n# Notes\n\n",
    };
  }
  if (type === "comps") {
    return {
      id,
      type,
      frontmatter: {
        type: "comp",
        id,
        name: id,
        bins: [] as CompBin[],
      },
      body: "\n# Notes\n\n",
    };
  }
  return { id, type, frontmatter: { id, type }, body: "" };
}
