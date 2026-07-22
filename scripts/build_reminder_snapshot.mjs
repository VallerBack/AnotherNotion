import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  assertSecretsAbsent,
  buildSnapshotData,
  decodeAesKey,
  snapshotEventPolicy,
} from './reminder_snapshot_lib.mjs'

const previousUrl = process.env.SNAPSHOT_PREVIOUS_URL ?? 'https://vallerback.github.io/AnotherNotion/reminders.json'
const outputFile = resolve(process.env.SNAPSHOT_OUTPUT_FILE ?? 'dist/reminders.json')
const fetchFeed = process.env.SNAPSHOT_FETCH_FEED === 'true'
const forceDeploy = process.env.SNAPSHOT_FORCE_DEPLOY === 'true'
const feedToken = process.env.REMINDER_FEED_TOKEN ?? ''
const encodedKey = process.env.REMINDER_JSON_AES_KEY ?? ''
const supabaseUrl = process.env.VITE_SUPABASE_URL?.replace(/\/$/, '') ?? ''
const eventName = process.env.GITHUB_EVENT_NAME ?? ''
const expectedPolicy = snapshotEventPolicy(eventName)

if (fetchFeed !== expectedPolicy.fetchFeed || forceDeploy !== expectedPolicy.forceDeploy) {
  throw new Error('Snapshot event configuration does not match the GitHub event')
}

if (!previousUrl.startsWith('https://')) throw new Error('Previous snapshot URL must use HTTPS')
if (!feedToken) throw new Error('REMINDER_FEED_TOKEN is required')
const key = decodeAesKey(encodedKey)

if (fetchFeed && !supabaseUrl.startsWith('https://')) throw new Error('VITE_SUPABASE_URL must use HTTPS')
await assertSecretsAbsent(dirname(outputFile), [feedToken, encodedKey])
const { items, changed, oldCount, feedCount } = await buildSnapshotData({
  fetchImpl: fetch,
  previousUrl,
  feedUrl: `${supabaseUrl}/functions/v1/reminder-feed`,
  feedToken,
  key,
  fetchFeed,
})
const serialized = `${JSON.stringify(items, null, 2)}\n`
if (serialized.includes(feedToken) || serialized.includes(encodedKey)) throw new Error('Generated snapshot contains a protected value')
await mkdir(dirname(outputFile), { recursive: true })
await writeFile(outputFile, serialized, { encoding: 'utf8', flag: 'w' })

const shouldDeploy = forceDeploy || changed
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `should_deploy=${shouldDeploy}\n`, 'utf8')
console.info(`GitHub event: ${eventName}`)
console.info(`Feed fetch enabled: ${fetchFeed}`)
console.info(`Feed item count: ${feedCount}`)
console.info(`Previous snapshot item count: ${oldCount}`)
console.info(`Final snapshot item count: ${items.length}`)
console.info(`Pages deployment enabled: ${shouldDeploy}`)
