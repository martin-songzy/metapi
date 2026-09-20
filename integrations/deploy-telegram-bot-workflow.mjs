import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.env.N8N_CLI_CONFIG || 'C:/Users/songz/.n8n-cli/config.json', 'utf8'));
const wf = JSON.parse(readFileSync(process.argv[2] || 'integrations/telegram-bot-workflow.json', 'utf8'));
const H = { 'X-N8N-API-KEY': cfg.apiKey, 'Content-Type': 'application/json' };

const list = await (await fetch(cfg.url + '/api/v1/workflows?limit=100', { headers: H })).json();
const target = list.data.find((w) => w.name === 'MetAPI Probe Bot');
if (!target) throw new Error('workflow not found');

// n8n 的 settings 里多数字段是只读的，PUT 回去会被 schema 拒。
// 只挑可写的传，其余由 n8n 自己保留。
const WRITABLE_SETTINGS = new Set(['executionOrder', 'errorWorkflow', 'timezone', 'saveManualExecutions', 'saveExecutionProgress', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'executionTimeout']);
const settings = {};
for (const [k, v] of Object.entries(wf.settings || {})) {
  if (WRITABLE_SETTINGS.has(k)) settings[k] = v;
}

const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings };
const res = await fetch(cfg.url + '/api/v1/workflows/' + target.id, {
  method: 'PUT', headers: H, body: JSON.stringify(body),
});
const j = await res.json();
if (!res.ok) { console.error(res.status, JSON.stringify(j).slice(0, 800)); process.exit(1); }
console.log('deployed', j.id, 'versionId', j.versionId, 'nodes', j.nodes.length, 'active', j.active);
