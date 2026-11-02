// Turns data/history.json + data/polls/*.jsonl into the dashboard's CSVs in data/out/.
//   curve.csv         hourly: cheapest seat, GA floor, 100 / 200 / 400 level, tickets listed, per show (5 sites)
//   zones.csv          every poll: GA floor and the middle 100s / 200s sections, from TicketSmarter
//   sites.csv          latest poll: per show x site, cheapest seat / GA floor and tickets listed
//   ticketsmarter.csv  every TicketSmarter poll (single shows and 2-day passes)
//   pass_compare.csv   2-day pass vs the two single nights, per focus zone
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHOWS, PASSES } from './watch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data')
const OUT = join(DATA, 'out')
mkdirSync(OUT, { recursive: true })

const hist = JSON.parse(readFileSync(join(DATA, 'history.json'), 'utf8'))
// data/polls/ is the cloud collector (TicketSmarter), data/tl/polls/ the laptop one (TrackaLacker).
const polls = [join(DATA, 'polls'), join(DATA, 'tl', 'polls')]
  .flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => join(d, f)) : []))
  .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .sort((a, b) => a.t.localeCompare(b.t))

// Sphere's floor is all standing room; sites name it differently.
const isFloor = (z) => /floor|general admission|gaflo/i.test(z)
// Hotel/VIP bundles aren't a seat price.
const isPackage = (z) => /package|deluxe|diamond|gold|reserved/i.test(z)
const isUpper = (z) => /^400 level$/i.test(z)
// The zones Matías wants: GA floor and the middle five sections of the 100 and 200 levels (TicketSmarter
// has sections; Vibee's own "Diamond" tiers put the centre at 103-108 and 203-209).
const FOCUS = { 'GA floor': ['GA'], '100s 104-108': ['104', '105', '106', '107', '108'], '200s 204-208': ['204', '205', '206', '207', '208'] }
const showStart = Object.fromEntries(SHOWS.map((s) => [s.id, Date.parse(s.start)]))

// Fold the polls into each listing's change log so the curve reaches the latest run.
for (const p of polls) {
  if (p.src !== 'trackalacker' || !p.listings) continue
  for (const [id, price, inv] of p.listings) {
    const h = hist.listings[id]
    if (!h) continue
    const last = h.changes.at(-1)
    if (!last || last[1] !== price || last[2] !== inv) h.changes.push([p.t, price, inv])
  }
}
for (const h of Object.values(hist.listings)) h.changes.sort((a, b) => a[0].localeCompare(b[0]))

const HOUR = 3600e3
const lastPoll = {}
for (const p of polls) if (p.src === 'trackalacker' && p.listings) lastPoll[p.show] = Math.max(lastPoll[p.show] ?? 0, Date.parse(p.t))
const csv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n'
const money = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100)

// TrackaLacker keeps the last 50 changes per listing: weeks for slow sites, hours for busy ones.
// Each curve starts once 80% of its listings (bundles aside) have a known state.
function walk(ls, show, step, push) {
  ls = ls.filter((h) => !isPackage(h.zone) && h.changes.some((c) => c[1] != null))
  if (!ls.length) return
  const firsts = ls.map((h) => Date.parse(h.changes[0][0])).sort((a, b) => a - b)
  const from = Math.ceil(firsts[Math.max(0, Math.ceil(firsts.length * 0.8) - 1)] / step) * step
  // A listing keeps its last price until it changes, so run the curve up to the latest poll.
  const lastSeen = Math.max(...ls.map((h) => Date.parse(h.changes.at(-1)[0])), lastPoll[show] ?? 0)
  const to = Math.min(Math.floor(lastSeen / HOUR) * HOUR, showStart[show])
  const idx = new Map(ls.map((h) => [h, 0]))
  for (let t = from; t <= to; t += step) {
    const s = { cheapest: Infinity, floor: Infinity, l100: Infinity, l200: Infinity, upper: Infinity, tickets: 0, known: 0 }
    for (const h of ls) {
      let i = idx.get(h)
      while (i + 1 < h.changes.length && Date.parse(h.changes[i + 1][0]) <= t) i++
      idx.set(h, i)
      const c = h.changes[i]
      if (Date.parse(c[0]) > t) continue
      s.known++
      const [, price, inv] = c
      if (price == null) continue
      s.tickets += inv ?? 0
      s.cheapest = Math.min(s.cheapest, price)
      if (isFloor(h.zone)) s.floor = Math.min(s.floor, price)
      if (isUpper(h.zone)) s.upper = Math.min(s.upper, price)
      if (/^100 level$/i.test(h.zone)) s.l100 = Math.min(s.l100, price)
      if (/^200 level$/i.test(h.zone)) s.l200 = Math.min(s.l200, price)
    }
    push(t, s)
  }
}
const when = (show, t) => ({
  show,
  at: new Date(t).toISOString().slice(0, 13) + ':00Z',
  hours_out: Math.round((showStart[show] - t) / HOUR),
  days_out: Math.round(((showStart[show] - t) / (24 * HOUR)) * 100) / 100,
})

