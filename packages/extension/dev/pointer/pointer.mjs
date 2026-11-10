// Observes real input on the fixture page and renders each case's state as readable text.
// It never dispatches synthetic input; `isTrusted` is logged as a browser fact, not as agent identity.
/* global document, location, getSelection, addEventListener, innerWidth, innerHeight, devicePixelRatio, scrollY */
import {
  bounded, cardEvent, CARD_IDS, CASE_NAMES, cases, dragData, gestureToken, LOG_LIMIT, nonce, PAYLOAD_LIMIT,
} from "./model.mjs"

// Changes only when the document is replaced, so a reload is distinguishable from a case reset.
const DOCUMENT_ID = crypto.randomUUID().slice(0, 8)
const $ = (id) => document.getElementById(id)
const log = $("log")
const frame = $("card-frame")
// localhost and 127.0.0.1 are distinct sites, so switching hosts gives a cross-site frame.
const sameSite = new URL("frame.html", location.href)
const crossSite = new URL(sameSite)
crossSite.hostname = location.hostname === "localhost" ? "127.0.0.1" : "localhost"
// Only the frame document most recently requested may report.
let frameOrigin = sameSite.origin

function record(type, detail = "") {
  const item = document.createElement("li")
  item.textContent = `${type}${detail ? ` ${detail}` : ""}`
  log.append(item)
  while (log.children.length > LOG_LIMIT) log.firstElementChild.remove()
  log.scrollTop = log.scrollHeight
}

const point = (event) =>
  `x=${Math.round(event.clientX)} y=${Math.round(event.clientY)} button=${event.button} buttons=${event.buttons} trusted=${event.isTrusted}`
const targetName = (event) => event.target.id || event.target.dataset?.card || event.target.tagName.toLowerCase()

/** Restores everything a case draws outside its state line: values, styles, order, frame. */
const restore = {
  movement: () => { $("wheel-area").scrollTop = 0 },
  slider: () => { $("slider").value = "20" },
  canvas: () => { const c = $("canvas"); c.getContext("2d").clearRect(0, 0, c.width, c.height) },
  selection: () => getSelection()?.removeAllRanges(),
  cards: () => {
    placeCards()
    loadFrame(sameSite)
  },
  files: () => undefined,
  lifecycle: () => $("shifted").classList.remove("on"),
}

const state = {}
function render(name) {
  $(`state-${name}`).textContent = cases[name].render(state[name], DOCUMENT_ID)
  if (name === "lifecycle") renderGeometry()
}
function reset(name) {
  state[name] = cases[name].initial(state[name])
  restore[name]()
  for (const zone of document.querySelectorAll(".over")) zone.classList.remove("over")
  render(name)
  record("reset", name)
}
function update(name, change) {
  change(state[name])
  render(name)
}

function renderGeometry() {
  const rect = $("shifted").getBoundingClientRect()
  $("state-geometry").textContent =
    `viewport=${innerWidth}x${innerHeight} dpr=${devicePixelRatio} scrollY=${Math.round(scrollY)} shifted=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}`
}

// Movement and buttons. Viewport coordinates over the whole page, so any confirmed move is visible.
document.addEventListener("pointermove", (event) => update("movement", (s) => {
  const at = `${Math.round(event.clientX)},${Math.round(event.clientY)}`
  s.moves++
  if (s.first === "none") s.first = at
  s.last = at
  s.over = targetName(event)
}))
for (const type of ["pointerdown", "pointerup", "click", "dblclick", "contextmenu"]) {
  $("button-target").addEventListener(type, (event) => {
    update("movement", (s) => { s.order = bounded(s.order, type) })
    record(type, point(event))
  })
}
$("menu-page").addEventListener("contextmenu", (event) => {
  event.preventDefault()
  update("movement", (s) => { s.menu = "page" })
  record("contextmenu page-handled", point(event))
})
$("menu-native").addEventListener("contextmenu", (event) => {
  update("movement", (s) => { s.menu = "native" })
  record("contextmenu native", point(event))
})
$("wheel-area").addEventListener("scroll", () => update("movement", (s) => { s.wheel = Math.round($("wheel-area").scrollTop) }))
document.addEventListener("wheel", (event) => {
  update("movement", (s) => { s.wheels++ })
  record("wheel", `deltaY=${event.deltaY} over=${targetName(event)}`)
}, { passive: true })

