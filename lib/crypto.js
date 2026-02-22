/**
 * Agent Chat v2 — Crypto module
 * Ed25519 signing, X25519 + ChaCha20-Poly1305 encryption.
 * Zero npm dependencies — Node.js built-in crypto only.
 */

import { generateKeyPairSync, sign, verify, diffieHellman,
         createPublicKey, createPrivateKey, randomBytes,
         createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

// --- Base64 helpers ---

export function bufferToBase64(buf) {
  return Buffer.from(buf).toString('base64');
}

export function base64ToBuffer(b64) {
  const buf = Buffer.from(b64, 'base64');
  // Return a clean ArrayBuffer (not the shared Buffer pool backing)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// --- Ed25519 Key Generation ---

// DER prefix for Ed25519 SPKI (12 bytes before raw 32-byte pubkey)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// DER prefix for X25519 SPKI
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export async function generateEd25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  // Raw 32-byte public key = bytes 12..44 of SPKI DER
  const pubRaw = pubDer.subarray(12);
  return {
    publicKey: pubRaw.toString('base64'),
    privateKey: privDer.toString('base64')
  };
}

export async function generateX25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubRaw = pubDer.subarray(12);
  return {
    publicKey: pubRaw.toString('base64'),
    privateKey: privDer.toString('base64')
  };
}

// --- Ed25519 Signing ---

export async function signMessage(message, privateKeyBase64) {
  const privKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8'
  });
  const sig = sign(null, Buffer.from(message), privKey);
  return sig.toString('base64');
}

export async function verifySignature(message, signatureBase64, publicKeyBase64) {
  try {
    const pubKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBase64, 'base64')]),
      format: 'der',
      type: 'spki'
    });
    return verify(null, Buffer.from(message), pubKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

// --- X25519 + ChaCha20-Poly1305 Encryption ---

export async function encryptForRecipient(plaintext, recipientX25519PubBase64, senderEd25519PrivBase64) {
  // Generate ephemeral X25519 keypair for forward secrecy
  // Note: sender's X25519 key is NOT used — ECDH is ephemeral→recipient only
  const ephemeral = generateKeyPairSync('x25519');
  const ephPubRaw = ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(12);

  // Reconstruct recipient public key
  const recipientPub = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(recipientX25519PubBase64, 'base64')]),
    format: 'der',
    type: 'spki'
  });

  // ECDH with ephemeral private + recipient public
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPub });

  // HKDF → 32-byte symmetric key
  const key = hkdfSync('sha256', shared, '', 'agent-chat-v2', 32);

  // ChaCha20-Poly1305 encrypt
  const nonce = randomBytes(12);
  const cipher = createCipheriv('chacha20-poly1305', Buffer.from(key), nonce, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);

  const ciphertext = encrypted.toString('base64');
  const ephemeralKey = ephPubRaw.toString('base64');
  const nonceB64 = nonce.toString('base64');

  // Sign ciphertext:ephemeralKey:nonce with sender's Ed25519 key
  const senderSig = await signMessage(`${ciphertext}:${ephemeralKey}:${nonceB64}`, senderEd25519PrivBase64);

  return { ciphertext, ephemeralKey, nonce: nonceB64, senderSig };
}

export async function decryptFromSender(ciphertextBase64, ephemeralKeyBase64, nonceBase64, recipientX25519PrivBase64) {
  // Reconstruct ephemeral public key
  const ephPub = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(ephemeralKeyBase64, 'base64')]),
    format: 'der',
    type: 'spki'
  });

  // Reconstruct recipient private key
  const recipientPriv = createPrivateKey({
    key: Buffer.from(recipientX25519PrivBase64, 'base64'),
    format: 'der',
    type: 'pkcs8'
  });

  // ECDH with recipient private + ephemeral public
  const shared = diffieHellman({ privateKey: recipientPriv, publicKey: ephPub });

  // HKDF → same 32-byte symmetric key
  const key = hkdfSync('sha256', shared, '', 'agent-chat-v2', 32);

  // ChaCha20-Poly1305 decrypt
  const data = Buffer.from(ciphertextBase64, 'base64');
  const authTag = data.subarray(data.length - 16);
  const encryptedBody = data.subarray(0, data.length - 16);
  const nonce = Buffer.from(nonceBase64, 'base64');

  const decipher = createDecipheriv('chacha20-poly1305', Buffer.from(key), nonce, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedBody), decipher.final()]).toString('utf8');
}