const curve = []
const siteCurve = []
for (const show of SHOWS) {
  const ls = Object.values(hist.listings).filter((h) => h.show === show.id && h.changes.length)
  walk(ls, show.id, HOUR, (t, s) => curve.push({
    ...when(show.id, t),
    cheapest: money(s.cheapest), cheapest_ga_floor: money(s.floor), cheapest_100: money(s.l100), cheapest_200: money(s.l200), cheapest_400: money(s.upper),
    tickets_listed: s.tickets, listings_known: s.known,
  }))
  for (const site of new Set(ls.map((h) => h.retailer))) {
    walk(ls.filter((h) => h.retailer === site), show.id, 3 * HOUR, (t, s) => siteCurve.push({
      ...when(show.id, t), site, cheapest: money(s.cheapest), cheapest_ga_floor: money(s.floor), cheapest_100: money(s.l100), cheapest_200: money(s.l200),
    }))
  }
}
writeFileSync(join(OUT, 'curve.csv'), csv(curve, ['show', 'at', 'hours_out', 'days_out', 'cheapest', 'cheapest_ga_floor', 'cheapest_100', 'cheapest_200', 'cheapest_400', 'tickets_listed', 'listings_known']))
writeFileSync(join(OUT, 'site_curve.csv'), csv(siteCurve, ['show', 'site', 'at', 'hours_out', 'days_out', 'cheapest', 'cheapest_ga_floor', 'cheapest_100', 'cheapest_200']))

const sites = []
const latest = new Map()
for (const p of polls) if (p.src === 'trackalacker' && p.listings) latest.set(p.show, p)
for (const [show, p] of latest) {
  const by = {}
  for (const [id, price, inv] of p.listings) {
    const h = hist.listings[id]
    if (!h || price == null || isPackage(h.zone)) continue
    const s = (by[h.retailer] ??= { show, site: h.retailer, cheapest: Infinity, cheapest_ga_floor: Infinity, cheapest_100: Infinity, cheapest_200: Infinity, tickets_listed: 0, polled_at: p.t })
    s.cheapest = Math.min(s.cheapest, price)
    if (isFloor(h.zone)) s.cheapest_ga_floor = Math.min(s.cheapest_ga_floor, price)
    if (/^100 level$/i.test(h.zone)) s.cheapest_100 = Math.min(s.cheapest_100, price)
    if (/^200 level$/i.test(h.zone)) s.cheapest_200 = Math.min(s.cheapest_200, price)
    s.tickets_listed += inv ?? 0
  }
  for (const s of Object.values(by)) {
    sites.push({ ...s, cheapest: money(s.cheapest), cheapest_ga_floor: money(s.cheapest_ga_floor), cheapest_100: money(s.cheapest_100), cheapest_200: money(s.cheapest_200) })
  }
}
// TicketSmarter: whole levels and the middle sections from its section list (prices with its service fee).
const latestSections = new Map()
for (const p of polls) if (p.sections && showStart[p.show]) latestSections.set(p.show, p)
for (const p of latestSections.values()) {
  const low = (test) => money(Math.min(...Object.entries(p.sections).filter(([k]) => test(k)).map(([, v]) => v[0] ?? Infinity)))
  const mid = (keys) => low((k) => keys.includes(k))
  sites.push({
    show: p.show, site: 'TicketSmarter', cheapest: low(() => true), cheapest_ga_floor: low((k) => k === 'GA'),
    cheapest_100: low((k) => /^1\d\d$/.test(k)), cheapest_200: low((k) => /^2\d\d$/.test(k)),
    mid_100: mid(FOCUS['100s 104-108']), mid_200: mid(FOCUS['200s 204-208']),
    tickets_listed: Object.values(p.sections).reduce((n, v) => n + v[2], 0), polled_at: p.t,
  })
}
writeFileSync(join(OUT, 'sites.csv'), csv(sites, ['show', 'site', 'cheapest', 'cheapest_ga_floor', 'cheapest_100', 'cheapest_200', 'mid_100', 'mid_200', 'tickets_listed', 'polled_at']))

