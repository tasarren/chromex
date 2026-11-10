// DOM-free fixture model shared by the page, its frame and tests: case state, rendering, card ordering
// and drag records. Every list and payload is bounded. Each side of a drag records only what it saw;
// the model never derives a transfer verdict from those records.

export const LOG_LIMIT = 40
export const HISTORY_LIMIT = 8
export const CARD_IDS = ["alpha", "beta", "gamma"]
export const FRAME_CARD_ID = "delta"
export const PAYLOAD_LIMIT = 48
export const DROP_TARGETS = ["reorder", "local", "pending", "frame", "parent"]
const DROP_EFFECTS = new Set(["none", "copy", "move", "link"])
const DRAG_DATA = /^([a-z]{1,8})@(\d{1,6})\.([pf])\.([0-9a-f]{8})$/

/** Append to a list and keep only its newest `limit` entries. */
export const bounded = (list, item, limit = HISTORY_LIMIT) => [...list, item].slice(-limit)

/** Eight hex digits, fresh per call: drag tokens, frame loads and frame documents never repeat. */
export const nonce = () => crypto.randomUUID().slice(0, 8)

/** Drag token: the cards generation, the source (`p` parent card, `f` frame card) and a per-drag nonce. */
export const gestureToken = (generation, source, id) => `${generation}.${source}.${id}`
export const dragData = (card, token) => `${card}@${token}`

/**
 * Parse drag data read by any target. Only a known card from its own source with a well-formed token is
 * accepted; anything else is reported by length only. A token from another generation is `stale`.
 */
export function parseDrag(raw, generation) {
  const value = typeof raw === "string" ? raw : ""
  const match = value.length <= PAYLOAD_LIMIT ? DRAG_DATA.exec(value) : null
  const fromFrame = match?.[3] === "f"
  const known = match !== null && (fromFrame ? match[1] === FRAME_CARD_ID : CARD_IDS.includes(match[1]))
  if (!known) return { kind: "rejected", length: Math.min(value.length, 99_999) }
  const token = gestureToken(match[2], match[3], match[4])
  return { kind: Number(match[2]) === generation ? "current" : "stale", card: match[1], token, side: fromFrame ? "frame" : "parent" }
}

/**
 * Move `card` within the source order. With `before`, it is placed ahead of that card; without, at the end.
 * Unknown ids leave the order unchanged.
 */
export function reorder(order, card, before) {
  if (!order.includes(card) || card === before) return order
  const rest = order.filter((entry) => entry !== card)
  const index = before === undefined ? -1 : rest.indexOf(before)
  return index === -1 ? [...rest, card] : [...rest.slice(0, index), card, ...rest.slice(index)]
}

// `active` is the started, not yet ended drag; `last` is the most recent ended one, kept so a target
// report that arrives after its source ended still correlates.
const sourceRecord = () => ({ starts: 0, ends: 0, active: "none", last: "none", dropEffect: "none" })

/** Place an accepted parent card after a local or reorder drop. */
function placeCard(state, target, card, before) {
  if (!CARD_IDS.includes(card)) return
  if (target === "local") {
    state.order = state.order.filter((id) => id !== card)
    state.localCards = bounded(state.localCards.filter((id) => id !== card), card, CARD_IDS.length)
  }
  if (target === "reorder") {
    state.localCards = state.localCards.filter((id) => id !== card)
    if (!state.order.includes(card)) state.order = [...state.order, card]
    state.order = reorder(state.order, card, before)
  }
}

function countDrop(state, drop) {
  state.drops[drop.target]++
  state.lastDrop = `${drop.target}:${drop.card}@${drop.token}`
  placeCard(state, drop.target, drop.card, drop.before)
}

/**
 * The bound frame document changed: an unfinished frame drag is lost (its outcome is unknown, not failed),
 * and neither its token nor the last ended one may correlate a later drop.
 */
function unbindFrame(state) {
  if (state.frameSource.active !== "none") state.lost++
  state.frameSource.active = "none"
  state.frameSource.last = "none"
}

// A load whose frame showed a second document: a same-URL reload keeps the load nonce and the window,
// and message order between the two documents is not known, so neither can be trusted again.
const AMBIGUOUS = "ambiguous"

/**
 * Reports from a frame load or frame document other than the bound one cannot describe the current page.
 * Each fixture load binds exactly one document; after an ambiguous reload, everything from that load is stale.
 */
const fromOtherFrame = (state, event) =>
  event.load !== state.frameLoad ||
  state.frameDoc === AMBIGUOUS ||
  (event.type !== "ready" && event.doc !== state.frameDoc)

/**
 * Apply one observed card event and return the next state. Events from another generation, frame load or
 * frame document only count as stale. A drop counts toward its target only when its token is the active
 * or last drag of its source. A frame drop can arrive before the frame's start report, so an unknown token
 * waits as `uncorrelated` until a start with that token claims it; otherwise it never counts.
 */
