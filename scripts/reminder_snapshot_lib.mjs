import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONTENT_ENCODING = 'A256GCM.v1'
export const MAX_ITEMS = 5000
export const MAX_JSON_BYTES = 10 * 1024 * 1024
export const MAX_CONTENT_CHARS = 1800
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function decodeAesKey(value) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) throw new Error('REMINDER_JSON_AES_KEY must be canonical Base64')
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('REMINDER_JSON_AES_KEY must decode to exactly 32 bytes')
  return key
}

export function encryptContent(plaintext, key, usedIvs = new Set()) {
  if (typeof plaintext !== 'string' || plaintext.length > MAX_CONTENT_CHARS) throw new Error('Reminder content is invalid or too long')
  let iv
  let ivKey
  do {
    iv = randomBytes(12)
    ivKey = iv.toString('hex')
  } while (usedIvs.has(ivKey))
  usedIvs.add(ivKey)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${CONTENT_ENCODING}.${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`
}

export function decryptContent(value, key) {
  const prefix = `${CONTENT_ENCODING}.`
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error('Unsupported content encoding')
  const encoded = value.slice(prefix.length)
  if (!BASE64_PATTERN.test(encoded)) throw new Error('Encrypted content is not valid Base64')
  const packed = Buffer.from(encoded, 'base64')
  if (packed.length < 28) throw new Error('Encrypted content is incomplete')
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12), { authTagLength: 16 })
  decipher.setAuthTag(packed.subarray(12, 28))
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')
}

function requiredString(value, name, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new Error(`Invalid reminder ${name}`)
  return value
}

function isoTime(value, name, nullable = false) {
  if (nullable && value === null) return null
  const text = requiredString(value, name, 64)
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(`Invalid reminder ${name}`)
  return text
}

function validateCommon(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Reminder must be an object')
  const mods = record.modsInvolved
  if (!Array.isArray(mods) || mods.length > 100 || mods.some((name) => typeof name !== 'string' || name.length > 200)) {
    throw new Error('Invalid reminder modsInvolved')
  }
  const id = requiredString(record.id, 'id', 200)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid reminder id')
  const url = requiredString(record.url, 'url', 2000)
  if (!url.startsWith('https://')) throw new Error('Invalid reminder url')
  return {
    id,
    name: requiredString(record.name, 'name', 500),
    deadline: isoTime(record.deadline, 'deadline', true),
    author: requiredString(record.author, 'author', 200),
    modsInvolved: [...mods],
    remindAt: isoTime(record.remindAt, 'remindAt'),
    url,
  }
}

export function validateOldSnapshot(value) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('Previous snapshot must be a bounded JSON array')
  const ids = new Set()
  return value.map((record) => {
    const common = validateCommon(record)
    if (ids.has(common.id)) throw new Error('Previous snapshot contains duplicate IDs')
    ids.add(common.id)
    const content = requiredString(record.content, 'content', 10000)
    if (record.contentEncoding !== CONTENT_ENCODING || !content.startsWith(`${CONTENT_ENCODING}.`)) {
      throw new Error('Previous snapshot contains unsupported plaintext or encoding')
    }
    return { ...common, content, contentEncoding: CONTENT_ENCODING }
  })
}

export function validateFeed(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Feed must be an array of at most 20 reminders')
  const ids = new Set()
  return value.map((record) => {
    const common = validateCommon(record)
    if (ids.has(common.id)) throw new Error('Feed contains duplicate IDs')
    ids.add(common.id)
    return { ...common, content: requiredString(record.content, 'content', MAX_CONTENT_CHARS) }
  })
}

export function mergeSnapshots(oldItems, feedItems, key, now = new Date()) {
  const cutoff = now.getTime() - RETENTION_MS
  const merged = new Map(oldItems.map((item) => [item.id, item]))
  const usedIvs = new Set()
  for (const item of feedItems) {
    merged.set(item.id, {
      ...item,
      content: encryptContent(item.content, key, usedIvs),
      contentEncoding: CONTENT_ENCODING,
    })
  }
  const items = [...merged.values()]
    .filter((item) => Date.parse(item.remindAt) >= cutoff)
    .sort((left, right) => Date.parse(left.remindAt) - Date.parse(right.remindAt) || left.id.localeCompare(right.id))
  if (items.length > MAX_ITEMS) throw new Error('Merged snapshot exceeds the item limit')
  return { items, changed: feedItems.length > 0 || items.length !== oldItems.length }
}

export async function fetchJson(fetchImpl, url, options = {}, allow404 = false) {
  let response
  try {
    response = await fetchImpl(url, { cache: 'no-store', ...options, signal: options.signal ?? AbortSignal.timeout(30_000) })
  } catch {
    throw new Error('Snapshot network request failed')
  }
  if (allow404 && response.status === 404) return []
  if (!response.ok) throw new Error(`Snapshot request failed with HTTP ${response.status}`)
  if (response.url && !response.url.startsWith('https://')) throw new Error('Snapshot request redirected away from HTTPS')
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_JSON_BYTES) throw new Error('Snapshot response is too large')
  const body = await response.text()
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new Error('Snapshot response is too large')
  try {
    return JSON.parse(body)
  } catch {
    throw new Error('Snapshot response is not valid JSON')
  }
}

export async function buildSnapshotData({ fetchImpl, previousUrl, feedUrl, feedToken, key, fetchFeed, now = new Date() }) {
  const oldItems = validateOldSnapshot(await fetchJson(fetchImpl, previousUrl, {}, true))
  let feedItems = []
  if (fetchFeed) {
    feedItems = validateFeed(await fetchJson(fetchImpl, feedUrl, { headers: { 'X-Feed-Token': feedToken } }))
  }
  return mergeSnapshots(oldItems, feedItems, key, now)
}

export async function assertSecretsAbsent(directory, secretValues) {
  const secrets = secretValues.filter((value) => typeof value === 'string' && value.length > 0)
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name)
      if (entry.isDirectory()) await visit(target)
      else {
        const content = await readFile(target)
        for (const secret of secrets) if (content.includes(Buffer.from(secret))) throw new Error('Generated artifact contains a protected value')
      }
    }
  }
  await visit(directory)
}
