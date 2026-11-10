// Metallica at Sphere resale price logger.
// Reads public pages only, with an honest user-agent, a few requests per run. No logins, no captchas.
//   node watch.mjs            poll current prices (cheap: one JSON per show + TicketSmarter)
//   node watch.mjs --history [--budget 480]  also pull changed listings' recent price changes from TrackaLacker,
//                            oldest-pulled first, for at most --budget seconds
// Data lands in data/: polls/<yyyy-mm>.jsonl (one line per show per run; a file a month keeps git diffs small)
// and history.json (per-listing change log). Runs in GitHub Actions every 30 min (.github/workflows/clock.yml).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data')
const UA = 'Mozilla/5.0 (compatible; matias-trips-pricelog/1.0)'
const TL = 'https://www.trackalacker.com/products/showcase/metallica-life-burns-faster-tickets-'
const TS = 'https://www.ticketsmarter.com/e/'

// Show times are 8:30 PM Pacific (PST, UTC-8, for both November and February).
export const SHOWS = [
  { id: '2026-11-05', tl: '11-5', ts: 'metallica-tickets-las-vegas-11-5-2026-sphere/3324762', start: '2026-11-06T04:30:00Z' },
  { id: '2026-11-07', tl: '11-7', ts: 'metallica-tickets-las-vegas-11-7-2026-sphere/3324765', start: '2026-11-08T04:30:00Z' },
  { id: '2027-02-04', tl: '2-4', ts: 'metallica-tickets-las-vegas-2-4-2027-sphere/3327258', start: '2027-02-05T04:30:00Z' },
  { id: '2027-02-06', tl: '2-6', ts: 'metallica-tickets-las-vegas-2-6-2027-sphere/3327259', start: '2027-02-07T04:30:00Z' },
]
export const PASSES = [
  { id: 'pass-2026-11', days: ['2026-11-05', '2026-11-07'], ts: 'metallica-2-day-pass-11-5-and-11-7-tickets-las-vegas-11-5-2026-sphere/3324780', start: '2026-11-06T04:30:00Z' },
  { id: 'pass-2027-02', days: ['2027-02-04', '2027-02-06'], ts: 'metallica-2-day-pass-2-4-and-2-6-tickets-las-vegas-2-4-2027-sphere/3327270', start: '2027-02-05T04:30:00Z' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// curl rather than Node's fetch: TrackaLacker's CDN answers curl (same user-agent) but rejects undici.
function get(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--max-time', '40', '-A', UA, '-w', '\n%{http_code}', url], { maxBuffer: 20 << 20 }, (err, out) => {
      if (err) return reject(new Error(`curl ${err.code} ${url}`))
      const i = out.lastIndexOf('\n')
      const code = out.slice(i + 1).trim()
      code === '200' ? resolve(out.slice(0, i)) : reject(new Error(`${code} ${url}`))
    })
  })
}
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function listingRow(l) {
  const st = l.current_status ?? {}
  return {
    id: l.id,
    retailer: l.properties?.retailer ?? l.provider?.display_name,
    zone: l.properties?.['1'] ?? l.name.replace(/^Metallica - /, ''),
    price: st.online_availability ? (st.price_and_shipping_total ?? st.price ?? null) : null,
    inv: st.inventory_count ?? null,
    changed: st.price_changed_at ?? null,
    path: l.show_path,
  }
}

async function pollTrackaLacker(show) {
  const j = JSON.parse(await get(`${TL}${show.tl}.json`))
  return j.product.listings.map(listingRow)
}

async function pollTicketSmarter(path) {
  const html = await get(TS + path)
  const m = html.match(/"offers":\{"@type":"AggregateOffer"[^}]*\}/)
  if (!m) return null
  const o = JSON.parse(`{${m[0]}}`).offers
  return { low: Number(o.lowPrice) || null, high: Number(o.highPrice) || null, avail: /InStock/.test(o.availability ?? '') }
}

// TicketSmarter sells from the TicketNetwork exchange, whose listings carry the section number
// (TrackaLacker only has the cheapest listing per level). Names vary: "105", "Section 105", "GAFL03".
function sectionKey(raw) {
  const s = raw.trim()
  const n = s.match(/^(?:section\s*)?(\d{3})$/i)
  if (n) return n[1]
  if (/package|vip|deluxe|diamond|gold|elite|\bfan\b|hotel/i.test(s)) return null
  if (/snake|snk|pit/i.test(s)) return 'PIT'
  if (/floor|^gafl|^ga\b|general admission/i.test(s)) return 'GA'
  return null
}

