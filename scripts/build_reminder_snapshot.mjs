import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  assertSecretsAbsent,
  buildSnapshotData,
  decodeAesKey,
} from './reminder_snapshot_lib.mjs'

const previousUrl = process.env.SNAPSHOT_PREVIOUS_URL ?? 'https://vallerback.github.io/AnotherNotion/reminders.json'
const outputFile = resolve(process.env.SNAPSHOT_OUTPUT_FILE ?? 'dist/reminders.json')
const fetchFeed = process.env.SNAPSHOT_FETCH_FEED === 'true'
const forceDeploy = process.env.SNAPSHOT_FORCE_DEPLOY === 'true'
const feedToken = process.env.REMINDER_FEED_TOKEN ?? ''
const encodedKey = process.env.REMINDER_JSON_AES_KEY ?? ''
const supabaseUrl = process.env.VITE_SUPABASE_URL?.replace(/\/$/, '') ?? ''

if (!previousUrl.startsWith('https://')) throw new Error('Previous snapshot URL must use HTTPS')
if (!feedToken) throw new Error('REMINDER_FEED_TOKEN is required')
const key = decodeAesKey(encodedKey)

if (fetchFeed && !supabaseUrl.startsWith('https://')) throw new Error('VITE_SUPABASE_URL must use HTTPS')
await assertSecretsAbsent(dirname(outputFile), [feedToken, encodedKey])
const { items, changed } = await buildSnapshotData({
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
console.info(`Reminder snapshot prepared: items=${items.length}, changed=${changed}, deploy=${shouldDeploy}`)