const zones = []
for (const p of polls) {
  if (!p.sections || !showStart[p.show]) continue
  const t = Date.parse(p.t)
  for (const [zone, keys] of Object.entries(FOCUS)) {
    const s = keys.map((k) => p.sections[k]).filter(Boolean)
    const min = (i) => money(Math.min(...s.map((x) => x[i] ?? Infinity)))
    zones.push({
      show: p.show, at: p.t.slice(0, 16) + 'Z',
      hours_out: Math.round(((showStart[p.show] - t) / HOUR) * 10) / 10,
      days_out: Math.round(((showStart[p.show] - t) / (24 * HOUR)) * 100) / 100,
      zone, cheapest: min(0), cheapest_pair: min(1), tickets: s.reduce((n, x) => n + x[2], 0),
    })
  }
}
writeFileSync(join(OUT, 'zones.csv'), csv(zones, ['show', 'at', 'hours_out', 'days_out', 'zone', 'cheapest', 'cheapest_pair', 'tickets']))

// They're going to both shows: a 2-day pass (one seat, both nights) against the cheapest single for each night,
// all from the same TicketSmarter run so the three prices are read at the same moment.
const passCompare = []
const byRun = new Map()
for (const p of polls) if (p.sections) byRun.set(`${p.t}|${p.show}`, p.sections)
for (const pass of PASSES) {
  const first = Date.parse(pass.start)
  for (const p of polls) {
    if (p.show !== pass.id || !p.sections) continue
    const days = pass.days.map((d) => byRun.get(`${p.t}|${d}`))
    if (days.some((d) => !d)) continue
    const t = Date.parse(p.t)
    for (const [zone, keys] of Object.entries(FOCUS)) {
      const low = (secs, i) => Math.min(...keys.map((k) => secs[k]?.[i] ?? Infinity))
      const passLow = low(p.sections, 0), passPair = low(p.sections, 1)
      const singles = low(days[0], 0) + low(days[1], 0), singlesPair = low(days[0], 1) + low(days[1], 1)
      passCompare.push({
        weekend: pass.id.replace('pass-', ''), at: p.t.slice(0, 16) + 'Z',
        hours_out: Math.round(((first - t) / HOUR) * 10) / 10, days_out: Math.round(((first - t) / (24 * HOUR)) * 100) / 100,
        zone, pass: money(passLow), pass_pair: money(passPair),
        day1: money(low(days[0], 0)), day2: money(low(days[1], 0)), singles: money(singles), singles_pair: money(singlesPair),
        saving: money(singles - passLow), saving_pct: isFinite(singles - passLow) ? Math.round(((singles - passLow) / singles) * 1000) / 1000 : null,
        pass_tickets: keys.reduce((n, k) => n + (p.sections[k]?.[2] ?? 0), 0),
      })
    }
  }
}
writeFileSync(join(OUT, 'pass_compare.csv'), csv(passCompare, ['weekend', 'at', 'hours_out', 'days_out', 'zone', 'pass', 'pass_pair', 'day1', 'day2', 'singles', 'singles_pair', 'saving', 'saving_pct', 'pass_tickets']))

const ts = polls.filter((p) => p.ts?.low).map((p) => ({ show: p.show, at: p.t, low: money(p.ts.low) }))
writeFileSync(join(OUT, 'ticketsmarter.csv'), csv(ts, ['show', 'at', 'low']))

console.log(`curve ${curve.length} rows, site curve ${siteCurve.length}, sites ${sites.length}, ticketsmarter ${ts.length}`)
