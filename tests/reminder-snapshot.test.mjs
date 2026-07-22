import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTENT_ENCODING,
  assertSecretsAbsent,
  buildSnapshotData,
  decodeAesKey,
  decryptContent,
  encryptContent,
  mergeSnapshots,
  validateFeed,
  validateOldSnapshot,
} from '../scripts/reminder_snapshot_lib.mjs'

const keyBase64 = Buffer.alloc(32, 7).toString('base64')
const key = decodeAesKey(keyBase64)
const idA = '11111111-1111-4111-8111-111111111111'
const idB = '22222222-2222-4222-8222-222222222222'
const plain = (overrides = {}) => ({
  id: idA,
  name: '测试任务',
  content: '第一行\n中文提醒',
  deadline: null,
  author: '创建者',
  modsInvolved: ['负责人'],
  remindAt: '2026-07-22T02:00:00+00:00',
  url: `https://vallerback.github.io/AnotherNotion/#/tasks/${idA}`,
  ...overrides,
})
const encrypted = (overrides = {}) => {
  const item = plain(overrides)
  return { ...item, content: encryptContent(item.content, key), contentEncoding: CONTENT_ENCODING }
}
const temporaryDirectories = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('AES-256-GCM reminder content', () => {
  it('round-trips Chinese text and newlines', () => {
    const value = encryptContent('中文\n第二行', key)
    expect(value.startsWith(`${CONTENT_ENCODING}.`)).toBe(true)
    expect(decryptContent(value, key)).toBe('中文\n第二行')
  })

  it('rejects ciphertext tampering', () => {
    const value = encryptContent('secret text', key)
    const packed = Buffer.from(value.slice(`${CONTENT_ENCODING}.`.length), 'base64')
    packed[packed.length - 1] ^= 1
    expect(() => decryptContent(`${CONTENT_ENCODING}.${packed.toString('base64')}`, key)).toThrow()
  })

  it('rejects authentication-tag tampering', () => {
    const value = encryptContent('secret text', key)
    const packed = Buffer.from(value.slice(`${CONTENT_ENCODING}.`.length), 'base64')
    packed[12] ^= 1
    expect(() => decryptContent(`${CONTENT_ENCODING}.${packed.toString('base64')}`, key)).toThrow()
  })

  it('rejects keys that do not decode to exactly 32 bytes', () => {
    expect(() => decodeAesKey(Buffer.alloc(31).toString('base64'))).toThrow('exactly 32 bytes')
    expect(() => decodeAesKey('ordinary-password')).toThrow()
  })

  it('uses a different IV for identical plaintext', () => {
    expect(encryptContent('same', key)).not.toBe(encryptContent('same', key))
  })
})

describe('snapshot validation and merge', () => {
  it('deduplicates old and new reminders by ID with the new value winning', () => {
    const oldItem = encrypted({ name: '旧标题' })
    const feedItem = plain({ name: '新标题' })
    const result = mergeSnapshots([oldItem], [feedItem], key, new Date('2026-07-22T03:00:00Z'))
    expect(result.items).toHaveLength(1)
    expect(result.items[0].name).toBe('新标题')
  })

  it('retains only reminders from the most recent seven days and sorts by remindAt', () => {
    const old = [
      encrypted({ id: idA, remindAt: '2026-07-14T23:59:59Z' }),
      encrypted({ id: idB, remindAt: '2026-07-21T02:00:00Z' }),
    ]
    const result = mergeSnapshots(old, [], key, new Date('2026-07-22T00:00:00Z'))
    expect(result.items.map((item) => item.id)).toEqual([idB])
    expect(result.changed).toBe(true)
  })

  it('rejects malformed old snapshots, duplicate IDs, invalid times, and oversized feeds', () => {
    expect(() => validateOldSnapshot({ items: [] })).toThrow()
    const item = encrypted()
    expect(() => validateOldSnapshot([item, item])).toThrow('duplicate')
    expect(() => validateFeed([plain({ remindAt: 'not-a-time' })])).toThrow()
    expect(() => validateFeed(Array.from({ length: 21 }, (_, index) => plain({ id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111` })))).toThrow()
  })

  it('outputs a root array whose content is ciphertext and declares its encoding', () => {
    const result = mergeSnapshots([], [plain()], key, new Date('2026-07-22T00:00:00Z'))
    const output = JSON.stringify(result.items)
    expect(Array.isArray(JSON.parse(output))).toBe(true)
    expect(output).not.toContain('第一行')
    expect(result.items[0].contentEncoding).toBe(CONTENT_ENCODING)
  })
})

describe('failure safety and artifact scanning', () => {
  it('fails before producing data when the previous online snapshot cannot be read', async () => {
    const fetchImpl = async () => { throw new Error('network down') }
    await expect(buildSnapshotData({ fetchImpl, previousUrl: 'https://example.test/reminders.json', feedUrl: '', feedToken: '', key, fetchFeed: false }))
      .rejects.toThrow('network request failed')
  })

  it('does not fall back to an empty snapshot when the feed request fails', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify([encrypted()]), { status: 200 })
      return new Response('provider unavailable', { status: 503 })
    }
    await expect(buildSnapshotData({ fetchImpl, previousUrl: 'https://example.test/reminders.json', feedUrl: 'https://example.test/feed', feedToken: 'token', key, fetchFeed: true }))
      .rejects.toThrow('HTTP 503')
  })

  it('allows a first-deployment 404 to start from an empty array', async () => {
    const fetchImpl = async () => new Response('', { status: 404 })
    const result = await buildSnapshotData({ fetchImpl, previousUrl: 'https://example.test/reminders.json', feedUrl: '', feedToken: '', key, fetchFeed: false })
    expect(result.items).toEqual([])
  })

  it('detects either protected value in a generated artifact without logging it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'another-notion-snapshot-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'safe.json'), '[]')
    await expect(assertSecretsAbsent(directory, ['feed-secret', keyBase64])).resolves.toBeUndefined()
    await writeFile(join(directory, 'unsafe.txt'), 'feed-secret')
    await expect(assertSecretsAbsent(directory, ['feed-secret', keyBase64])).rejects.toThrow('protected value')
    expect(await readFile(join(directory, 'unsafe.txt'), 'utf8')).toBe('feed-secret')
  })
})
