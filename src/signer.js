import N from 'nanocurrency';
import { PaymentError, boundedText } from './client.js';

const hex64 = value => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
const https = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new PaymentError('invalid_signer_service');
  return url;
};

/** Keys never leave this closure; no signed payload is logged or persisted. */
export function createNanoSigner({ seed, index = 0, accountApi = 'https://pursekeeper.dev', workUrl, fetch: transport = globalThis.fetch }) {
  if (!hex64(seed) || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) throw new PaymentError('invalid_wallet_configuration');
  const secret = N.deriveSecretKey(seed, index);
  const account = N.deriveAddress(N.derivePublicKey(secret), { useNanoPrefix: true });
  const service = https(accountApi).origin;
  if (workUrl) https(workUrl);
  async function json(url, init = {}) {
    const response = await transport(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new PaymentError('wallet_service_unavailable');
    let value;
    try { value = JSON.parse(await boundedText(response, 32768)); }
    catch { throw new PaymentError('wallet_service_invalid'); }
    return value;
  }
  return {
    account,
    async prepare(quote) {
      const info = await json(service + '/v1/account_info?account=' + encodeURIComponent(account));
      if (info.found !== true || !hex64(info.frontier) || !N.checkAddress(info.representative) || !/^(0|[1-9][0-9]{0,38})$/.test(info.balance_raw)) throw new PaymentError('wallet_must_be_open_and_funded');
      const balance = BigInt(info.balance_raw) - BigInt(quote.amount);
      if (balance < 0n) throw new PaymentError('insufficient_balance');
      let work = '0000000000000000';
      if (quote.extra?.workOptional !== true) {
        if (!workUrl) throw new PaymentError('work_service_required');
        const result = await json(workUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: info.frontier, action: 'work_generate', difficulty: 'fffffff800000000' }) });
        if (!N.validateWork({ blockHash: info.frontier, work: result.work, threshold: 'fffffff800000000' })) throw new PaymentError('invalid_work');
        work = result.work;
      }
      return {
        sign: () => {
          const block = N.createBlock(secret, { work, previous: info.frontier, representative: info.representative, balance: balance.toString(), link: quote.payTo }).block;
          block.account = account; // Library emits legacy xrb_ spelling; canonicalize.
          return block;
        },
        hash: block => N.hashBlock(block)
      };
    }
  };
}