// Per section: [cheapest, cheapest that sells two together, tickets, listings]. Prices include the service fee.
async function pollSections(show) {
  const list = JSON.parse(await get(`https://www.ticketsmarter.com/api/tickets/tn?EventID=${show.ts.split('/').pop()}`))
  const secs = {}
  for (const t of list) {
    if (t.tgType !== 1) continue // 3 = parking and hotel shuttles
    const key = sectionKey(t.tgUserSec ?? '')
    if (!key) continue
    // Since 2026-11-09 Matías only wants rows 1-20 in the 100s and 200s (front of the section). GA/PIT have no row.
    if (/^[12]\d\d$/.test(key)) {
      const row = parseInt(String(t.tgUserRow ?? '').trim(), 10)
      if (!(row >= 1 && row <= 20)) continue
    }
    const price = Math.round((t.tgPrice + (t.tgServiceFee ?? 0)) * 100) / 100
    const s = (secs[key] ??= [null, null, 0, 0])
    if (s[0] == null || price < s[0]) s[0] = price
    if (t.splits?.includes(2) && (s[1] == null || price < s[1])) s[1] = price
    s[2] += t.tgQty
    s[3]++
  }
  return secs
}

// Official packages for Feb 4 + 6: Vibee (2 shows + hotel) and SUPER enhanced experiences.
const VIBEE = 'https://vibee.com/events/metallica-2.4.27-2.6.27-6C593C83'
const SUPER = 'https://superfan.live/artist/metallicasphere/'
async function pollVibee() {
  const html = await get(VIBEE)
  const e = JSON.parse(html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)[1]).props.pageProps.event
  // Vibee decides "Sold Out" in the browser from these fields (rooms and tickets both show stock while
  // the page says Sold Out), so keep a fingerprint of all of them: any change means "go look".
  const tickets = e.tickets.map((t) => [t.name, (t.tiers ?? []).map((x) => `${x.onSale ? 1 : 0}:${x.quantityAvailable}:${x.price}`).join(',')])
  const rooms = e.hotels.flatMap((h) => (h.rooms ?? []).map((r) => `${r.onSale ? 1 : 0}:${r.quantityAvailable}:${(r.tiers ?? []).flatMap((x) => (x.prices ?? []).map((p) => p.quantityAvailable)).join('/')}`))
  return { fingerprint: createHash('sha1').update(JSON.stringify([tickets, rooms])).digest('hex').slice(0, 12), tickets }
}
async function pollSuper() {
  const html = await get(SUPER)
  const card = html.split('class="tour-date-card"').find((c) => /<h3[^>]*>\s*weekend eight\s*</i.test(c))
  if (!card) throw new Error('weekend eight card not found')
  return { available: !/sold-out/.test(card) }
}

// Keeps the latest state and when it last changed, for the twice-daily watcher to alert on.
// A failed fetch keeps the last good state rather than counting as a change.
async function trackState(file, key, poll, t) {
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  let cur
  try { cur = await poll() } catch (e) { cur = prev?.[key] ? { ...prev[key], error: e.message } : { error: e.message } }
  if (!cur.error) delete cur.error
  const sig = (s) => JSON.stringify(s?.fingerprint ?? s?.available ?? null)
  const changed = !prev || (!cur.error && sig(prev[key]) !== sig(cur))
  writeFileSync(file, JSON.stringify({ t, [key]: cur, changedAt: changed ? t : prev.changedAt }, null, 1))
  return `${key} ${cur.error ?? cur.fingerprint ?? (cur.available ? 'OPEN' : 'sold out')}${changed && prev ? ' (CHANGED)' : ''}`
}

async function pullHistory(listing) {
  const html = await get('https://www.trackalacker.com' + listing.path)
  const m = html.match(/data-react-class="products\/listings\/RecentChanges" data-react-props="([^"]*)"/)
  if (!m) return []
  return JSON.parse(decode(m[1])).statuses.map((s) => [
    s.created_at,
    s.online_availability ? (s.price_and_shipping_total ?? s.price) : null,
    s.inventory_count ?? null,
  ])
}

