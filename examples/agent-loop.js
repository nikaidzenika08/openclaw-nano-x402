// Uses the real OpenClaw 2026.10.4 CLI/agent loop. Only the model is a local,
// deterministic OpenAI-compatible fixture: no model account or API fees.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.OPENCLAW_CLI;
if (!cli || !existsSync(cli)) throw new Error('Set OPENCLAW_CLI to the installed openclaw/openclaw.mjs path (version 2026.10.4).');
const live = process.argv.includes('--live');
if (live && !process.env.NANO_SEED) throw new Error('The live example requires an operator-provided NANO_SEED.');
const state = live ? resolve(process.env.NANO_EXAMPLE_STATE || join(root, '.live-state')) : mkdtempSync(join(tmpdir(), 'nano-openclaw-loop-'));
mkdirSync(state, { recursive: true });
const target = live ? 'https://pursekeeper.dev/v1/fetch?url=https%3A%2F%2Fexample.com' : 'https://blocked.invalid/example';
let toolResult, modelCalls = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 4 * 1024 * 1024) { res.writeHead(413).end(); return; } }
  let input;
  try { input = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  modelCalls++;
  toolResult = input.messages?.findLast(message => message.role === 'tool');
  const offered = input.tools?.some(tool => tool.function?.name === 'nano_x402_fetch');
  if (!toolResult && !offered) { res.writeHead(400).end(JSON.stringify({ error: { message: 'Plugin tool was not offered to the model' } })); return; }
  const content = toolResult ? 'The registered Nano tool returned: ' + toolResult.content : null;
  const toolCalls = toolResult ? undefined : [{ index: 0, id: 'nano_example_1', type: 'function', function: { name: 'nano_x402_fetch', arguments: JSON.stringify({ url: target }) } }];
  const message = { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
  if (input.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ id: 'nano-fixture', object: 'chat.completion.chunk', model: 'nano-fixture', choices: [{ index: 0, delta: message, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'nano-fixture', object: 'chat.completion.chunk', model: 'nano-fixture', choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'nano-fixture', object: 'chat.completion', model: 'nano-fixture', choices: [{ index: 0, message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const config = {
  models: { mode: 'merge', providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only', api: 'openai-completions', models: [{ id: 'nano-fixture', name: 'Deterministic Nano integration fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  agents: { defaults: { model: { primary: 'fixture/nano-fixture' }, workspace: state, skipBootstrap: true } },
  tools: { allow: ['nano_x402_fetch'] },
  plugins: { allow: ['nano-x402'], load: { paths: [root] }, entries: { 'nano-x402': { enabled: true, config: {
    origins: ['https://pursekeeper.dev'], recipients: ['nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue'],
    perCallRaw: '1000000000000000000000000000', totalRaw: '1000000000000000000000000000', stateDir: join(state, 'payments')
  } } } }
};
const configPath = join(state, 'openclaw.json');
writeFileSync(configPath, JSON.stringify(config, null, 2));
const environment = {
  // Do not inherit provider credentials or external CLI sign-ins.
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
  HOME: state, USERPROFILE: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
  NANO_SEED: live ? process.env.NANO_SEED : '0'.repeat(64), NANO_INDEX: process.env.NANO_INDEX || '0',
  OPENCLAW_DISABLE_TELEMETRY: '1'
};
let stdout = '', stderr = '';
try {
  const child = spawn(process.execPath, [cli, 'agent', 'exec', 'Call nano_x402_fetch once for the example resource. Summarize the tool result. Do not retry.', '--config', configPath, '--state-dir', state, '--code-mode', 'direct', '--timeout', '90', '--json'], { env: environment, cwd: state, windowsHide: true });
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const status = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); });
  if (status !== 0 || !toolResult) throw new Error(`OpenClaw example failed (${status}).\n${stderr}\n${stdout}`);
  const parsed = typeof toolResult.content === 'string' ? JSON.parse(toolResult.content) : toolResult.content;
  if (live ? parsed.paid !== true : parsed.error !== 'origin_not_allowed') throw new Error('Unexpected plugin result: ' + JSON.stringify(parsed));
  console.log(JSON.stringify({ openclawVersion: '2026.10.4', model: 'scripted local fixture, no inference service', live, modelCalls, toolResult: parsed, state }, null, 2));
} finally { await new Promise(done => server.close(done)); }
