export type CardType =
  | "units"
  | "environments"
  | "curiosities"
  | "roles"
  | "synergies"
  | "comps"
  | "statuses";

export interface Card {
  id: string;
  type: CardType;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface CardsByType {
  units: Card[];
  environments: Card[];
  curiosities: Card[];
  roles: Card[];
  synergies: Card[];
  comps: Card[];
  statuses: Card[];
}

export async function importInlineSynergies(): Promise<{ created: string[] }> {
  const r = await fetch("/api/import-synergies", { method: "POST" });
  if (!r.ok) throw new Error(`import: ${r.status}`);
  return r.json();
}

export async function fetchAllCards(): Promise<CardsByType> {
  const r = await fetch("/api/cards");
  if (!r.ok) throw new Error(`fetch cards: ${r.status}`);
  return r.json();
}

export async function saveCard(card: Card): Promise<void> {
  const r = await fetch(`/api/cards/${card.type}/${card.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frontmatter: card.frontmatter, body: card.body }),
  });
  if (!r.ok) throw new Error(`save: ${r.status} ${await r.text()}`);
}

export async function deleteCard(type: CardType, id: string): Promise<void> {
  const r = await fetch(`/api/cards/${type}/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete: ${r.status}`);
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CardRef {
  type: CardType;
  id: string;
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "system"; session_id?: string }
  | { type: "result"; subtype?: string; session_id?: string }
  | { type: "stderr"; text: string }
  | { type: "error"; error: string }
  | { type: "done"; code?: number };

export async function streamChat(
  messages: ChatMessage[],
  cards: CardRef[],
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, cards }),
    signal,
  });
  if (!r.ok || !r.body) throw new Error(`chat: ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseSseBlock(block);
      if (evt) onEvent(evt);
    }
  }
}

function parseSseBlock(block: string): ChatEvent | null {
  let event = "message";
  let dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  try {
    const data = JSON.parse(dataLines.join("\n"));
    return { type: event as ChatEvent["type"], ...data };
  } catch {
    return null;
  }
}
