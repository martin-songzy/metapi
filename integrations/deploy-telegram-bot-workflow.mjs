import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.env.N8N_CLI_CONFIG || 'C:/Users/songz/.n8n-cli/config.json', 'utf8'));
const wf = JSON.parse(readFileSync(process.argv[2] || 'integrations/telegram-bot-workflow.json', 'utf8'));
const H = { 'X-N8N-API-KEY': cfg.apiKey, 'Content-Type': 'application/json' };

const list = await (await fetch(cfg.url + '/api/v1/workflows?limit=100', { headers: H })).json();
const target = list.data.find((w) => w.name === 'MetAPI Probe Bot');
if (!target) throw new Error('workflow not found');

const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {} };
const res = await fetch(cfg.url + '/api/v1/workflows/' + target.id, {
  method: 'PUT', headers: H, body: JSON.stringify(body),
});
const j = await res.json();
if (!res.ok) { console.error(res.status, JSON.stringify(j).slice(0, 800)); process.exit(1); }
console.log('deployed', j.id, 'versionId', j.versionId, 'nodes', j.nodes.length, 'active', j.active);
