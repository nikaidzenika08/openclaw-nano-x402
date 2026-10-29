import { test } from 'node:test';
import assert from 'node:assert/strict';
import N from 'nanocurrency';
import { createNanoSigner } from '../src/signer.js';
const seed = '0'.repeat(64); // Public test vector, never fund this account.
const address = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey(seed, 0)), { useNanoPrefix: true });
test('real Nano library signs the exact balance delta with a verifiable signature', async () => {
  const signer = createNanoSigner({ seed, fetch: async () => Response.json({ found: true, frontier: '1'.repeat(64), representative: address, balance_raw: '100' }) });
  const prepared = await signer.prepare({ amount: '10', payTo: address, extra: { workOptional: true } });
  const block = prepared.sign();
  assert.equal(block.balance, '90');
  assert.equal(block.previous, '1'.repeat(64));
  assert.equal(block.account, address);
  assert.equal(N.verifyBlock({ hash: prepared.hash(block), signature: block.signature, publicKey: N.derivePublicKey(N.deriveSecretKey(seed, 0)) }), true);
});
test('missing optional-work flag requires a configured work provider before signing', async () => {
  const signer = createNanoSigner({ seed, fetch: async () => Response.json({ found: true, frontier: '1'.repeat(64), representative: address, balance_raw: '100' }) });
  await assert.rejects(signer.prepare({ amount: '10', payTo: address }), { code: 'work_service_required' });
});
test('account service failure is refused', async () => {
  const signer = createNanoSigner({ seed, fetch: async () => new Response('error', { status: 503 }) });
  await assert.rejects(signer.prepare({ amount: '10', payTo: address }), { code: 'wallet_service_unavailable' });
});