// Two collectors share one git repo and never write the same file:
//   --part cloud   (GitHub Actions) TicketSmarter shows + passes, SUPER   -> data/polls/, data/packages.json, data/run.log
//   --part laptop  (Matías' laptop) TrackaLacker + change logs, Vibee     -> data/tl/, data/history.json
// TrackaLacker and Vibee answer 403 to GitHub's servers, so they can only come from the laptop.
async function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
  const part = arg('--part') ?? 'cloud'
  const withHistory = process.argv.includes('--history')
  const budgetMs = arg('--budget') ? Number(arg('--budget')) * 1000 : Infinity
  const startedAt = Date.now()
  const toPull = []
  const dir = part === 'laptop' ? join(DATA, 'tl') : DATA
  mkdirSync(dir, { recursive: true })
  const t = new Date().toISOString()
  const histFile = join(DATA, 'history.json')
  const hist = existsSync(histFile) ? JSON.parse(readFileSync(histFile, 'utf8')) : { listings: {} }
  const lines = []
  const log = []

  for (const show of SHOWS) {
    // A show's TrackaLacker page disappears soon after the event, so stop asking a few hours later.
    if (Date.now() > Date.parse(show.start) + 6 * 3600e3) continue
    if (part === 'cloud') {
      const line = { t, show: show.id, src: 'ticketsmarter', ts: null, sections: null }
      try { line.ts = await pollTicketSmarter(show.ts) } catch (e) { log.push(`${show.id} ticketsmarter: ${e.message}`) }
      try { line.sections = await pollSections(show) } catch (e) { log.push(`${show.id} sections: ${e.message}`) }
      if (line.sections) log.push(`${show.id}: ${Object.keys(line.sections).length} sections`)
      lines.push(line)
      await sleep(800)
      continue
    }
    const line = { t, show: show.id, src: 'trackalacker', listings: null }
    try {
      const rows = await pollTrackaLacker(show)
      line.listings = rows.map((r) => [r.id, r.price, r.inv])
      for (const r of rows) {
        const h = (hist.listings[r.id] ??= { show: show.id, retailer: r.retailer, zone: r.zone, path: r.path, changes: [] })
        h.retailer = r.retailer; h.zone = r.zone; h.path = r.path
      }
      // Skip a listing whose latest change we already hold (timestamps differ only in milliseconds).
      for (const r of rows) {
        const known = hist.listings[r.id].changes
        if (!(r.changed && known.some((c) => c[0].slice(0, 19) === r.changed.slice(0, 19)))) toPull.push(r)
      }
      const live = rows.filter((r) => r.price != null)
      const min = Math.min(...live.map((r) => r.price))
      log.push(`${show.id}: ${live.length}/${rows.length} listings live, from $${min}`)
    } catch (e) { log.push(`${show.id} trackalacker: ${e.message}`) }
    if (line.listings) lines.push(line)
    await sleep(800)
  }
  for (const p of PASSES) {
    if (part !== 'cloud' || Date.now() > Date.parse(p.start)) continue
    try {
      const line = { t, show: p.id, src: 'ticketsmarter', ts: await pollTicketSmarter(p.ts), sections: null }
      // A pass listing is one seat for both nights, priced as one ticket.
      try { line.sections = await pollSections(p) } catch (e) { log.push(`${p.id} sections: ${e.message}`) }
      lines.push(line)
    } catch (e) { log.push(`${p.id}: ${e.message}`) }
  }

  // Change logs last: oldest-pulled first, and only for --budget seconds, so every run ends well inside
  // the 30-minute cadence and a busy listing can't starve the rest.
  if (withHistory && toPull.length) {
    toPull.sort((a, b) => (hist.listings[a.id].pulledAt ?? '').localeCompare(hist.listings[b.id].pulledAt ?? ''))
    let done = 0
    for (const r of toPull) {
      if (Date.now() - startedAt > budgetMs) break
      await sleep(1200)
      try {
        const changes = await pullHistory(r)
        const h = hist.listings[r.id]
        const seen = new Set(h.changes.map((c) => c[0]))
        for (const c of changes) if (!seen.has(c[0])) h.changes.push(c)
        h.changes.sort((a, b) => a[0].localeCompare(b[0]))
        h.pulledAt = new Date().toISOString()
        done++
      } catch (e) { log.push(`history ${r.id}: ${e.message}`) }
    }
    log.push(`history: ${done}/${toPull.length} change logs pulled`)
  }

  if (Date.now() < Date.parse(SHOWS.at(-1).start)) {
    if (part === 'cloud') log.push(await trackState(join(DATA, 'packages.json'), 'super', pollSuper, t))
    else log.push(await trackState(join(DATA, 'tl', 'vibee.json'), 'vibee', pollVibee, t))
  }

  if (lines.length) {
    mkdirSync(join(dir, 'polls'), { recursive: true })
    appendFileSync(join(dir, 'polls', `${t.slice(0, 7)}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  if (part === 'laptop') {
    // A slow run can overlap the next one, so merge with the file as it is now.
    const disk = existsSync(histFile) ? JSON.parse(readFileSync(histFile, 'utf8')) : { listings: {} }
    for (const [id, h] of Object.entries(disk.listings)) {
      const mine = hist.listings[id]
      if (!mine) { hist.listings[id] = h; continue }
      const seen = new Set(mine.changes.map((c) => c[0]))
      for (const c of h.changes) if (!seen.has(c[0])) mine.changes.push(c)
      mine.changes.sort((a, b) => a[0].localeCompare(b[0]))
    }
    writeFileSync(histFile, JSON.stringify(hist))
  }
  appendFileSync(join(dir, 'run.log'), `${t} ${withHistory ? '[history] ' : ''}${log.join(' | ')}\n`)
  console.log(log.join('\n'))
}

// build.mjs imports SHOWS from here; only collect when run directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    appendFileSync(join(DATA, process.argv.includes('laptop') ? 'tl/run.log' : 'run.log'), `${new Date().toISOString()} FATAL ${e.message}\n`)
    console.error(e)
    process.exit(1)
  })
}
