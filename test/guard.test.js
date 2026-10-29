import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import N from 'nanocurrency';
import { GuardedNanoClient, FileJournal } from '../src/client.js';

const recipient = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey('0'.repeat(64), 0)), { useNanoPrefix: true });
const other = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey('1'.repeat(64), 0)), { useNanoPrefix: true });
const url = 'https://seller.test/v1/fetch?url=https%3A%2F%2Fexample.com';
function fixture({ mutate = () => {}, prepare = () => {}, paidStatus = 200, journal, quoteStatus = 402, header, paidThrow = false } = {}) {
  let signed = 0, prepared = 0, quotes = 0, paid = 0;
  const calls = [];
  let clock = 0;
  const client = new GuardedNanoClient({ origins: ['https://seller.test'], recipients: [recipient], perCallRaw: '10', totalRaw: '20', journal,
    now: () => clock,
    signer: { async prepare(quote) { prepared++; await prepare({ quote, advance: ms => { clock += ms; }, prepared }); return { sign() { signed++; return { fixture: true }; }, hash: () => 'a'.repeat(64) }; } },
    fetch: async (target, options) => {
      calls.push({ target, options });
      if (options.headers?.['payment-signature']) {
        paid++;
        if (paidThrow) throw new Error('secret must never escape');
        return new Response('paid content', { status: paidStatus });
      }
      quotes++;
      const quote = { x402Version: 2, resource: { url: target }, accepts: [{ scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', amount: '10', payTo: recipient, maxTimeoutSeconds: 10, extra: { workOptional: true } }] };
      mutate(quote, quotes);
      return new Response(quoteStatus === 402 ? '{}' : 'free content', { status: quoteStatus, headers: { 'payment-required': header ?? Buffer.from(JSON.stringify(quote)).toString('base64') } });
    }
  });
  return { client, calls, counters: () => ({ signed, prepared, quotes, paid }) };
}

for (const [name, mutate, code] of [
  ['wrong network', q => { q.accepts[0].network = 'eip155:8453'; }, 'unsupported_payment'],
  ['wrong asset', q => { q.accepts[0].asset = 'USDC'; }, 'unsupported_payment'],
  ['wrong scheme', q => { q.accepts[0].scheme = 'upto'; }, 'unsupported_payment'],
  ['unapproved recipient', q => { q.accepts[0].payTo = other; }, 'recipient_not_allowed'],
  ['invalid recipient', q => { q.accepts[0].payTo = 'nano_bad'; }, 'invalid_recipient'],
  ['per-call cap', q => { q.accepts[0].amount = '11'; }, 'per_call_cap'],
  ['numeric amount', q => { q.accepts[0].amount = 10; }, 'invalid_amount'],
  ['negative amount', q => { q.accepts[0].amount = '-1'; }, 'invalid_amount'],
  ['fractional amount', q => { q.accepts[0].amount = '1.5'; }, 'invalid_amount'],
  ['zero amount', q => { q.accepts[0].amount = '0'; }, 'invalid_amount'],
  ['overflow amount', q => { q.accepts[0].amount = (1n << 128n).toString(); }, 'invalid_amount'],
  ['missing accepts', q => { delete q.accepts; }, 'malformed_quote'],
  ['wrong version', q => { q.x402Version = 1; }, 'malformed_quote'],
  ['resource substitution', q => { q.resource.url = 'https://other.test'; }, 'resource_mismatch'],
  ['malformed timeout', q => { q.accepts[0].maxTimeoutSeconds = '10'; }, 'malformed_timeout'],
  ['zero timeout', q => { q.accepts[0].maxTimeoutSeconds = 0; }, 'malformed_timeout'],
  ['malformed work flag', q => { q.accepts[0].extra.workOptional = 'true'; }, 'malformed_quote'],
  ['oversized resource name', q => { q.resource.serviceName = 'x'.repeat(33); }, 'malformed_resource']
]) {
  test(name + ' refuses before signer preparation', async () => {
    const f = fixture({ mutate });
    await assert.rejects(f.client.request({ url }), { code });
    assert.equal(f.counters().prepared, 0);
    assert.equal(f.counters().signed, 0);
  });
}
test('successful payment carries v2 payload and caches duplicate without a second signature', async () => {
  const f = fixture();
  const first = await f.client.request({ url });
  const second = await f.client.request({ url });
  assert.equal(first.paid, true);
  assert.equal(second.cached, true);
  assert.deepEqual(f.counters(), { signed: 1, prepared: 1, quotes: 1, paid: 1 });
  const payload = JSON.parse(Buffer.from(f.calls[1].options.headers['payment-signature'], 'base64').toString());
  assert.equal(payload.x402Version, 2);
  assert.equal(payload.accepted.network, 'nano:mainnet');
  assert.equal(f.calls[1].options.redirect, 'manual');
});
test('cumulative cap blocks the third distinct request before signing', async () => {
  const f = fixture();
  await f.client.request({ url });
  await f.client.request({ url: url + '&n=2' });
  await assert.rejects(f.client.request({ url: url + '&n=3' }), { code: 'total_cap' });
  assert.equal(f.counters().signed, 2);
});
test('cross-origin and same-origin redirects are not followed or paid', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const f = fixture({ quoteStatus: status });
    await assert.rejects(f.client.request({ url }), { code: 'redirect_refused' });
    assert.equal(f.counters().signed, 0);
    assert.equal(f.calls.length, 1);
  }
});
test('unapproved origin, HTTP, embedded credentials, fragments and invalid methods fail before network', async () => {
  const f = fixture();
  for (const request of [{ url: 'https://other.test' }, { url: 'http://seller.test' }, { url: 'https://user:pass@seller.test' }, { url: url + '#x' }, { url, method: 'DELETE' }]) {
    await assert.rejects(f.client.request(request));
  }
  assert.equal(f.calls.length, 0);
});
test('malformed base64 quote is rejected unsigned', async () => {
  const f = fixture({ header: 'not base64?' });
  await assert.rejects(f.client.request({ url }), { code: 'malformed_quote' });
  assert.equal(f.counters().signed, 0);
});
test('expired quote is fetched again, and changed recipient is revalidated', async () => {
  const f = fixture({ prepare: ({ advance }) => advance(11000), mutate(q, attempt) { if (attempt === 2) q.accepts[0].payTo = other; } });
  await assert.rejects(f.client.request({ url }), { code: 'recipient_not_allowed' });
  assert.deepEqual(f.counters(), { signed: 0, prepared: 1, quotes: 2, paid: 0 });
});
test('fresh replacement quote can be paid once', async () => {
  const f = fixture({ prepare: ({ advance, prepared }) => { if (prepared === 1) advance(11000); } });
  await f.client.request({ url });
  assert.deepEqual(f.counters(), { signed: 1, prepared: 2, quotes: 2, paid: 1 });
});
test('repeated stale quotes fail after three unsigned attempts', async () => {
  const f = fixture({ prepare: ({ advance }) => advance(11000) });
  await assert.rejects(f.client.request({ url }), { code: 'quote_expired' });
  assert.equal(f.counters().signed, 0);
  assert.equal(f.counters().quotes, 3);
});
for (const status of [302, 402, 500]) test('paid HTTP ' + status + ' is never paid again', async () => {
  const f = fixture({ paidStatus: status });
  await assert.rejects(f.client.request({ url }), { code: 'payment_outcome_uncertain_check_journal' });
  await assert.rejects(f.client.request({ url }), { code: 'already_attempted_check_journal' });
  assert.equal(f.counters().signed, 1);
  assert.equal(f.counters().paid, 1);
});
test('lost paid reply cannot trigger a second send or expose a dependency error', async () => {
  const f = fixture({ paidThrow: true });
  await assert.rejects(f.client.request({ url }), error => error.code === 'payment_outcome_uncertain_check_journal' && !error.message.includes('secret'));
  await assert.rejects(f.client.request({ url }), { code: 'already_attempted_check_journal' });
  assert.equal(f.counters().signed, 1);
});
test('free successful resource never invokes signer', async () => {
  const f = fixture({ quoteStatus: 200 });
  const result = await f.client.request({ url });
  assert.equal(result.paid, false);
  assert.equal(f.counters().signed, 0);
});
test('file journal preserves attempts and caps across client restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nano-guard-'));
  try {
    const f = fixture({ journal: new FileJournal(dir) });
    await f.client.request({ url });
    const restarted = fixture({ journal: new FileJournal(dir) });
    await assert.rejects(restarted.client.request({ url }), { code: 'already_attempted_check_journal' });
    await restarted.client.request({ url: url + '&n=2' });
    await assert.rejects(restarted.client.request({ url: url + '&n=3' }), { code: 'total_cap' });
    assert.equal(restarted.counters().signed, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('corrupt journal and orphaned wallet lock fail closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nano-guard-'));
  try {
    writeFileSync(join(dir, 'journal.json'), '{');
    const f = fixture({ journal: new FileJournal(dir) });
    await assert.rejects(f.client.request({ url }), { code: 'journal_unreadable' });
    writeFileSync(join(dir, 'wallet.lock'), 'orphan');
    await assert.rejects(f.client.request({ url }), { code: 'wallet_busy' });
    assert.equal(f.counters().signed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
