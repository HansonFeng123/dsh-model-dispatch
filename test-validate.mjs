// 验证 index.js 里的 validateConfig：直接从源文件提取函数本体来跑，避免复制造成的偏差。
// 运行：node model-dispatch/test-validate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'index.js'), 'utf8');

// 按大括号配对，从真实源码里抠出 validateConfig 的完整定义
function extractFunction(text, signature) {
  const start = text.indexOf(signature);
  if (start === -1) throw new Error('未找到函数：' + signature);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('函数体不闭合：' + signature);
}

const src = extractFunction(source, 'function validateConfig(next, catalog)');
const DIFFICULTIES = ['high', 'medium', 'low'];
const validateConfig = new Function('DIFFICULTIES', src + '\nreturn validateConfig;')(DIFFICULTIES);

// 夹具 = 探针实测到的真实目录（5 provider / 56 模型，这里取其中两个代表）
const catalog = [
  { provider: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
  { provider: 'commandcode', name: 'Command Code', models: [{ id: 'meituan/LongCat-2.0:free' }, { id: 'deepseek/deepseek-v4-flash' }] },
];

const TASK_TYPES = ['architecture', 'coding', 'ui-design', 'bugfix', 'review', 'docs', 'testing', 'research'];
const base = () => ({
  enabled: true,
  askWhenAmbiguous: true,
  maxParallel: 4,
  taskTypes: TASK_TYPES.slice(),
  routes: [],
  fallback: { high: null, medium: null, low: null },
});

let failed = 0;
function check(name, mutate, expectThrow, expectMessagePart) {
  const cfg = base();
  mutate(cfg);
  let err = null;
  try {
    validateConfig(cfg, catalog);
  } catch (e) {
    err = e;
  }
  let ok;
  if (expectThrow) ok = err !== null && (!expectMessagePart || String(err.message).includes(expectMessagePart));
  else ok = err === null;
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) console.log('      期望' + (expectThrow ? '抛错(' + (expectMessagePart || '') + ')' : '通过') + '，实际：' + (err ? err.message : '未抛错'));
}

// 这次线上踩到的那个场景：回退 high 选了模型
check('回退 high 指向合法路由（本次故障场景）', (c) => { c.fallback.high = { provider: 'deepseek-official', model: 'deepseek-flash' }; }, false);
check('三档回退都合法', (c) => {
  c.fallback.high = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
  c.fallback.medium = { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' };
  c.fallback.low = { provider: 'commandcode', model: 'meituan/LongCat-2.0:free' };
}, false);
check('定点路由 + 回退 混合', (c) => {
  c.routes = [
    { type: 'architecture', difficulty: 'high', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    { type: 'coding', difficulty: 'low', provider: 'commandcode', model: 'meituan/LongCat-2.0:free' },
  ];
  c.fallback.medium = { provider: 'deepseek-official', model: 'deepseek-flash' };
}, false);
check('自定义任务类型 + 定点路由', (c) => {
  c.taskTypes.push('database');
  c.routes = [{ type: 'database', difficulty: 'high', provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' }];
}, false);
check('回退全空（未配置）', () => { }, false);

// 负例：这些必须被拦住
check('回退指向未录入 provider', (c) => { c.fallback.high = { provider: 'nope', model: 'x' }; }, true, '未录入的 provider');
check('回退指向该 provider 下不存在的模型', (c) => { c.fallback.medium = { provider: 'commandcode', model: '不存在' }; }, true, '没有模型');
check('回退缺 model', (c) => { c.fallback.low = { provider: 'deepseek-official', model: '' }; }, true, '缺少 model');
check('路由用未知任务类型', (c) => { c.routes = [{ type: 'zzz', difficulty: 'high', provider: 'deepseek-official', model: 'deepseek-flash' }]; }, true, '未知任务类型');
check('路由用未知难度', (c) => { c.routes = [{ type: 'coding', difficulty: 'ultra', provider: 'deepseek-official', model: 'deepseek-flash' }]; }, true, '未知难度');
check('taskTypes 为空', (c) => { c.taskTypes = []; }, true, '至少保留一个任务类型');

// ── 工具 schema 形状回归（本次 deepseek-v4.1-flash 故障） ──
// 故障现象："Invalid schema for function 'dispatch_task': schema must be a JSON Schema
// of 'type: "object"', got 'type: null'"。根因是 parameters 用了动态插件专有的
// 隐式属性映射 DSL（顶层没有 type/properties 包装），静态 tools.register() 不做规范化。
const assertSrc = extractFunction(source, 'function assertJsonObjectSchema(schema, label)');
const assertJsonObjectSchema = new Function(assertSrc + '\nreturn assertJsonObjectSchema;')();

function schemaCheck(name, schema, expectProblems) {
  const problems = assertJsonObjectSchema(schema, 'x');
  const ok = expectProblems ? problems.length > 0 : problems.length === 0;
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) console.log('      期望' + (expectProblems ? '报错' : '通过') + '，实际：' + (problems.length ? problems.join(' / ') : '无问题'));
}

// 正确的标准 JSON Schema（当前 index.js 用的形状）
schemaCheck('标准 JSON Schema 通过', {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string' }, difficulty: { type: 'string', enum: ['high', 'low'] } },
        required: ['title'],
      },
    },
  },
  required: ['tasks'],
}, false);

// 故障形状：隐式属性映射 DSL（顶层无 type/properties）
schemaCheck('隐式映射 DSL 必须被拦住（本次故障）', {
  tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } } } },
  note: { type: 'string' },
}, true);

schemaCheck('顶层 type 不是 object 必须被拦住', { type: 'array', items: { type: 'string' } }, true);
schemaCheck('required 不是数组必须被拦住', { type: 'object', properties: { a: { type: 'string' } }, required: true }, true);
schemaCheck('嵌套节点缺 type 必须被拦住', { type: 'object', properties: { a: { description: 'x' } } }, true);

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
