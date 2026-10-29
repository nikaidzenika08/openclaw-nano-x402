import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import N from 'nanocurrency';

const UINT128 = (1n << 128n) - 1n;
const fail = code => { throw new PaymentError(code); };
export class PaymentError extends Error {
  constructor(code) { super(code); this.name = 'PaymentError'; this.code = code; }
}
function raw(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,38}$/.test(value)) fail('invalid_amount');
  const result = BigInt(value);
  if (result > UINT128) fail('invalid_amount');
  return result;
}
function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('invalid_url');
  return url;
}
function address(value) {
  if (typeof value !== 'string' || !value.startsWith('nano_') || !N.checkAddress(value)) fail('invalid_recipient');
  return value;
}
function resourceValid(resource, requested) {
  if (!resource || resource.url !== requested) fail('resource_mismatch');
  const ascii = s => typeof s === 'string' && /^[\x20-\x7e]{1,32}$/.test(s);
  if (resource.serviceName !== undefined && !ascii(resource.serviceName)) fail('malformed_resource');
  if (resource.tags !== undefined && (!Array.isArray(resource.tags) || resource.tags.length > 5 || !resource.tags.every(ascii))) fail('malformed_resource');
  if (resource.description !== undefined && (typeof resource.description !== 'string' || resource.description.length > 4096)) fail('malformed_resource');
  if (resource.iconUrl !== undefined && (typeof resource.iconUrl !== 'string' || resource.iconUrl.length > 2048)) fail('malformed_resource');
}

export class MemoryJournal {
  constructor() { this.data = { entries: {} }; this.busy = false; }
  async run(fn) {
    if (this.busy) fail('wallet_busy');
    this.busy = true;
    try { return await fn(this.data, () => {}); } finally { this.busy = false; }
  }
}

