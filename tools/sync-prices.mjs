#!/usr/bin/env node
// Erzeugt lib/prices.json (Preisliste für den Vergleichswert „entspräche API-Preis“) aus der gepflegten Liste des
// M3DUSA-Hauptprogramms (src/server/prices/official.json). Das CLI wird getrennt ausgeliefert und liest zur Laufzeit
// NUR lib/prices.json — dieses Skript läuft beim Bauen/Aktualisieren, nicht auf dem Linux-PC.
//   node tools/sync-prices.mjs [pfad/zu/official.json] [ziel.json]
// Ohne Pfad: ../src/server/prices/official.json (Lage im Hauptrepo kode-main/linux-node).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(process.argv[2] || path.join(HERE, '..', '..', 'src', 'server', 'prices', 'official.json'))
const dst = path.resolve(process.argv[3] || path.join(HERE, '..', 'lib', 'prices.json'))

const die = m => { console.error('✗ ' + m); process.exit(1) }
let raw
try { raw = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^﻿/, '')) } catch (e) { die(`Preisliste nicht lesbar (${src}): ${e.message}`) }
if (!Array.isArray(raw.entries)) die('Preisliste ohne entries')

const num = (v, what) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${what}: keine gültige Zahl`); return v }
const ttlMap = (o, what) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, num(v, what + '.' + k)]))
const entries = []
for (const e of raw.entries) {
  try {
    if (typeof e.model !== 'string' || !e.model) throw new Error('model fehlt')
    const cw = e.cacheWrite || { mode: 'notListed' }
    if (!['ttl', 'flat', 'notCharged', 'notListed'].includes(cw.mode)) throw new Error('cacheWrite.mode unbekannt')
    const out = {
      provider: String(e.provider || ''), model: e.model, label: String(e.label || e.model),
      ...(Array.isArray(e.aliases) && e.aliases.length ? { aliases: e.aliases.filter(a => typeof a === 'string') } : {}),
      input: num(e.input, 'input'), output: num(e.output, 'output'), cacheRead: num(e.cacheRead, 'cacheRead'),
      cacheWrite: cw.mode === 'ttl' ? { mode: 'ttl', byTtl: ttlMap(cw.byTtl, 'byTtl') } : cw.mode === 'flat' ? { mode: 'flat', price: num(cw.price, 'cacheWrite.price') } : { mode: cw.mode },
    }
    if (Array.isArray(e.tiers) && e.tiers.length) {
      out.tiers = e.tiers.map(t => ({
        above: num(t.above, 'tier.above'), inclusive: t.inclusive === true, input: num(t.input, 'tier.input'), output: num(t.output, 'tier.output'), cacheRead: num(t.cacheRead, 'tier.cacheRead'),
        ...(t.cacheWriteByTtl ? { cacheWriteByTtl: ttlMap(t.cacheWriteByTtl, 'tier.cacheWriteByTtl') } : {}), ...(typeof t.cacheWrite === 'number' ? { cacheWrite: t.cacheWrite } : {}),
      }))
    }
    entries.push(out)
  } catch (err) { die(`Eintrag ${e?.id || e?.model || '?'}: ${err.message}`) }
}
const fetched = Object.fromEntries(Object.entries(raw.sources || {}).map(([k, v]) => [k, v?.fetchedAt || '']))
const book = { schema: 1, currency: raw.currency || 'USD', unit: raw.unit || 'USD je 1 Mio. Tokens', from: 'src/server/prices/official.json', fetchedAt: fetched, entries }
fs.writeFileSync(dst, JSON.stringify(book, null, 1) + '\n')
console.log(`✓ ${entries.length} Preise → ${dst}`)
