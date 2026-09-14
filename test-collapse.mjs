/*
 * test-collapse.mjs — 输入框「分工」药丸折叠行为的回归测试
 *
 * 不依赖浏览器/React/jsdom：用一个极小的 React Hooks 运行时 + 假 DOM，
 * 把 client.js 真正加载起来（window.__ModuleLoader__ + require('react') 桩），
 * 取出 conversation.input.left 槽位里的 ModeChip 组件，直接渲染并断言。
 *
 * 覆盖：
 *   1. 宽容器 → 展开药丸（"分工 关" / "分工 开"）
 *   2. 窄容器 → 折叠成圆形图标按钮（28px、mdisp-chip-compact）
 *   3. 开启/关闭两态沿用 .mdisp-chip.on 配色，图标用 currentColor 继承文字颜色
 *   4. 宽度变化后实时切换（ResizeObserver 观察 CSS 尺寸容器）
 *   5. 无 ResizeObserver 时退回 window resize 事件
 *   6. 找不到 CSS 尺寸容器时退回父元素宽度
 *   7. 折叠态下预设按钮的有无
 *   8. 样式表注入
 *
 * 运行：node test-collapse.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, 'client.js');

// ---------------------------------------------------------------- mini React
function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2);
  const p = Object.assign({}, props || {});
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  return { type, props: p };
}

function createRuntime({ layoutEffects = true } = {}) {
  const hooks = [];
  let cursor = 0;

  const React = { createElement };
  React.useState = function (init) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
    return [hooks[i], function (v) {
      const next = typeof v === 'function' ? v(hooks[i]) : v;
      if (Object.is(next, hooks[i])) return; // 与 React 一致：同值 bail out
      hooks[i] = next;
    }];
  };
  React.useRef = function (init) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = { current: init };
    return hooks[i];
  };
  const runEffectHook = function (fn, deps) {
    const i = cursor++;
    const prev = hooks[i];
    const changed = !prev || !prev.deps || !deps || prev.deps.length !== deps.length
      || deps.some((d, k) => !Object.is(d, prev.deps[k]));
    if (!changed) return;
    if (prev && typeof prev.cleanup === 'function') prev.cleanup();
    const entry = { deps, cleanup: null, fn };
    hooks[i] = entry;
    pending.push(entry);
  };
  if (layoutEffects) React.useLayoutEffect = runEffectHook;
  React.useEffect = runEffectHook;

  let pending = [];

  // 与 React 一致：先提交（挂 ref）再跑 effect，否则 effect 里读到的 ref.current 是 null。
  function render(component, props, onCommit) {
    cursor = 0;
    pending = [];
    const tree = component(props);
    if (typeof onCommit === 'function') onCommit(tree);
    for (const entry of pending) {
      const cleanup = entry.fn();
      entry.cleanup = typeof cleanup === 'function' ? cleanup : null;
    }
    return tree;
  }

  return { React, render };
}

// -------------------------------------------------------------- 元素树遍历
// 展开函数组件，得到扁平的真实宿主元素列表（文档序）。
function expand(node) {
  const out = [];
  (function rec(n) {
    if (n === null || n === undefined || typeof n === 'boolean') return;
    if (Array.isArray(n)) { for (const c of n) rec(c); return; }
    if (typeof n === 'string' || typeof n === 'number') return;
    if (typeof n.type === 'function') { rec(n.type(n.props)); return; }
    out.push(n);
    rec(n.props && n.props.children);
  })(node);
  return out;
}

const buttons = (tree) => expand(tree).filter((el) => el.type === 'button');
const classOf = (el) => String((el.props && el.props.className) || '');
function textOf(el) {
  const kids = el.props && el.props.children;
  if (typeof kids === 'string') return kids;
  if (Array.isArray(kids)) return kids.filter((k) => typeof k === 'string').join('');
  return '';
}

// ------------------------------------------------------------------- 假 DOM
function makeEl(name, width) {
  return {
    name,
    clientWidth: width || 0,
    parentElement: null,
    getBoundingClientRect() { return { width: this.clientWidth }; },
  };
}

function makeEnv({ width = 900, containerKind = 'inline-size', withResizeObserver = true } = {}) {
  const container = makeEl('composer-row', width);
  container.__containerType = containerKind;
  const tools = makeEl('tools', 0);
  const slotHost = makeEl('slot-host', 0);
  tools.parentElement = container;
  slotHost.parentElement = tools;

  const observers = [];
  const listeners = {};

  const win = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    getComputedStyle(el) { return { containerType: (el && el.__containerType) || 'normal' }; },
  };
  if (withResizeObserver) {
    win.ResizeObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe(el) { this.el = el; }
      disconnect() { this.disconnected = true; }
    };
  }

  const styleTags = [];
  const doc = {
    getElementById(id) { return styleTags.find((s) => s.id === id) || null; },
    createElement(tag) { return { tag, id: '', textContent: '' }; },
    head: { appendChild(node) { styleTags.push(node); } },
  };

  function resizeTo(next) {
    container.clientWidth = next;
    for (const ob of observers) if (!ob.disconnected && ob.el === container) ob.cb([]);
    for (const fn of listeners.resize || []) fn();
  }

  return { win, doc, container, tools, slotHost, styleTags, observers, listeners, resizeTo };
}

// 把树里的 ref 挂到假 DOM 节点上（模拟 React 的 commit 阶段）
function commitRefs(tree, parentEl) {
  (function rec(node, parent) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) { for (const c of node) rec(c, parent); return; }
    if (typeof node !== 'object' || typeof node.type === 'function') return;
    const el = makeEl(node.type, 0);
    el.parentElement = parent;
    if (node.props && node.props.ref && typeof node.props.ref === 'object') node.props.ref.current = el;
    rec(node.props && node.props.children, el);
  })(tree, parentEl);
}

// ------------------------------------------------------------- 加载 client.js
function loadModule(React, env) {
  const source = fs.readFileSync(CLIENT, 'utf8');
  let captured = null;
  const win = Object.assign({}, env.win, {
    __ModuleLoader__: { load(mod) { captured = mod; } },
  });

  const factory = new Function('window', 'document', 'require', 'fetch', 'setTimeout', 'ResizeObserver',
    source + '\n;return window.__ModuleLoader__;');
  factory(win, env.doc, (id) => {
    if (id === 'react') return React;
    throw new Error('unexpected require: ' + id);
  }, env.fetchStub, setTimeout, env.win.ResizeObserver);

  if (!captured) throw new Error('client.js 未调用 window.__ModuleLoader__.load');

  const slots = { injected: {}, registered: [] };
  const ctx = {
    get(name) {
      if (name !== 'slots') return undefined;
      return {
        inject(slot, cb) { slots.injected[slot] = cb; },
        register(meta, renderFn) { slots.registered.push({ meta, renderFn }); return () => {}; },
      };
    },
  };
  const mod = captured.factory((id) => (id === 'react' ? React : (() => { throw new Error(id); })()));
  mod.apply(ctx, {});
  return slots;
}

function modeChipFrom(slots) {
  const inj = slots.injected['conversation.input.left'];
  if (!inj) throw new Error('未注册 conversation.input.left 槽位');
  inj();
  const entry = slots.registered.find((r) => r.meta.name === 'conversation.input.left');
  if (!entry) throw new Error('未注册 ModeChip');
  return entry.renderFn({}).type;
}

// --------------------------------------------------------------------- 测试
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✔ ' + label); }
  else { fail++; console.log('  ✘ ' + label); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function statePayload({ mode = false, presets = [] } = {}) {
  return {
    mode,
    config: {
      enabled: false, presets, activePreset: presets[0] ? presets[0].id : '',
      routes: [], maxParallel: 4, askWhenAmbiguous: true,
    },
    catalog: [],
    diagnostics: [],
  };
}

async function renderChip({ width, mode = false, presets = [], withResizeObserver = true, containerKind = 'inline-size', env: presetEnv, layoutEffects = true } = {}) {
  const env = presetEnv || makeEnv({ width, withResizeObserver, containerKind });
  env.fetchStub = () => Promise.resolve({ json: () => Promise.resolve(statePayload({ mode, presets })) });

  const rt = createRuntime({ layoutEffects });
  const slots = loadModule(rt.React, env);
  const ModeChip = modeChipFrom(slots);
  const props = { session: { id: 'sess-1' } };

  let tree = null;
  const commit = (t) => commitRefs(t, env.slotHost);
  for (let i = 0; i < 6; i++) {
    tree = rt.render(ModeChip, props, commit);
    await tick();
  }
  tree = rt.render(ModeChip, props, commit);

  return {
    tree, env,
    rerender() {
      return rt.render(ModeChip, props, commit);
    },
  };
}

console.log('\n[1] 宽容器 → 展开为文字药丸');
{
  const { tree } = await renderChip({ width: 900, mode: false, presets: [{ id: 'p1', name: '便宜日常' }] });
  const btns = buttons(tree);
  ok(btns.length === 2, '渲染出两枚按钮（开关 + 预设），实际 ' + btns.length);
  ok(textOf(btns[0]) === '分工 关', '开关文案为「分工 关」：' + JSON.stringify(textOf(btns[0])));
  ok(!classOf(btns[0]).includes('mdisp-chip-compact'), '展开态不带 mdisp-chip-compact');
  ok(classOf(btns[0]).includes('mdisp-chip') && !classOf(btns[0]).includes('on'), '展开态关闭：普通配色（无 .on）');
}

console.log('\n[2] 窄容器 → 折叠为圆形图标按钮');
{
  const { tree } = await renderChip({ width: 300, mode: false, presets: [{ id: 'p1', name: '便宜日常' }] });
  const btns = buttons(tree);
  ok(btns.length === 2, '折叠后开关 + 预设两枚按钮');
  const toggle = btns[0];
  ok(classOf(toggle).includes('mdisp-chip-compact'), '开关按钮带 mdisp-chip-compact（圆形）');
  ok(textOf(toggle) === '', '折叠态不再显示文字');
  ok(String(toggle.props.title).includes('模型分工'), '折叠态保留 title 提示');
  ok(toggle.props['aria-label'] === '模型分工：已关闭', '折叠态 aria-label 表明状态：' + toggle.props['aria-label']);
  ok(toggle.props['aria-pressed'] === 'false', '关闭态 aria-pressed=false');
  const nodes = expand(toggle);
  const svg = nodes.find((el) => el.type === 'svg');
  ok(!!svg, '折叠态按钮内含 svg 图标');
  const circles = nodes.filter((el) => el.type === 'circle');
  const paths = nodes.filter((el) => el.type === 'path');
  ok(circles.length === 3 && paths.length === 3, '图标为「一进多出」分派图形（3 圆点 + 3 连线）');
  ok(paths.every((p) => p.props.stroke === 'currentColor'), '连线用 currentColor（继承文字颜色）');
  ok(circles.every((c) => c.props.fill === 'currentColor'), '圆点用 currentColor（继承文字颜色）');
}

console.log('\n[3] 开启态沿用 .mdisp-chip.on 配色');
{
  const wide = await renderChip({ width: 900, mode: true, presets: [{ id: 'p1', name: '便宜日常' }] });
  ok(textOf(buttons(wide.tree)[0]) === '分工 开', '展开开启：文案「分工 开」');
  ok(classOf(buttons(wide.tree)[0]).includes('on'), '展开开启：带 .on');

  const narrow = await renderChip({ width: 280, mode: true, presets: [{ id: 'p1', name: '便宜日常' }] });
  const toggle = buttons(narrow.tree)[0];
  ok(classOf(toggle).includes('mdisp-chip-compact') && classOf(toggle).includes('on'), '折叠开启：圆形 + .on');
  ok(toggle.props['aria-pressed'] === 'true', '开启态 aria-pressed=true');
  ok(toggle.props['aria-label'] === '模型分工：已开启', '开启态 aria-label：' + toggle.props['aria-label']);
}

console.log('\n[4] 宽度变化实时折叠/展开（ResizeObserver）');
{
  const env = makeEnv({ width: 900 });
  const first = await renderChip({ env, mode: false, presets: [] });
  ok(!classOf(buttons(first.tree)[0]).includes('mdisp-chip-compact'), '初始宽容器：展开');
  ok(env.observers.length === 1, '创建了 1 个 ResizeObserver');
  ok(env.observers[0].el === env.container, 'ResizeObserver 观察的是 CSS 尺寸容器（不是自身）');

  env.resizeTo(320);
  let tree = first.rerender();
  ok(classOf(buttons(tree)[0]).includes('mdisp-chip-compact'), '容器变窄 320px → 折叠');

  env.resizeTo(900);
  tree = first.rerender();
  ok(!classOf(buttons(tree)[0]).includes('mdisp-chip-compact'), '容器变宽 900px → 重新展开');
}

console.log('\n[5] 无 ResizeObserver 时退回 window resize 事件');
{
  const env = makeEnv({ width: 300, withResizeObserver: false });
  const { tree } = await renderChip({ env, mode: false, presets: [] });
  ok(env.observers.length === 0, '确实没有创建 ResizeObserver');
  ok((env.listeners.resize || []).length === 1, '注册了 window resize 监听');
  ok(classOf(buttons(tree)[0]).includes('mdisp-chip-compact'), '窄容器：仍能折叠');

  env.resizeTo(900);
  const after = await renderChip({ env, mode: false, presets: [] });
  ok(!classOf(buttons(after.tree)[0]).includes('mdisp-chip-compact'), '变宽后经 resize 事件重新展开');
}

console.log('\n[6] 无 CSS 尺寸容器时退回父元素宽度');
{
  const env = makeEnv({ width: 300, containerKind: 'normal' });
  env.tools.clientWidth = 300;
  const { tree } = await renderChip({ env, mode: false, presets: [] });
  ok(classOf(buttons(tree)[0]).includes('mdisp-chip-compact'), '父元素窄 → 折叠');
}

console.log('\n[7] 折叠态下的预设按钮');
{
  const withPreset = await renderChip({ width: 300, mode: false, presets: [{ id: 'p1', name: '强力攻坚' }] });
  const btns = buttons(withPreset.tree);
  ok(btns.length === 2, '有预设时折叠态渲染两枚圆形按钮，实际 ' + btns.length);
  ok(classOf(btns[1]).includes('mdisp-chip-compact'), '预设按钮同样是圆形');
  ok(String(btns[1].props['aria-label']).includes('强力攻坚'), '预设按钮 aria-label 带当前预设名');
  ok(btns[1].props.disabled === false, '有预设时预设按钮可点');

  const noPreset = await renderChip({ width: 300, mode: false, presets: [] });
  const only = buttons(noPreset.tree);
  ok(only.length === 1, '无预设时折叠态只有一枚按钮，实际 ' + only.length);
}

console.log('\n[8] 没有 useLayoutEffect 时退回 useEffect（老版本 React / 测试环境）');
{
  const env = makeEnv({ width: 300 });
  const { tree } = await renderChip({ env, mode: false, presets: [], layoutEffects: false });
  ok(classOf(buttons(tree)[0]).includes('mdisp-chip-compact'), 'useEffect 路径同样能折叠');

  const wide = makeEnv({ width: 900 });
  const r = await renderChip({ env: wide, mode: false, presets: [], layoutEffects: false });
  ok(!classOf(buttons(r.tree)[0]).includes('mdisp-chip-compact'), 'useEffect 路径宽容器保持展开');
}

console.log('\n[9] 样式表注入');{
  const env = makeEnv({ width: 900 });
  await renderChip({ env, mode: false, presets: [] });
  const css = env.styleTags.map((s) => s.textContent).join('\n');
  ok(env.styleTags.length === 1, '注入且只注入一份样式表');
  ok(css.includes('.mdisp-chip.mdisp-chip-compact{border-radius:999px;width:28px;height:28px'),
    '折叠态为 28px 圆形（与 DSH 输入框圆形按钮同尺寸）');
  ok(css.includes('.mdisp-chip.mdisp-chip-icon svg{width:16px;height:16px'),
    '图标尺寸 16px');
  ok(css.includes('.mdisp-chip.on{background:var(--dsw-alias-brand-primary'),
    '开启配色仍为 brand-primary（与原来一致）');
  ok(css.includes('.mdisp-chip{') && css.includes('--dsw-alias-bg-layer-2'),
    '关闭配色仍为原底色（与原来一致）');
  ok(!css.includes('@container'), '不残留未生效的死容器查询规则');
}

console.log('\n结果：' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exitCode = 1;