// Slider: a pause between down and up shows held=true with the current value.
const slider = $("slider")
slider.addEventListener("pointerdown", (event) => { update("slider", (s) => { s.held = true }); record("slider down", point(event)) })
slider.addEventListener("input", () => update("slider", (s) => { s.value = Number(slider.value); s.changes++ }))
for (const type of ["pointerup", "pointercancel"])
  slider.addEventListener(type, (event) => { update("slider", (s) => { s.held = false }); record(`slider ${type.slice(7)}`, point(event)) })

// Canvas stroke.
const canvas = $("canvas")
const pen = canvas.getContext("2d")
const canvasPoint = (event) => {
  const rect = canvas.getBoundingClientRect()
  return [(event.clientX - rect.left) * (canvas.width / rect.width), (event.clientY - rect.top) * (canvas.height / rect.height)]
}
canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId)
  pen.beginPath()
  pen.moveTo(...canvasPoint(event))
  update("canvas", (s) => { s.held = true; s.strokes++; s.points++ })
  record("canvas down", point(event))
})
canvas.addEventListener("pointermove", (event) => {
  if (!state.canvas.held) return
  pen.lineTo(...canvasPoint(event))
  pen.stroke()
  update("canvas", (s) => { s.points++ })
})
for (const type of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(type, (event) => {
    update("canvas", (s) => { s.held = false })
    record(`canvas ${type.slice(7)}`, point(event))
  })
}

// Native text selection.
const selectionText = $("selection-text")
selectionText.addEventListener("pointerdown", () => update("selection", (s) => { s.held = true }))
addEventListener("pointerup", () => { if (state.selection.held) update("selection", (s) => { s.held = false }) })
document.addEventListener("selectionchange", () => {
  const selection = getSelection()
  const inside = selection && selection.rangeCount > 0 && selectionText.contains(selection.anchorNode)
  update("selection", (s) => { s.text = inside ? selection.toString().slice(0, 80) : "" })
})

// Cards: each source and each target records only what it observed. Drag data carries the cards
// generation and a per-drag nonce; the model counts a drop only for its source's own drag.
const card = (id) => document.querySelector(`.card[data-card="${id}"]`)
function placeCards() {
  for (const id of state.cards.order) $("card-source").append(card(id))
  for (const id of state.cards.localCards) $("card-target").append(card(id))
}
function cards(event, note) {
  state.cards = cardEvent(state.cards, event)
  placeCards()
  render("cards")
  if (note) record(note[0], note[1])
}
const readDrag = (event) => event.dataTransfer.getData("text/plain").slice(0, PAYLOAD_LIMIT + 1)
for (const id of CARD_IDS) {
  const element = card(id)
  let gesture = null
  element.addEventListener("click", (event) => cards({ type: "click", generation: state.cards.generation }, ["card click", `${id} ${point(event)}`]))
  element.addEventListener("dragstart", (event) => {
    gesture = { generation: state.cards.generation, token: gestureToken(state.cards.generation, "p", nonce()) }
    event.dataTransfer.setData("text/plain", dragData(id, gesture.token))
    event.dataTransfer.effectAllowed = "move"
    cards({ type: "start", side: "parent", ...gesture }, ["card dragstart", `${id} ${gesture.token}`])
  })
  element.addEventListener("dragend", (event) => {
    const { dropEffect } = event.dataTransfer
    cards({ type: "end", side: "parent", ...gesture, dropEffect }, ["card dragend", `${id} ${gesture?.token} dropEffect=${dropEffect}`])
  })
}
function dropZone(zone, target, before = () => undefined) {
  zone.addEventListener("dragenter", (event) => { event.preventDefault(); zone.classList.add("over") })
  zone.addEventListener("dragover", (event) => event.preventDefault())
  zone.addEventListener("dragleave", () => zone.classList.remove("over"))
  zone.addEventListener("drop", (event) => {
    event.preventDefault()
    zone.classList.remove("over")
    cards({ type: "drop", target, generation: state.cards.generation, raw: readDrag(event), before: before(event) }, ["card drop", target])
  })
}
// Reordering: dropping a source card on another source card places it ahead of that card.
dropZone($("card-source"), "reorder", (event) => event.target.closest?.(".card")?.dataset.card)
dropZone($("card-target"), "local")
dropZone($("pending-target"), "pending")
// Reverse direction: the frame's own card dropped on the parent.
dropZone($("parent-target"), "parent")

