import { createHash, randomBytes } from 'node:crypto'

export type CipherEnvelope = { version: 1; keyVersion: string; nonce: string; ciphertext: string; tag: string; wrappedKey: string; wrappedNonce: string; wrappedTag: string }

function b64(bytes: Uint8Array) { return Buffer.from(bytes).toString('base64') }
function bytes(value: string) { return new Uint8Array(Buffer.from(value, 'base64')) }

export function sha256(value: string | Uint8Array) { return createHash('sha256').update(value).digest('hex') }

export function decodeServiceKey(value: string | undefined, demoMode: boolean) {
  if (!value && !demoMode) throw new Error('STEWARD_SERVICE_KEY is required outside explicit demo mode')
  if (!value) return randomBytes(32)
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error('STEWARD_SERVICE_KEY must be base64 encoded 32 bytes')
  return key
}

async function aesEncrypt(keyBytes: Uint8Array, plain: Uint8Array, aad: Uint8Array) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const source = (value: Uint8Array) => value as unknown as BufferSource
  const key = await crypto.subtle.importKey('raw', source(keyBytes), 'AES-GCM', false, ['encrypt'])
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(nonce), additionalData: source(aad), tagLength: 128 }, key, source(plain)))
  return { nonce, ciphertext: encrypted.slice(0, -16), tag: encrypted.slice(-16) }
}

async function aesDecrypt(keyBytes: Uint8Array, encrypted: { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }, aad: Uint8Array) {
  const source = (value: Uint8Array) => value as unknown as BufferSource
  const key = await crypto.subtle.importKey('raw', source(keyBytes), 'AES-GCM', false, ['decrypt'])
  const joined = new Uint8Array(encrypted.ciphertext.length + encrypted.tag.length); joined.set(encrypted.ciphertext); joined.set(encrypted.tag, encrypted.ciphertext.length)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(encrypted.nonce), additionalData: source(aad), tagLength: 128 }, key, source(joined)))
}

export async function encryptRecord(plaintext: Uint8Array | string, serviceKey: Uint8Array, keyVersion = 'v1', recordId = ''): Promise<CipherEnvelope> {
  const dataKey = crypto.getRandomValues(new Uint8Array(32)); const aad = new TextEncoder().encode(`steward:${keyVersion}:${recordId}`)
  const payload = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext
  const encrypted = await aesEncrypt(dataKey, payload, aad)
  const wrapped = await aesEncrypt(serviceKey, dataKey, new TextEncoder().encode(`wrap:${keyVersion}`))
  return { version: 1, keyVersion, nonce: b64(encrypted.nonce), ciphertext: b64(encrypted.ciphertext), tag: b64(encrypted.tag), wrappedKey: b64(wrapped.ciphertext), wrappedNonce: b64(wrapped.nonce), wrappedTag: b64(wrapped.tag) }
}

export async function decryptRecord(envelope: CipherEnvelope, serviceKey: Uint8Array, recordId = '') {
  const key = await aesDecrypt(serviceKey, { nonce: bytes(envelope.wrappedNonce), ciphertext: bytes(envelope.wrappedKey), tag: bytes(envelope.wrappedTag) }, new TextEncoder().encode(`wrap:${envelope.keyVersion}`))
  return aesDecrypt(key, { nonce: bytes(envelope.nonce), ciphertext: bytes(envelope.ciphertext), tag: bytes(envelope.tag) }, new TextEncoder().encode(`steward:${envelope.keyVersion}:${recordId}`))
}