// One cooperative writer per wallet/state directory. A crash leaves a lock:
// refuse until the operator checks pending blocks and removes that lock.
export class FileJournal {
  constructor(directory) {
    if (!isAbsolute(directory)) fail('state_directory_must_be_absolute');
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  async run(fn) {
    const lock = join(this.directory, 'wallet.lock');
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); } catch { fail('wallet_busy'); }
    try {
      writeFileSync(fd, String(process.pid));
      fsyncSync(fd);
      const file = join(this.directory, 'journal.json');
      let data;
      try { data = JSON.parse(readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') data = { entries: {} }; else fail('journal_unreadable'); }
      if (!data || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) fail('journal_unreadable');
      const save = () => {
        const temporary = join(this.directory, 'journal.next');
        const out = openSync(temporary, 'w', 0o600);
        try { writeFileSync(out, JSON.stringify(data)); fsyncSync(out); } finally { closeSync(out); }
        renameSync(temporary, file);
      };
      return await fn(data, save);
    } finally { closeSync(fd); unlinkSync(lock); }
  }
}

async function boundedText(response, maxBytes = 256 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) fail('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export class GuardedNanoClient {
  constructor({ origins, recipients, perCallRaw, totalRaw, signer, journal = new MemoryJournal(), fetch: transport = globalThis.fetch, now = () => performance.now() }) {
    if (!Array.isArray(origins) || !origins.length || !Array.isArray(recipients) || !recipients.length) fail('allowlists_required');
    this.origins = new Set(origins.map(value => {
      const url = httpsUrl(value);
      if (url.href !== url.origin + '/') fail('origin_required');
      return url.origin;
    }));
    this.recipients = new Set(recipients.map(address));
    this.perCall = raw(perCallRaw);
    this.total = raw(totalRaw);
    this.signer = signer;
    this.journal = journal;
    this.fetch = transport;
    this.now = now;
    this.results = new Map();
  }
  async request({ url: input, method = 'GET', body = '' }) {
    const url = httpsUrl(input).href;
    if (!this.origins.has(new URL(url).origin)) fail('origin_not_allowed');
    if (!['GET', 'POST'].includes(method) || typeof body !== 'string' || Buffer.byteLength(body) > 65536 || (method === 'GET' && body)) fail('invalid_request');
    const key = createHash('sha256').update(JSON.stringify([method, url, body])).digest('hex');
    return this.journal.run(async (data, save) => {
      if (data.entries[key]) {
        if (this.results.has(key)) return { ...this.results.get(key), cached: true };
        fail('already_attempted_check_journal');
      }
      const init = { method, ...(body ? { body, headers: { 'content-type': 'application/json' } } : {}), redirect: 'manual' };
      let prepared, accepted, resource, amount;
      // A slow account/work lookup must not make an old quote signable.
      for (let attempt = 0; attempt < 3; attempt++) {
        const receivedAt = this.now(); // Start before fetch; conservative quote age.
        const response = await this.fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
        if (response.status >= 300 && response.status < 400) fail('redirect_refused');
        if (response.status !== 402) {
          if (!response.ok) fail('unpaid_request_failed');
          return { status: response.status, body: await boundedText(response), paid: false };
        }
        const header = response.headers.get('payment-required');
        await response.body?.cancel();
        if (!header || header.length > 32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) fail('malformed_quote');
        let quote;
        try { quote = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { fail('malformed_quote'); }
        if (quote?.x402Version !== 2 || !Array.isArray(quote.accepts) || !quote.accepts.length || quote.accepts.length > 16) fail('malformed_quote');
        resource = quote.resource;
        resourceValid(resource, url);
        accepted = quote.accepts.find(entry => entry?.scheme === 'exact' && entry.network === 'nano:mainnet' && entry.asset === 'XNO');
        if (!accepted) fail('unsupported_payment');
        address(accepted.payTo);
        if (!this.recipients.has(accepted.payTo)) fail('recipient_not_allowed');
        amount = raw(accepted.amount);
        if (amount > this.perCall) fail('per_call_cap');
        if (!Number.isSafeInteger(accepted.maxTimeoutSeconds) || accepted.maxTimeoutSeconds < 1 || accepted.maxTimeoutSeconds > 3600) fail('malformed_timeout');
        if (accepted.extra !== undefined && (!accepted.extra || typeof accepted.extra !== 'object' || Array.isArray(accepted.extra))) fail('malformed_quote');
        if (accepted.extra?.workOptional !== undefined && typeof accepted.extra.workOptional !== 'boolean') fail('malformed_quote');
        const spent = Object.values(data.entries).reduce((sum, entry) => {
          if (!entry || typeof entry.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(entry.amount)) fail('journal_unreadable');
          return sum + BigInt(entry.amount);
        }, 0n);
        if (spent + amount > this.total) fail('total_cap');
        const lifetime = accepted.maxTimeoutSeconds * 1000;
        if (this.now() - receivedAt >= lifetime) continue;
        prepared = await this.signer.prepare(accepted);
        if (this.now() - receivedAt >= lifetime) { prepared = undefined; continue; }
        // Persist reservation BEFORE signing. Ambiguous/failed outcomes still use
        // budget and block duplicates; no automatic refund or new signed retry.
        data.entries[key] = { amount: amount.toString(), status: 'reserved', at: this.now() };
        save();
        const block = prepared.sign(); // Synchronous: no quote-expiry await gap.
        if (block && typeof block.then === 'function') fail('signer_must_be_synchronous');
        data.entries[key].blockHash = prepared.hash(block);
        save();
        const payload = { x402Version: 2, resource, accepted, payload: { block } };
        let paid;
        try {
          paid = await this.fetch(url, { ...init, headers: { ...init.headers, 'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64') }, signal: AbortSignal.timeout(30000) });
          if (!paid.ok) fail('paid_request_failed_no_retry');
          const result = { status: paid.status, body: await boundedText(paid), paid: true, amountRaw: amount.toString(), blockHash: prepared.hash(block) };
          data.entries[key].status = 'served';
          data.entries[key].blockHash = result.blockHash;
          save();
          this.results.set(key, result);
          return result;
        } catch { fail('payment_outcome_uncertain_check_journal'); }
      }
      fail('quote_expired');
    });
  }
}

export { boundedText };