// Frame: it learns the cards generation and a per-load nonce from its URL, picks its own document
// nonce, and reports raw observations. The parent accepts reports only from the current frame window at
// the origin it most recently loaded; the model binds them to that load and its ready document.
function loadFrame(url) {
  const next = new URL(url)
  const load = nonce()
  next.searchParams.set("g", String(state.cards.generation))
  next.searchParams.set("l", load)
  frameOrigin = next.origin
  cards({ type: "load", generation: state.cards.generation, load })
  frame.src = next.href
}
const short = (value, limit) => String(value ?? "").slice(0, limit)
addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== frameOrigin) return
  const { type, generation, load, doc, token, dropEffect, raw } = event.data ?? {}
  if (!Number.isSafeInteger(generation)) return
  const site = event.origin === location.origin ? "same-site" : "cross-site"
  const report = {
    ready: { type: "ready", status: `${site}-ready` },
    dragstart: { type: "start", side: "frame", token: short(token, 24) },
    dragend: { type: "end", side: "frame", token: short(token, 24), dropEffect: short(dropEffect, 8) },
    drop: { type: "drop", target: "frame", raw: short(raw, PAYLOAD_LIMIT + 1) },
  }[type]
  if (report) cards({ ...report, generation, load: short(load, 8), doc: short(doc, 8) }, [`frame ${type}`, site])
})
$("frame-site").addEventListener("click", () => loadFrame(crossSite))

// Inert file drop: counts only. Files are never read, named or opened; the exact-byte check is unavailable.
const fileTarget = $("file-target")
fileTarget.addEventListener("dragenter", (event) => { event.preventDefault(); fileTarget.classList.add("over"); update("files", (s) => { s.enters++ }) })
fileTarget.addEventListener("dragover", (event) => event.preventDefault())
fileTarget.addEventListener("dragleave", () => { fileTarget.classList.remove("over"); update("files", (s) => { s.terminal = "dragleave" }) })
fileTarget.addEventListener("drop", (event) => {
  event.preventDefault()
  fileTarget.classList.remove("over")
  const count = event.dataTransfer.files.length
  update("files", (s) => { s.drops++; s.files = count; s.terminal = "drop" })
  record("file drop", `count=${count}`)
})

// Lifecycle and geometry.
$("layout-toggle").addEventListener("click", () => {
  $("shifted").classList.toggle("on")
  update("lifecycle", (s) => { s.shifted = $("shifted").classList.contains("on") })
})
$("shifted").addEventListener("click", (event) => { update("lifecycle", (s) => { s.shiftedClicks++ }); record("shifted click", point(event)) })
$("replace-document").addEventListener("click", () => location.reload())
addEventListener("resize", renderGeometry)
addEventListener("scroll", renderGeometry, { passive: true })

for (const button of document.querySelectorAll("[data-reset]")) button.addEventListener("click", () => reset(button.dataset.reset))
$("reset-all").addEventListener("click", () => {
  for (const name of CASE_NAMES) reset(name)
  log.replaceChildren()
  record("reset", "all")
})

for (const name of CASE_NAMES) state[name] = cases[name].initial()
for (const name of CASE_NAMES) render(name)
loadFrame(sameSite)
$("summary").textContent = `ready cases=${CASE_NAMES.length}`
record("ready", location.origin)
