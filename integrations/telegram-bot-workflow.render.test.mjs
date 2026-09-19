import { readFileSync } from 'node:fs';

const FILE = process.argv[2] || 'integrations/telegram-bot-workflow.json';
const wf = JSON.parse(readFileSync(FILE, 'utf8'));

function runNode(name, { input, nodes, store }) {
  const code = wf.nodes.find((n) => n.name === name).parameters.jsCode;
  const $input = { first: () => ({ json: input }), all: () => [{ json: input }] };
  const $ = (n) => {
    if (!(n in nodes)) throw new Error(`Node '${n}' hasn't been executed`);
    return { first: () => ({ json: nodes[n] }) };
  };
  const $getWorkflowStaticData = () => (store || {});
  const fn = new Function('$input', '$', '$getWorkflowStaticData', `return (async () => {${code}})()`);
  return fn($input, $, $getWorkflowStaticData);
}

const TG = 'https://api.telegram.org/botX';
const CHAT = 493325033;

let fails = 0;
const check = (label, cond, extra = '') => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails++;
};

const kb = () => ([
  [
    { text: '✅seekai', callback_data: 't:180001:seekai' },
    { text: '▫️咕咕嘎嘎…', callback_data: 't:180003:咕咕嘎嘎公益站' },
    { text: '▫️Tom&Je…', callback_data: 't:30004:Tom&Jerry公益站' },
  ],
  [
    { text: '🚀 直接探测', callback_data: 'run' },
    { text: '🔄 刷新', callback_data: 'refresh' },
    { text: '🧹 清空', callback_data: 'clr' },
  ],
]);

const cbEvent = (data, keyboard = kb()) => ({
  callback_query: {
    id: 'cb1',
    from: { id: 493325033 },
    data,
    message: { chat: { id: CHAT }, message_id: 77, reply_markup: { inline_keyboard: keyboard } },
  },
});

const API_SITES = [
  { siteId: 8, siteName: 'KAPI[国模]', modelCount: 7 },
  { siteId: 10, siteName: '魔方公益站', modelCount: 3 },
];

// ============ A. 回归：/targets 走缓存路径 ============
// 上游是「要调接口吗」的缓存命中分支，ctx 里带 apiSites。
// 旧版渲染键盘写死 $('预处理')，读不到 apiSites → 画成「没有可用的站点」。
console.log('=== /targets 缓存命中（原来在这里画成空面板）===');
{
  const ctx = { tgBase: TG, chatId: CHAT, action: 'render', cached: true, cachedAt: Date.now(), apiSites: API_SITES };
  const r = await runNode('渲染键盘', { input: ctx, nodes: { 预处理: { tgBase: TG, chatId: CHAT } } });
  const body = r[0].json.body;
  check('不是空面板', !body.text.includes('没有可用的站点'), JSON.stringify(body.text.split('\n')[0]));
  check('画出了 2 个站点按钮', body.reply_markup.inline_keyboard[0].length === 2);
  check('用 sendMessage（新消息）', r[0].json.url.endsWith('/sendMessage'));
  check('没有多余 ack', r.length === 1);
}

// ============ B. 回归：点刷新后走 API 路径 ============
console.log('=== /targets 刷新（刚拉完 API）===');
{
  const ctx = {
    tgBase: TG, chatId: CHAT, messageId: 1107, callbackQueryId: 'cb1', ackText: '🔄 已刷新',
    action: 'render', fetchFailed: null, apiSites: API_SITES, sites: [],
  };
  const r = await runNode('渲染键盘', { input: ctx, nodes: { 预处理: { tgBase: TG, chatId: CHAT } } });
  const body = r[0].json.body;
  check('不是空面板', !body.text.includes('没有可用的站点'));
  check('原地编辑', r[0].json.url.endsWith('/editMessageText'));
  check('带 message_id', body.message_id === 1107);
  check('回了 answerCallbackQuery（按钮不转圈）', r.some((i) => i.json.url.endsWith('/answerCallbackQuery')));
  check('ack 文案 = 🔄 已刷新', r.find((i) => i.json.url.endsWith('/answerCallbackQuery')).json.body.text === '🔄 已刷新');
}

// ============ C. 刷新前已勾选的，刷新后保留 ============
console.log('=== 刷新保留勾选 ===');
{
  const ctx = {
    tgBase: TG, chatId: CHAT, messageId: 1, action: 'render', apiSites: API_SITES,
    sites: [{ siteId: 10, siteName: '魔方公益站', on: true }],
  };
  const r = await runNode('渲染键盘', { input: ctx, nodes: { 预处理: {} } });
  const flat = r[0].json.body.reply_markup.inline_keyboard.flat();
  check('魔方公益站仍是 ✅', flat.find((b) => b.callback_data.startsWith('t:10:')).text.startsWith('✅'));
  check('KAPI 是 ▫️', flat.find((b) => b.callback_data.startsWith('t:8:')).text.startsWith('▫️'));
}

// ============ D. 点击路径仍然零 IO ============
console.log('=== 点击路径（列表来自键盘本身）===');
{
  const r0 = await runNode('预处理', { input: cbEvent('t:180003'), nodes: {} });
  const r = await runNode('渲染键盘', { input: r0[0].json, nodes: { 预处理: { tgBase: TG, chatId: CHAT } } });
  const body = r[0].json.body;
  check('原地编辑', r[0].json.url.endsWith('/editMessageText'));
  check('3 个站点都在', body.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data.startsWith('t:')).length === 3);
  check('勾选状态更新了', body.text.includes('已选 2 个'), body.text.split('\n').at(-2));
}

// ============ E. 真·空列表（API 挂了、也没缓存）============
console.log('=== 真·没有站点 ===');
{
  const ctx = { tgBase: TG, chatId: CHAT, messageId: 1107, callbackQueryId: 'cb1',
    action: 'render', fetchFailed: 'ECONNREFUSED', apiSites: [] };
  const r = await runNode('渲染键盘', { input: ctx, nodes: { 预处理: {} } });
  check('提示里带失败原因', r[0].json.body.text.includes('ECONNREFUSED'), r[0].json.body.text.split('\n')[0]);
  check('原地编辑（不再刷屏）', r[0].json.url.endsWith('/editMessageText'));
  check('仍有刷新按钮', r[0].json.body.reply_markup.inline_keyboard[0][0].callback_data === 'refresh');
  check('应答了回调（按钮不转圈）', r.some((i) => i.json.url.endsWith('/answerCallbackQuery')));
}

// ============ F. 拉失败但有旧缓存 → 用旧列表 ============
console.log('=== 拉失败但有旧缓存 ===');
{
  const ctx = { tgBase: TG, chatId: CHAT, messageId: 1107, action: 'render',
    fetchFailed: 'timeout', apiSites: API_SITES };
  const r = await runNode('渲染键盘', { input: ctx, nodes: { 预处理: {} } });
  check('仍画出旧列表', r[0].json.body.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data.startsWith('t:')).length === 2);
  check('顶部警告刷新失败', r[0].json.body.text.includes('⚠️'), r[0].json.body.text.split('\n')[0]);
}

console.log();
console.log(fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
