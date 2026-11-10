// Vergleichswert „entspräche API-Preis“ für Claude-/Codex-Läufe im Terminal-Modus. Preise aus lib/prices.json
// (erzeugt von tools/sync-prices.mjs aus der gepflegten Liste des Hauptprogramms). Rechnung wie computeCost in
// src/server/priceBook.ts (Stufen, Cache-Schreiben nach Haltedauer, Alias-Suche) — nur ein Vergleichswert: im Abo
// wird nichts davon berechnet.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prices.json')
let book
/** Preisliste (oder null, wenn die Datei fehlt/kaputt ist). */
export function priceBook() {
  if (book === undefined) { try { book = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { book = null } }
  return book
}

/** Kleinschreibung; Claude-Kennungen wie „[1m]“ entfallen. */
export const normalizeModel = m => String(m).trim().toLowerCase().replace(/\[[a-z0-9]+\]$/, '')
export function findPrice(model, entries = priceBook()?.entries || []) {
  if (!model || typeof model !== 'string') return null
  const raw = model.trim().toLowerCase(), key = normalizeModel(model)
  const exact = entries.find(e => e.model.toLowerCase() === raw) || entries.find(e => e.model.toLowerCase() === key)
  if (exact) return exact
  return entries.find(e => (e.aliases || []).some(a => a.toLowerCase() === raw || a.toLowerCase() === key)) || null
}

const isCount = n => Number.isSafeInteger(n) && n >= 0
/**
 * Reine Rechnung (wie priceBook.ts › computeCost). u: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens (null = nicht gemeldet), cacheWriteByTtl? }
 * → { exact } | { range:{min,max} } | { unpriceable }
 */
export function computeCost(entry, u) {
  const notes = []
  if (!isCount(u.inputTokens) || !isCount(u.outputTokens) || !isCount(u.cacheReadTokens)) return { unpriceable: 'Ungültige oder fehlende Tokenwerte', notes }
  const cw = u.cacheWriteTokens
  const writeKnown = cw !== null && cw !== undefined
  if (writeKnown && !isCount(cw)) return { unpriceable: 'Ungültiger Cache-Schreibwert', notes }
  const mode = entry.cacheWrite?.mode
  const base = { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, ...(mode === 'ttl' ? { byTtl: entry.cacheWrite.byTtl } : {}), ...(mode === 'flat' ? { flat: entry.cacheWrite.price } : {}) }
  const candidates = [base]
  const tiers = entry.tiers || []
  if (tiers.length) {
    const prompt = u.inputTokens + u.cacheReadTokens + (writeKnown ? cw : 0)
    const first = tiers[0], top = tiers[tiers.length - 1]
    const crosses = first.inclusive ? prompt >= first.above : prompt > first.above
    if (crosses) {
      candidates.push({ input: top.input, output: top.output, cacheRead: top.cacheRead, byTtl: top.cacheWriteByTtl || base.byTtl, flat: top.cacheWrite ?? base.flat })
      notes.push(`Prompt-Summe ${prompt} liegt über der Preisstufe ${first.above}; die Aufteilung auf Einzelanfragen ist nicht gemeldet.`)
    }
  }
  const writeCosts = p => {
    if (!writeKnown) {
      if (mode === 'notCharged') return [0]
      return 'Cache-Schreiben nicht gemeldet'
    }
    if (cw === 0) return [0]
    switch (mode) {
      case 'notCharged': return [0]
      case 'notListed': return 'Cache-Schreibpreis nicht ausgewiesen'
      case 'flat': return [cw * (p.flat ?? entry.cacheWrite.price)]
      case 'ttl': {
        const ttl = p.byTtl || {}
        const split = Object.entries(u.cacheWriteByTtl || {})
        if (split.length && split.every(([k, n]) => isCount(n) && ttl[k] !== undefined) && split.reduce((s, [, n]) => s + n, 0) === cw) return [split.reduce((s, [k, n]) => s + n * ttl[k], 0)]
        const values = Object.values(ttl)
        if (!values.length) return 'Cache-Schreibpreise fehlen'
        notes.push('Cache-Haltedauer nicht (vollständig) gemeldet — Spanne.')
        return [cw * Math.min(...values), cw * Math.max(...values)]
      }
      default: return 'Cache-Schreibpreis unbekannt'
    }
  }
  const totals = []
  for (const p of candidates) {
    const w = writeCosts(p)
    if (typeof w === 'string') return { unpriceable: w, notes }
    for (const write of w) totals.push((u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + write) / 1e6)
  }
  if (totals.some(n => !Number.isFinite(n) || n < 0)) return { unpriceable: 'Ungültige Tokenwerte', notes }
  if (totals.length === 1) return { exact: totals[0], notes }
  return { range: { min: Math.min(...totals), max: Math.max(...totals) }, notes }
}

/**
 * Schätzung für ein Modell: { min, max, exact:boolean, lowerBound?:boolean, entry } oder { unknown: Grund }.
 * Meldet der Agent das Cache-Schreiben nicht (Codex), wird ohne Schreibanteil gerechnet und als Untergrenze markiert.
 */
export function estimate(model, u, entries) {
  const entry = findPrice(model, entries)
  if (!entry) return { unknown: model ? 'Modell nicht in der Preisliste' : 'Modell nicht gemeldet' }
  let c = computeCost(entry, u), lowerBound = false
  if (c.unpriceable && (u.cacheWriteTokens === null || u.cacheWriteTokens === undefined || entry.cacheWrite?.mode === 'notListed')) {
    c = computeCost(entry, { ...u, cacheWriteTokens: 0, cacheWriteByTtl: undefined }); lowerBound = !c.unpriceable && (u.cacheWriteTokens == null || u.cacheWriteTokens > 0)
  }
  if (c.unpriceable) return { unknown: c.unpriceable }
  if (c.range) return { min: c.range.min, max: c.range.max, exact: false, lowerBound, entry }
  return { min: c.exact, max: c.exact, exact: true, lowerBound, entry }
}

/** $-Betrag deutsch formatiert: kleine Beträge mit mehr Stellen. */
export function fmtUsd(n) {
  if (!Number.isFinite(n)) return '?'
  const d = n >= 1 ? 2 : n >= 0.1 ? 3 : 4
  return '$' + n.toFixed(d).replace('.', ',')
}
/** Ganzzahl mit Tausenderpunkten. */
export const fmtInt = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
