# Nano x402 for OpenClaw

An OpenClaw tool that fetches an allowlisted HTTPS resource and, if it returns an
x402 v2 quote, pays an allowlisted Nano recipient within operator-set limits.
The agent cannot change the wallet, recipient list, origin list or budgets.

Built for [Pursekeeper integration bounty slot 4](https://pursekeeper.dev/integrations).
AI implementation and testing: OpenAI Codex, operated by Luka Bakhturidze.
No independent human code review is claimed. MIT licensed.

## Installation

Requires **Node 24.22.2** and **OpenClaw 2026.10.4**. That is the only host
version targeted by this release; future compatibility is not assumed.

```sh
npm install --ignore-scripts openclaw-nano-x402-luka@0.1.0
openclaw plugins install npm:openclaw-nano-x402-luka@0.1.0
```

The release package is `openclaw-nano-x402-luka@0.1.0`; check its
[npm listing](https://www.npmjs.com/package/openclaw-nano-x402-luka) for public
availability. For source review, clone this repository, run
`npm ci --ignore-scripts`, and add its absolute path to `plugins.load.paths`.

Configure the plugin (replace the state directory with an absolute, private
directory owned by the operator):

```json
{
  "plugins": {
    "allow": ["nano-x402"],
    "entries": {
      "nano-x402": {
        "enabled": true,
        "config": {
          "origins": ["https://pursekeeper.dev"],
          "recipients": ["nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue"],
          "perCallRaw": "1000000000000000000000000000",
          "totalRaw": "1000000000000000000000000000",
          "stateDir": "/absolute/private/nano-x402-state"
        }
      }
    }
  },
  "tools": {"alsoAllow": ["nano_x402_fetch"]}
}
```

The example permits one payment of **0.001 XNO**. Amounts are integer raw:
1 XNO = 10^30 raw. Independently verify the seller address before configuring it.
Provide a dedicated, opened and minimally funded wallet through `NANO_SEED` in
the host process environment (optional `NANO_INDEX`, default 0). Never put a
wallet seed in chat, source code, a tool argument, a config file or a commit.
Do not run other wallet writers against the same account. The caller must
fund/open that wallet before the payment tool can use it.

## Call from the agent

```sh
openclaw agent exec 'Use nano_x402_fetch once to fetch https://pursekeeper.dev/v1/fetch?url=https%3A%2F%2Fexample.com and report the result. Do not retry a payment error.' --code-mode direct --json
```

This goes through OpenClaw's model/tool/response loop. It requires the operator's
normally configured model and wallet. The tool returns HTTP status, purchased
content, amount in raw and block hash; it does not return a signed block or key.
Untrusted resource content must be treated as data, not instructions.

For a reproducible example without model credentials or inference charges,
`examples/agent-loop.js` starts a deterministic local OpenAI-compatible model
fixture and launches the **real OpenClaw CLI agent loop**. The fixture requests
the tool once and reads its result. It does not impersonate a live model.

```sh
# Point to the exact installed OpenClaw package entry point.
export OPENCLAW_CLI=/absolute/path/node_modules/openclaw/openclaw.mjs
node examples/agent-loop.js          # offline origin-refusal check; no payments
node examples/agent-loop.js --live   # one real 0.001-XNO mainnet call
```

On PowerShell use `$env:OPENCLAW_CLI = 'C:\absolute\path\openclaw.mjs'`.
The live command uses `NANO_SEED`, a fixed seller allowlist and a total cap of
0.001 XNO. It keeps state under `.live-state/` (or `NANO_EXAMPLE_STATE`). Running
it again cannot pay again for that same request with the same journal.

## Guards and failure recovery

Before signing, the client checks HTTPS, allowed origin, x402 version, scheme,
network, asset, exact resource URL, recipient address/checksum/allowlist, positive
integer amount, per-call budget, cumulative budget and quote timeout. Quote age
uses a monotonic clock and includes request/prepare time. A quote that expires
while fetching wallet state or work is discarded and re-fetched/revalidated,
up to three unsigned attempts.

All redirects are refused, including same-origin redirects. Signed requests
never follow a redirect. A non-2xx or lost response after signing is never
automatically retried. A journal reservation is fsynced before signing; the
block hash is saved before transmission. Ambiguous outcomes continue to consume
budget. The returned error is a fixed identifier, not raw dependency output.

Identical URL/method/body requests share a journal key. A successful repeat in
one client returns its cached result; a repeat after a restart is refused.
Different URL queries or bodies are different requests, but share the same cap.
The total cap persists for the lifetime of the journal, across process restarts.

The file journal holds an exclusive cooperative wallet lock. Concurrent writers
using the same state directory are refused. A crash can leave `wallet.lock`:
first verify that no wallet writer is active, inspect `journal.json` and check
its block hashes on the chain, then recover manually. Do not delete the journal
to "retry" an uncertain payment. Keep one state directory per wallet; separate
directories/hosts do not coordinate. Use a fresh account per independent writer.

Work is omitted only when `extra.workOptional` is the boolean `true`. Otherwise
configure a trusted HTTPS `workUrl`; its work is checked locally against the
Nano send threshold before signing. No automatic installation hooks, automatic
wallet creation, swaps, funding purchases or background paid retries are used.

## Development and verification

```sh
npm ci --ignore-scripts
npm test
```

The offline suite covers wrong networks/assets/schemes, invalid and unapproved
recipients, malformed quotes, both caps, duplicate attempts, redirects, quote
expiry, failed and lost paid replies, durable restart state, corrupt journals,
orphan locks and verifiable signatures produced by `nanocurrency@2.5.0`.
Public all-zero/all-one seeds in tests are known test vectors: never fund them.

See [VERIFICATION.md](VERIFICATION.md) for checks actually completed and current
submission blockers. Passing offline tests is not evidence of a mainnet payment
or a bounty award.
