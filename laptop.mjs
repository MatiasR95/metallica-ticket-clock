// Laptop half of the collector (Task Scheduler, every 30 min, via run-hidden.vbs): TrackaLacker and Vibee
// refuse GitHub's servers, so this machine adds them to the shared repo whenever it is awake.
// It only ever commits data/tl/ and data/history.json; everything else in data/ belongs to the cloud run.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const git = (...a) => execFileSync('git', a, { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const OWN = ['data/tl', 'data/history.json']
const CLOUD = ['data/out', 'data/polls', 'data/packages.json', 'data/run.log']

function sync() {
  // Local builds (the refresh task) leave cloud-owned files modified; drop them so the pull is clean.
  git('checkout', '--', ...CLOUD)
  git('pull', '-q', '--rebase', '--autostash')
}

try {
  sync()
  execFileSync(process.execPath, [join(HERE, 'watch.mjs'), '--part', 'laptop', '--history', '--budget', '480'], { cwd: HERE, stdio: 'inherit' })
  git('add', ...OWN)
  if (git('diff', '--cached', '--name-only')) {
    git('commit', '-q', '-m', `laptop data ${new Date().toISOString().slice(0, 16)}Z`)
    for (let i = 0; ; i++) {
      try { git('push', '-q'); break } catch (e) {
        if (i === 2) throw e
        sync()
      }
    }
  }
} catch (e) {
  mkdirSync(join(HERE, 'data', 'tl'), { recursive: true })
  appendFileSync(join(HERE, 'data', 'tl', 'run.log'), `${new Date().toISOString()} SYNC FAILED ${String(e.stderr || e.message).split('\n')[0]}\n`)
  process.exit(1)
}
