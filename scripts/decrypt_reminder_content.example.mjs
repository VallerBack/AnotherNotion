import { decodeAesKey, decryptContent } from './reminder_snapshot_lib.mjs'

const encryptedContent = process.argv[2]
if (!encryptedContent || !process.env.REMINDER_JSON_AES_KEY) {
  console.error('Usage: set REMINDER_JSON_AES_KEY to the Base64 key, then pass one encrypted content value as the first argument.')
  process.exitCode = 1
} else {
  console.log(decryptContent(encryptedContent, decodeAesKey(process.env.REMINDER_JSON_AES_KEY)))
}
