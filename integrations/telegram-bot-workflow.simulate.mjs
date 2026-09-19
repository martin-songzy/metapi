import { readFileSync } from 'node:fs';
const wf = JSON.parse(readFileSync('integrations/telegram-bot-workflow.json', 'utf8'));

function runNode(name, { input, nodes, store }) {
  const code = wf.nodes.find((n) => n.name === name).parameters.jsCode;
  const $input = { first: () => ({ json: input }) };
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

// 键盘格式：t:<id>:<全名>，按钮文字截断
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

// ============ 1. 点击已选 → 取消 ============
console.log('=== 点击已选的 seekai（应取消）===');
{
  const r = await runNode('预处理', { input: cbEvent('t:180001'), nodes: {} });
  const j = r[0].json;
  check('action=render', j.action === 'render');
  check('seekai 变为未选', j.sites.find((x) => x.siteId === 180001).on === false);
  check('其余保持已选', j.sites.filter((x) => x.on).length === 0);
  check('ack 用全名（不是截断名）', j.ackText === '➖ seekai · 已选 0 个', j.ackText);
}

// ============ 2. 全名从 callback_data 还原 ============
console.log('=== 全名还原 ===');
{
  const r = await runNode('预处理', { input: cbEvent('t:180003'), nodes: {} });
  const s = r[0].json.sites.find((x) => x.siteId === 180003);
  check('全名 = 咕咕嘎嘎公益站', s.siteName === '咕咕嘎嘎公益站', JSON.stringify(s.siteName));
  check('按钮文字仍是截断的', s.label === '咕咕嘎嘎…', JSON.stringify(s.label));
  check('ack 用全名', r[0].json.ackText === '➕ 咕咕嘎嘎公益站 · 已选 2 个', r[0].json.ackText);
}

// ============ 3. 名字含冒号 ============
console.log('=== 名字含冒号 ===');
{
  const weird = [[
    { text: '▫️API: v2', callback_data: 't:99:API: v2 站' },
  ]];
  const r = await runNode('预处理', { input: cbEvent('t:99', weird), nodes: {} });
  const s = r[0].json.sites[0];
  check('id 解析正确 = 99', s.siteId === 99);
  check('全名保留「API: v2 站」', s.siteName === 'API: v2 站', JSON.stringify(s.siteName));
}

// ============ 4. 老格式键盘（无全名）仍能解析 ============
console.log('=== 向后兼容：旧键盘 t:<id> ===');
{
  const legacy = [[
    { text: '✅ seekai (8)', callback_data: 't:180001' },
    { text: '▫️ other (2)', callback_data: 't:180002' },
  ]];
  const r = await runNode('预处理', { input: cbEvent('refresh', legacy), nodes: {} });
  const s = r[0].json.sites.find((x) => x.siteId === 180001);
  check('id 解析正确', s.siteId === 180001);
  check('名字退回按钮文字（去掉前缀）', s.siteName === 'seekai (8)', JSON.stringify(s.siteName));
  check('识别出已选的那个', s.on === true);
  check('未选的识别为未选', r[0].json.sites.find((x) => x.siteId === 180002).on === false);

  const run = await runNode('预处理', { input: cbEvent('run', legacy), nodes: {} });
  check('直接探测只带已选的', JSON.stringify(run[0].json.siteIds) === '[180001]', JSON.stringify(run[0].json.siteIds));
}

// ============ 5. 生成命令按钮已移除 ============
console.log('=== gen 按钮已移除 ===');
{
  const r = await runNode('预处理', { input: cbEvent('gen'), nodes: {} });
  check('gen 落到「未知操作」', r[0].json.text === '未知操作', r[0].json.text);
}

// ============ 6. 直接探测 ============
console.log('=== 直接探测 ===');
{
  const r = await runNode('预处理', { input: cbEvent('run'), nodes: {} });
  check('siteIds = 选中的 1 个', JSON.stringify(r[0].json.siteIds) === '[180001]', JSON.stringify(r[0].json.siteIds));
}

// ============ 7. 刷新 ============
console.log('=== 刷新 ===');
{
  const r = await runNode('预处理', { input: cbEvent('refresh'), nodes: {} });
  check('action=fetch', r[0].json.action === 'fetch');
  check('force=true（绕过缓存）', r[0].json.force === true);
  check('勾选带过去', r[0].json.sites.filter((s) => s.on).length === 1);
}

// ============ 8. 缓存判断 ============
console.log('=== 缓存判断 ===');
{
  const now = Date.now();
  const fresh = await runNode('缓存判断', {
    input: {}, nodes: { 预处理: { action: 'fetch', chatId: CHAT, sites: [] } },
    store: { sites: { [CHAT]: [{ siteId: 1, siteName: 'x' }] }, cachedAt: { [CHAT]: now } },
  });
  check('缓存存在 → 直接渲染', fresh[0].json.action === 'render' && fresh[0].json.cached === true);
  check('带出 cachedAt', typeof fresh[0].json.cachedAt === 'number');

  // 长期缓存：不再按时间过期。一周前的列表照样直接用，只有 force 才重拉。
  const ancient = await runNode('缓存判断', {
    input: {}, nodes: { 预处理: { action: 'fetch', chatId: CHAT, sites: [] } },
    store: { sites: { [CHAT]: [{ siteId: 1 }] }, cachedAt: { [CHAT]: now - 7 * 24 * 60 * 60 * 1000 } },
  });
  check('缓存再老也不过期（长期缓存）', ancient[0].json.action === 'render', ancient[0].json.action);

  const forced = await runNode('缓存判断', {
    input: {}, nodes: { 预处理: { action: 'fetch', chatId: CHAT, force: true, sites: [] } },
    store: { sites: { [CHAT]: [{ siteId: 1 }] }, cachedAt: { [CHAT]: now } },
  });
  check('force=true（点刷新）→ 调接口', forced[0].json.action === 'need-api');

  const empty = await runNode('缓存判断', {
    input: {}, nodes: { 预处理: { action: 'fetch', chatId: CHAT, sites: [] } },
    store: { sites: {}, cachedAt: {} },
  });
  check('从没缓存过 → 调接口', empty[0].json.action === 'need-api');
}

// ============ 9. 渲染键盘：每行 3 个 + 截断 ============
console.log('=== 渲染键盘：布局 ===');
{
  const ctx = { tgBase: TG, chatId: CHAT, messageId: 77, callbackQueryId: 'cb1',
    sites: [
      { siteId: 1, siteName: 'seekai', label: 'seekai', on: true },
      { siteId: 2, siteName: '咕咕嘎嘎公益站', label: '咕咕嘎嘎…', on: false },
      { siteId: 3, siteName: 'Tom&Jerry公益站', label: 'Tom&Je…', on: true },
      { siteId: 4, siteName: 'KAPI[国模]', label: 'KAPI[国…', on: false },
    ], ackText: 'x' };
  const r = await runNode('渲染键盘', { input: ctx, nodes: { 预处理: ctx } });
  const rows = r[0].json.body.reply_markup.inline_keyboard;
  check('4 个站点 → 2 行（每行 3 个）', rows.length === 3, '共 ' + rows.length + ' 行（含操作行）');
  check('第 1 行 3 个按钮', rows[0].length === 3);
  check('第 2 行 1 个按钮', rows[1].length === 1);
  check('操作行 3 个按钮', rows[2].length === 3);
  check('操作行没有「生成命令」', !rows[2].some((b) => b.callback_data === 'gen'));
  check('操作行有「刷新」', rows[2].some((b) => b.callback_data === 'refresh'));
  check('按钮文字用 ✅/▫️ 无空格', rows[0][0].text === '✅seekai', rows[0][0].text);
  check('callback_data 带全名', rows[0][1].callback_data === 't:2:咕咕嘎嘎公益站', rows[0][1].callback_data);
  check('正文用全名', r[0].json.body.text.includes('seekai、Tom&Jerry公益站'), r[0].json.body.text.split('\n').at(-2));
  console.log('  --- 正文 ---');
  console.log(r[0].json.body.text.split('\n').map((l) => '  ' + l).join('\n'));
}

// ============ 10. 截断逻辑 ============
console.log('=== 名字截断（上限 7）===');
{
  const ctx = { tgBase: TG, chatId: CHAT, messageId: 77,
    sites: [
      { siteId: 1, siteName: '短名', on: false },
      { siteId: 2, siteName: '一二三四五六七', on: false },
      { siteId: 3, siteName: '一二三四五六七八', on: false },
      { siteId: 4, siteName: 'a', on: false },
    ] };
  const r = await runNode('渲染键盘', { input: ctx, nodes: { 预处理: ctx } });
  const flat = r[0].json.body.reply_markup.inline_keyboard.flat();
  check('2 字不变', flat[0].text === '▫️短名', flat[0].text);
  check('7 字不变', flat[1].text === '▫️一二三四五六七', flat[1].text);
  check('8 字 → 6 字+…', flat[2].text === '▫️一二三四五六…', flat[2].text);
  check('全名仍在 callback_data', flat[2].callback_data === 't:3:一二三四五六七八');
}

// ============ 11. 缓存提示 ============
console.log('=== 缓存提示 ===');
{
  const ctx = { tgBase: TG, chatId: CHAT, messageId: 77, cached: true, cachedAt: Date.now(),
    sites: [{ siteId: 1, siteName: 'x', on: false }] };
  const r = await runNode('渲染键盘', { input: ctx, nodes: { 预处理: ctx } });
  check('当天缓存只显示时分', /缓存于 \d{2}:\d{2}/.test(r[0].json.body.text), r[0].json.body.text.split('\n')[0]);

  const old = { ...ctx, cachedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 };
  const r2 = await runNode('渲染键盘', { input: old, nodes: { 预处理: old } });
  check('跨天缓存带日期', /缓存于 \d+月\d+日 \d{2}:\d{2}/.test(r2[0].json.body.text), r2[0].json.body.text.split('\n')[0]);
}

// ============ 12. 兜底只发一次 ============
console.log('=== 兜底判断 ===');
{
  const rich = { kind: 'rich', fallback: 'FB' };
  const ok = await runNode('准备兜底文本', {
    input: rich, nodes: { 发送富消息: { ok: true }, 预处理: { tgBase: TG, chatId: CHAT } },
  });
  check('富消息成功 → 不发兜底', ok.length === 0, 'length=' + ok.length);

  const bad = await runNode('准备兜底文本', {
    input: rich, nodes: { 发送富消息: { ok: false, description: 'Bad Request' }, 预处理: { tgBase: TG, chatId: CHAT } },
  });
  check('富消息失败 → 发兜底', bad.length === 1 && bad[0].json.body.text === 'FB');

  const netErr = await runNode('准备兜底文本', {
    input: rich, nodes: { 发送富消息: {}, 预处理: { tgBase: TG, chatId: CHAT } },
  });
  check('网络错误（无 ok）→ 发兜底', netErr.length === 1);

  // 关键：ack item（kind='ack'）不该触发兜底
  const ackItem = await runNode('准备兜底文本', {
    input: { kind: 'ack', url: 'x' }, nodes: { 发送富消息: { ok: true }, 预处理: { tgBase: TG, chatId: CHAT } },
  });
  check('ack item 不触发兜底', ackItem.length === 0, 'length=' + ackItem.length);
}

// ============ 13. 格式化结果：仍产出 rich + ack 两个 item ============
console.log('=== 格式化结果 ===');
{
  const payload = { status: 'running', taskId: 't1' };
  const r = await runNode('格式化结果', {
    input: payload,
    nodes: { 预处理: { tgBase: TG, chatId: CHAT, callbackQueryId: 'cb9' }, 发起探测: payload },
  });
  check('第 1 个是 rich', r[0].json.kind === 'rich');
  check('第 2 个是 ack', r[1]?.json.kind === 'ack');
  check('总共 2 个 item', r.length === 2, 'length=' + r.length);
}

console.log();
console.log(fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