export function cardEvent(previous, event) {
  const state = structuredClone(previous)
  const framed = event.side === "frame" || event.target === "frame" || event.type === "ready"
  if (event.generation !== state.generation || (framed && fromOtherFrame(state, event))) {
    state.stale++
    return state
  }
  const side = event.side === "frame" ? state.frameSource : state.parentSource
  if (event.type === "click") state.sourceClicks++
  if (event.type === "load") {
    unbindFrame(state)
    Object.assign(state, { frameLoad: event.load, frameDoc: "none", frame: "loading" })
  }
  if (event.type === "ready" && state.frameDoc === "none") Object.assign(state, { frameDoc: event.doc, frame: event.status })
  // A second document in one load is either a reload or a late report from the first: never rebind.
  if (event.type === "ready" && state.frameDoc !== event.doc && state.frameDoc !== AMBIGUOUS) {
    unbindFrame(state)
    Object.assign(state, { frameDoc: AMBIGUOUS, frame: "reloaded-uncertain" })
  }
  if (event.type === "start") {
    side.starts++
    side.active = event.token
    for (const drop of state.waiting.filter((entry) => entry.token === event.token)) countDrop(state, drop)
    state.waiting = state.waiting.filter((entry) => entry.token !== event.token)
  }
  if (event.type === "end" && event.token !== side.active) state.stale++
  if (event.type === "end" && event.token === side.active) {
    side.ends++
    side.last = side.active
    side.active = "none"
    side.dropEffect = DROP_EFFECTS.has(event.dropEffect) ? event.dropEffect : "other"
  }
  if (event.type === "drop") {
    const drag = parseDrag(event.raw, state.generation)
    if (drag.kind === "rejected") state.rejected++
    if (drag.kind === "stale") state.stale++
    if (drag.kind !== "current") return state
    const source = drag.side === "frame" ? state.frameSource : state.parentSource
    const drop = { target: event.target, card: drag.card, token: drag.token, before: event.before }
    if (drag.token === source.active || drag.token === source.last) countDrop(state, drop)
    else state.waiting = bounded(state.waiting, drop)
  }
  return state
}

const list = (items) => items.join(",") || "none"
const sourceLine = (prefix, s) =>
  `${prefix}Starts=${s.starts} ${prefix}Ends=${s.ends} ${prefix}Active=${s.active} ${prefix}Last=${s.last} ${prefix}DropEffect=${s.dropEffect}`

/** Each case: its initial state (given the state it replaces) and the single text line the page shows. */
export const cases = {
  movement: {
    initial: () => ({ moves: 0, first: "none", last: "none", over: "none", order: [], menu: "none", wheels: 0, wheel: 0 }),
    render: (s) =>
      `moves=${s.moves} first=${s.first} last=${s.last} over=${s.over} order=${list(s.order)} menu=${s.menu} wheels=${s.wheels} wheelTop=${s.wheel}`,
  },
  slider: {
    initial: () => ({ value: 20, held: false, changes: 0 }),
    render: (s) => `value=${s.value} held=${s.held} changes=${s.changes}`,
  },
  canvas: {
    initial: () => ({ strokes: 0, points: 0, held: false }),
    render: (s) => `strokes=${s.strokes} points=${s.points} held=${s.held}`,
  },
  selection: {
    initial: () => ({ text: "", held: false }),
    render: (s) => `selected="${s.text}" length=${s.text.length} held=${s.held}`,
  },
  cards: {
    // A reset starts a new generation, so reports from before it cannot count toward the new state.
    initial: (replaced) => ({
      generation: (replaced?.generation ?? 0) + 1,
      order: [...CARD_IDS],
      localCards: [],
      sourceClicks: 0,
      parentSource: sourceRecord(),
      frameSource: sourceRecord(),
      drops: Object.fromEntries(DROP_TARGETS.map((target) => [target, 0])),
      waiting: [],
      lastDrop: "none",
      rejected: 0,
      stale: 0,
      lost: 0,
      frameLoad: "none",
      frameDoc: "none",
      frame: "loading",
    }),
    render: (s) =>
      `order=${list(s.order)} local=${list(s.localCards)} sourceClicks=${s.sourceClicks} ${sourceLine("source", s.parentSource)} ${sourceLine("frame", s.frameSource)} ${DROP_TARGETS.map((target) => `${target}Drops=${s.drops[target]}`).join(" ")} lastDrop=${s.lastDrop} uncorrelated=${s.waiting.length} rejected=${s.rejected} stale=${s.stale} lost=${s.lost} frame=${s.frame}`,
  },
  files: {
    initial: () => ({ enters: 0, drops: 0, files: 0, terminal: "none" }),
    render: (s) => `enters=${s.enters} drops=${s.drops} files=${s.files} terminal=${s.terminal}`,
  },
  lifecycle: {
    initial: () => ({ shifted: false, shiftedClicks: 0 }),
    render: (s, documentId) => `shifted=${s.shifted} shiftedClicks=${s.shiftedClicks} document=${documentId}`,
  },
}
export const CASE_NAMES = Object.keys(cases)
