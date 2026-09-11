// dsh-model-dispatch — Host 半（静态插件入口）
//
// 与动态插件版的核心差异：
//   1. 配置持久化：通过 settings.register() 注册命名空间，重启不丢
//   2. 工具注册：用 tools.register() 替代 harness.defineTool + harness.registerTool
//   3. Client RPC：用 webServer.register() 注册 HTTP 路由替代 harness.handle
//
// 设置页、运行卡、输入框药丸均在 client.js 中通过 fetch 调用 HTTP 路由与宿主通信。

import z from '@deepseek-ai/schemastery'

export const name = 'model-dispatch'
export const inject = [
  'tools',        // 工具注册
  'llm',          // 模型目录
  'subagents',    // 子代理
  'systemPrompt', // 模式注入
  'commands',     // /mdisp 命令
  'userQuestions',// 歧义澄清
  'settings',     // 持久化配置
  'webServer',    // Client RPC HTTP 路由
]

export const Config = z.object({
  enabled: z.boolean().default(false),
  askWhenAmbiguous: z.boolean().default(true),
  maxParallel: z.number().step(1).min(1).max(8).default(4),
  taskTypes: z.array(z.string()).default([
    'architecture', 'coding', 'ui-design', 'bugfix', 'review', 'docs', 'testing', 'research',
  ]),
  routes: z.array(z.object({
    type: z.string(),
    difficulty: z.string(),
    provider: z.string(),
    model: z.string(),
  })).default([]),
  fallback: z.object({
    high: z.object({ provider: z.string(), model: z.string() }).optional(),
    medium: z.object({ provider: z.string(), model: z.string() }).optional(),
    low: z.object({ provider: z.string(), model: z.string() }).optional(),
  }).default({}),
})

const TASK_TYPES_DEFAULT = ['architecture', 'coding', 'ui-design', 'bugfix', 'review', 'docs', 'testing', 'research']
const DIFFICULTIES = ['high', 'medium', 'low']
const TYPE_LABELS = {
  architecture: '程序架构设计', coding: '程序编写', 'ui-design': 'UI 设计',
  bugfix: '纠错改正', review: '代码评审', docs: '文档编写',
  testing: '测试编写', research: '资料调研',
}
const DIFF_LABELS = { high: '高', medium: '中', low: '低' }

function errText(e) {
  if (!e) return '未知错误'
  if (typeof e === 'string') return e
  return e && e.message ? e.message : String(e)
}

function clip(text, n) {
  if (!text) return ''
  const s = String(text)
  return s.length <= n ? s : s.slice(0, n) + '…'
}

function normKey(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

function cleanRoute(f) {
  if (!f || typeof f !== 'object') return null
  if (typeof f.provider !== 'string' || !f.provider) return null
  return { provider: f.provider, model: typeof f.model === 'string' ? f.model : '' }
}

function resolveRoute(config, type, difficulty) {
  const routes = Array.isArray(config.routes) ? config.routes : []
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i]
    if (r && r.type === type && r.difficulty === difficulty && typeof r.provider === 'string' && r.provider) {
      return { provider: r.provider, model: typeof r.model === 'string' ? r.model : '' }
    }
  }
  const f = config.fallback ? config.fallback[difficulty] : null
  if (f && typeof f.provider === 'string' && f.provider) return { provider: f.provider, model: typeof f.model === 'string' ? f.model : '' }
  return null
}

function classifyTask(config, t) {
  const text = ((t.title || '') + ' ' + (t.description || '')).toLowerCase()
  let type = t.type
  const taskTypes = Array.isArray(config.taskTypes) ? config.taskTypes : TASK_TYPES_DEFAULT
  if (typeof type !== 'string' || taskTypes.indexOf(type) === -1) {
    if (/架构|总体设计|方案设计|模块划分|接口设计|数据模型|技术选型|architecture|blueprint/.test(text)) type = 'architecture'
    else if (/ui|界面|样式|css|布局|视觉|前端页面|组件|figma|设计稿|页面设计/.test(text)) type = 'ui-design'
    else if (/bug|报错|异常|崩溃|修复|纠错|调试|fix|debug|error|failure/.test(text)) type = 'bugfix'
    else if (/评审|审查|审计|review|检查代码|code review/.test(text)) type = 'review'
    else if (/文档|说明|注释|readme|docs|文档编写/.test(text)) type = 'docs'
    else if (/测试|单测|用例|test|覆盖|test case/.test(text)) type = 'testing'
    else if (/调研|研究|比较|调查|选型对比|research|survey/.test(text)) type = 'research'
    else type = 'coding'
  }
  let difficulty = t.difficulty
  if (DIFFICULTIES.indexOf(difficulty) === -1) {
    if (/重构|架构|安全|并发|性能|迁移|分布式|数据库|系统设计|大规模|核心|refactor|security|performance|migrat/.test(text)) difficulty = 'high'
    else if (/typo|文案|注释|格式|重命名|微调|简单|小修|format|rename|comment/.test(text) || (t.description || '').trim().length < 40) difficulty = 'low'
    else difficulty = 'medium'
  }
  return { type, difficulty }
}

function ambiguityScore(t, description) {
  const d = (description || '').trim()
  let score = 0
  if (d.length < 25) score += 2
  if (/？|\?|还是|或者|不确定|也许|可能|大概|看着办|你决定|whatever|not sure|maybe|or something/.test(d)) score += 2
  if (t.needsClarification === true) score += 3
  if ((typeof t.type !== 'string' || !t.type) && (typeof t.difficulty !== 'string' || !t.difficulty) && d.length < 60) score += 1
  return score
}

function normalizeTask(config, t, index) {
  const title = t && typeof t.title === 'string' && t.title.trim() ? t.title.trim() : '任务' + (index + 1)
  const description = t && typeof t.description === 'string' ? t.description.trim() : ''
  const context = t && typeof t.context === 'string' ? t.context.trim() : ''
  const c = classifyTask(config, t || {})
  const ambiguity = ambiguityScore(t || {}, description)
  const key = normKey(title) + '|' + normKey(description)
  return {
    title: clip(title, 120),
    description: clip(description, 4000),
    context: clip(context, 2000),
    type: c.type,
    difficulty: c.difficulty,
    ambiguity,
    key,
    needsClarification: !!(t && t.needsClarification),
    merged: 1,
    skipped: false,
    note: '',
    route: null,
  }
}

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let idx = 0
  const workers = []
  const n = Math.max(1, Math.min(limit, items.length))
  for (let i = 0; i < n; i++) {
    workers.push((async function () {
      while (true) {
        const my = idx++
        if (my >= items.length) return
        try { results[my] = await worker(items[my]) }
        catch (e) { results[my] = { status: 'error', note: errText(e) } }
      }
    })())
  }
  await Promise.all(workers)
  return results
}

function buildChildPrompt(u) {
  const lines = []
  lines.push('你是专项执行代理，负责完成一个已拆分的子任务。请专注完成本任务，不要重新规划全局，不要再派发子任务。')
  lines.push('')
  lines.push('任务类型：' + (TYPE_LABELS[u.type] || u.type) + '（' + u.type + '）    难度：' + (DIFF_LABELS[u.difficulty] || u.difficulty))
  lines.push('标题：' + u.title)
  lines.push('描述：')
  lines.push(u.description || '（无）')
  if (u.context) {
    lines.push('背景/上下文：')
    lines.push(u.context)
  }
  lines.push('')
  lines.push('输出要求（严格遵守，节省主会话 token）：')
  lines.push('- 直接执行任务；涉及代码或文件修改时，直接修改工作区文件。')
  lines.push('- 最终回复用紧凑结构化文本：结论 / 改动与产出文件清单 / 关键决策 / 未尽事项，总计不超过 300 字。')
  lines.push('- 不要复述任务原文，不要粘贴大段代码或日志。')
  return lines.join('\n')
}

function pickProvider(subagents) {
  let names = []
  try { names = subagents.list() } catch (e) { names = [] }
  if (!Array.isArray(names) || !names.length) return null
  let chosen = null
  for (let i = 0; i < names.length; i++) {
    const n = names[i]
    let p = null
    try { p = typeof subagents.getProvider === 'function' ? subagents.getProvider(n) : null } catch (e) { p = null }
    if (!p) continue
    const caps = p.capabilities || {}
    if (caps.agentOptions === false) continue
    if (n === 'spawn') { chosen = p; break }
    if (!chosen) chosen = p
  }
  if (chosen) return chosen
  try { return subagents.getProvider ? subagents.getProvider(names[0]) : { name: names[0], capabilities: {} } }
  catch (e) { return { name: names[0], capabilities: {} } }
}

async function runOne(subagents, providerName, caps, u, exec) {
  const request = {
    label: 'mdisp·' + clip(u.title, 40),
    prompt: [{ type: 'text', text: buildChildPrompt(u) }],
    parent: exec.agent,
    signal: exec.signal,
  }
  if (u.route && caps.agentOptions !== false) {
    request.agentOptions = { provider: u.route.provider, model: u.route.model }
  }
  let run
  try {
    run = await subagents.start(providerName, request)
  } catch (e) {
    u.status = 'error'
    u.note = '启动子代理失败：' + errText(e)
    return u
  }
  try {
    const result = await run.result
    const text = textOf(result.output)
    u.status = result.stopReason === 'completed' ? 'done' : 'stopped:' + result.stopReason
    u.summary = clip(text, 2000)
    u.childId = typeof run.id === 'string' ? run.id : ''
    if (result.diagnostic) u.note = '子代理诊断：' + clip(result.diagnostic, 300)
  } catch (e) {
    u.status = 'error'
    u.note = '等待子代理结果失败：' + errText(e)
  } finally {
    try { if (run && typeof run.dispose === 'function') await run.dispose() } catch (e2) { /* 幂等释放 */ }
  }
  return u
}

async function tryAsk(exec, ambiguous) {
  const uq = exec.ctx.get('userQuestions')
  if (uq === undefined || typeof uq.ask !== 'function') return null
  const picked = ambiguous.slice(0, 4)
  const questions = []
  for (let i = 0; i < picked.length; i++) {
    const u = picked[i]
    questions.push({
      id: 'task-' + u.key,
      question: '任务「' + clip(u.title, 60) + '」信息较少或有歧义，如何处理？',
      detail: clip(u.description, 300),
      header: '模型分工',
      options: [
        { label: '按当前理解继续', description: '直接派发给评估出的模型' },
        { label: '本轮先跳过', description: '不派发，交回主会话补充信息' },
      ],
    })
  }
  try {
    const answer = await uq.ask({ questions, agent: exec.agent, signal: exec.signal })
    const map = {}
    const list = answer && Array.isArray(answer.answers) ? answer.answers : []
    for (let j = 0; j < list.length; j++) map[list[j].id] = list[j]
    return map
  } catch (e) {
    return null
  }
}

async function buildCatalog(llm, settings) {
  const diag = []
  const providerMap = new Map()

  function addProvider(id, name) {
    if (typeof id !== 'string' || !id) return
    if (!providerMap.has(id)) providerMap.set(id, { provider: id, name: name || id, models: [] })
    else if (name && providerMap.get(id).name === id) providerMap.get(id).name = name
  }
  function pushModel(entry, id, name) {
    if (typeof id !== 'string' || !id) return
    if (entry.models.some((m) => m.id === id)) return
    entry.models.push({ id, name: name || id })
  }
  function harvest(ns, value) {
    if (!value || typeof value !== 'object') return
    const ps = value.providers
    if (!ps || typeof ps !== 'object' || Array.isArray(ps)) return
    const keys = Object.keys(ps)
    if (!keys.length) return
    diag.push('settings(' + ns + ').providers: ' + keys.length + ' 个')
    for (let i = 0; i < keys.length; i++) {
      addProvider(keys[i], keys[i])
      const prof = ps[keys[i]]
      const entry = providerMap.get(keys[i])
      if (!prof || typeof prof !== 'object' || !entry) continue
      const list = prof.models
      if (Array.isArray(list)) {
        for (let j = 0; j < list.length; j++) {
          const mm = list[j]
          const mid = typeof mm === 'string' ? mm : (mm && (mm.id || mm.model || mm.name))
          pushModel(entry, mid, typeof mm === 'object' && mm ? (mm.name || mid) : mid)
        }
      }
    }
  }

  diag.push('llm 服务: ' + (llm === undefined ? '不可用' : '可用'))
  if (llm !== undefined) {
    try {
      const list = llm.listProviders()
      diag.push('listProviders(): ' + (Array.isArray(list) ? list.length : '非数组') + ' 个')
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) { if (list[i]) addProvider(list[i].id, list[i].name) }
      }
    } catch (e) { diag.push('listProviders 失败: ' + errText(e)) }
    try {
      const dir = typeof llm.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : []
      diag.push('listConfigurableProviders(): ' + (Array.isArray(dir) ? dir.length : '非数组') + ' 个（出厂目录，不入选）')
    } catch (e) { diag.push('listConfigurableProviders 失败: ' + errText(e)) }
  }

  if (settings === undefined) {
    diag.push('settings 服务: 不可用')
  } else {
    try {
      if (typeof settings.get === 'function') {
        const known = ['llm-pi-ai', 'llm-deepseek', 'llm']
        for (let s = 0; s < known.length; s++) {
          try { harvest(known[s], settings.get(known[s])) } catch (e) { /* 该命名空间未注册 */ }
        }
      }
      if (typeof settings.describe === 'function') {
        const desc = settings.describe()
        const items = Array.isArray(desc) ? desc : (desc && Array.isArray(desc.namespaces) ? desc.namespaces : [])
        diag.push('settings.describe(): ' + items.length + ' 个命名空间')
        for (let d = 0; d < items.length; d++) {
          const it = items[d]
          if (it && typeof it.ns === 'string') {
            try { harvest(it.ns, it.value) } catch (e) { /* 单个命名空间失败不影响整体 */ }
          }
        }
      }
    } catch (e) { diag.push('settings 读取失败: ' + errText(e)) }
  }

  const ids = Array.from(providerMap.keys())
  let withModels = 0
  for (let n = 0; n < ids.length; n++) {
    const entry2 = providerMap.get(ids[n])
    if (entry2.models.length) { withModels++; continue }
    if (llm === undefined) continue
    try {
      const ms = await llm.listModels(entry2.provider)
      if (Array.isArray(ms)) {
        for (let q = 0; q < ms.length; q++) {
          const mo = ms[q]
          if (mo && typeof mo.id === 'string') pushModel(entry2, mo.id, typeof mo.name === 'string' ? mo.name : mo.id)
        }
      }
      if (entry2.models.length) withModels++
      else diag.push('listModels(' + entry2.provider + '): 0 个模型')
    } catch (e) { diag.push('listModels(' + entry2.provider + ') 失败: ' + errText(e)) }
  }

  const all = Array.from(providerMap.values())
  const kept = []
  const dropped = []
  for (let z = 0; z < all.length; z++) {
    if (all[z].models.length) kept.push(all[z])
    else dropped.push(all[z].provider)
  }
  let totalModels = 0
  for (let z2 = 0; z2 < kept.length; z2++) totalModels += kept[z2].models.length
  diag.push('汇总: 候选 ' + all.length + ' 个 → 可选 ' + kept.length + ' 个（共 ' + totalModels + ' 个模型）' +
    (dropped.length ? '，剔除无模型: ' + dropped.join(',') : ''))
  return { catalog: kept, diagnostics: diag }
}

function validateConfig(next, catalog) {
  if (!next || typeof next !== 'object') throw new Error('配置格式错误')
  if (!Array.isArray(next.taskTypes) || !next.taskTypes.length) throw new Error('至少保留一个任务类型')
  const taskTypes = next.taskTypes.map((t) => String(t).trim())
  const providerMap = new Map()
  for (let i = 0; i < catalog.length; i++) providerMap.set(catalog[i].provider, catalog[i])
  function checkProviderModel(provider, model, where) {
    if (typeof provider !== 'string' || !provider) return
    const entry = providerMap.get(provider)
    if (!entry) throw new Error(where + '：未录入的 provider ' + provider)
    if (typeof model !== 'string' || !model) throw new Error(where + '：缺少 model（' + provider + '）')
    if (entry.models.length && !entry.models.some((m) => m.id === model)) {
      throw new Error(where + '：provider ' + provider + ' 下没有模型 ' + model)
    }
  }
  function checkRoute(r, where) {
    if (!r || typeof r !== 'object') return
    if (taskTypes.indexOf(r.type) === -1) throw new Error(where + '：未知任务类型 ' + r.type)
    if (DIFFICULTIES.indexOf(r.difficulty) === -1) throw new Error(where + '：未知难度 ' + r.difficulty)
    checkProviderModel(r.provider, r.model, where)
  }
  const routes = Array.isArray(next.routes) ? next.routes : []
  for (let j = 0; j < routes.length; j++) checkRoute(routes[j], '路由')
  const fb = next.fallback || {}
  for (let k = 0; k < DIFFICULTIES.length; k++) {
    const d = DIFFICULTIES[k]
    if (fb[d] && typeof fb[d] === 'object') checkProviderModel(fb[d].provider, fb[d].model, '回退(' + d + ')')
  }
}

// 会话级模式开关（/mdisp on|off），未覆盖时取 config.enabled
const sessionModes = new Map()

function modeFor(config, sessionId) {
  if (sessionId !== undefined && sessionModes.has(sessionId)) return sessionModes.get(sessionId)
  return config.enabled
}

function routeTableText(config) {
  const lines = []
  const taskTypes = Array.isArray(config.taskTypes) ? config.taskTypes : TASK_TYPES_DEFAULT
  for (let i = 0; i < taskTypes.length; i++) {
    const t = taskTypes[i]
    for (let j = 0; j < DIFFICULTIES.length; j++) {
      const d = DIFFICULTIES[j]
      const r = resolveRoute(config, t, d)
      if (r) lines.push('  - ' + t + ' × ' + d + ' → ' + r.provider + ' / ' + r.model)
    }
  }
  const fb = DIFFICULTIES.map((d) => {
    const f = config.fallback ? config.fallback[d] : null
    return f && f.provider ? d + '→' + f.provider + '/' + f.model : d + '→继承'
  }).join('，')
  lines.push('  - 未定点类型回退：' + fb)
  return lines.join('\n')
}

function buildPolicyText(config) {
  const taskTypes = Array.isArray(config.taskTypes) ? config.taskTypes : TASK_TYPES_DEFAULT
  const types = taskTypes.map((t) => t + '（' + (TYPE_LABELS[t] || '自定义') + '）').join('、')
  const lines = []
  lines.push('【模型分工模式已启用】')
  lines.push('- 把可独立完成的子任务交给 dispatch_task 派发：先评估类型与难度（type × difficulty），工具会按用户配置把任务路由到对应模型并 spawn 子代理执行。')
  lines.push('- 任务类型：' + types + '；难度：high（高）/ medium（中）/ low（低）。无法判断时省略字段，由工具启发式分类。')
  lines.push('- 互相独立、可并行的子任务放进同一次 dispatch_task 调用（tasks 数组）；重复或同质的任务只保留一个。')
  lines.push('- 复杂或有歧义的任务：先思考理解；仍不确定时先用 ask_user_question 向用户确认关键决策，再做架构设计，最后再派发编码实现。')
  lines.push('- 架构设计类任务应先产出方案要点（写明模块边界与接口约定），编码任务引用该方案，不要把架构决策留给编码代理。')
  lines.push('- 派发的 description 要写清目标/约束/涉及文件；context 只给必要背景；要求子代理返回精简结构化结果。')
  lines.push('- 琐碎步骤（单文件小改动、一句话问答）不要派发，直接自己做更省 token。')
  lines.push('- 当前模型路由（type × difficulty → provider/model）：')
  lines.push(routeTableText(config))
  lines.push('- 用户可用 /mdisp on|off 切换本会话模式；模型矩阵在 设置 → 模型分工 中配置。')
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  // ── 1. 持久化配置：注册 settings 命名空间 ──
  const settings = ctx.get('settings')
  let settingsScope = null
  if (settings !== undefined && typeof settings.register === 'function') {
    try {
      settingsScope = settings.register('model-dispatch', Config, {
        base: {
          enabled: config.enabled ?? false,
          askWhenAmbiguous: config.askWhenAmbiguous ?? true,
          maxParallel: config.maxParallel ?? 4,
          taskTypes: config.taskTypes || TASK_TYPES_DEFAULT,
          routes: config.routes || [],
          fallback: config.fallback || {},
        },
      })
    } catch (e) {
      console.error('[model-dispatch] settings.register 失败: ' + errText(e))
    }
  }

  // 读取配置的优先顺序：settings 已保存值 > cordis.patch.yml config > 默认值
  function getConfig() {
    if (settingsScope) {
      try { return settingsScope.get() } catch (e) { /* fall through */ }
    }
    return {
      enabled: config.enabled ?? false,
      askWhenAmbiguous: config.askWhenAmbiguous ?? true,
      maxParallel: config.maxParallel ?? 4,
      taskTypes: config.taskTypes || TASK_TYPES_DEFAULT,
      routes: config.routes || [],
      fallback: config.fallback || {},
    }
  }

  const llm = ctx.get('llm')
  const subagents = ctx.get('subagents')

  // ── 2. 注册 dispatch_task 工具 ──
  const tools = ctx.get('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    tools.register({
      name: 'dispatch_task',
      description:
        '评估子任务的类型（architecture/coding/ui-design/bugfix/review/docs/testing/research 等）与难度（high/medium/low），' +
        '按用户在设置页配置的模型矩阵把任务路由到对应模型并 spawn 子代理执行。' +
        'tasks 数组可一次携带多个互相独立的任务（并行执行）；重复任务会自动合并；' +
        '信息不足或有歧义的任务（或置 needsClarification=true）会先向用户提问确认。' +
        '返回每个任务的模型、状态与精简结果摘要。琐碎步骤不要调用本工具。',
      parameters: {
        tasks: {
          type: 'array',
          required: true,
          description: '要派发的子任务列表；互相独立的任务放在同一次调用里并行执行',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', required: true, description: '任务短标题' },
              description: { type: 'string', required: true, description: '任务完整描述：目标、约束、涉及文件路径' },
              context: { type: 'string', description: '可选背景：架构方案要点、相关文件、接口约定等' },
              type: { type: 'string', description: '任务类型，省略则自动评估' },
              difficulty: { type: 'string', description: 'high/medium/low，省略则自动评估' },
              needsClarification: { type: 'boolean', description: '认为该任务信息不足、需要用户确认时置 true' },
            },
          },
        },
        note: { type: 'string', description: '给派发系统的补充说明' },
      },
      timeoutMs: 900000,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string' },
                  type: { type: 'string' },
                  difficulty: { type: 'string' },
                  status: { type: 'string' },
                  model: { type: 'string' },
                  summary: { type: 'string' },
                  childId: { type: 'string' },
                  note: { type: 'string' },
                },
              },
            },
            note: { type: 'string' },
          },
        },
        render(args, value) {
          const lines = []
          const results = value && Array.isArray(value.results) ? value.results : []
          if (!results.length) lines.push('dispatch_task：无结果')
          for (let i = 0; i < results.length; i++) {
            const r = results[i]
            lines.push('[' + r.status + '] ' + r.title + ' — ' + r.type + ' × ' + r.difficulty + ' · ' + r.model)
            if (r.note) lines.push('  备注: ' + r.note)
            if (r.summary) lines.push('  结果: ' + r.summary)
          }
          if (value && value.note) lines.push('总备注: ' + value.note)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        const cfg = getConfig()
        const tasks = args && Array.isArray(args.tasks) ? args.tasks : []
        if (!tasks.length) return { results: [], note: 'tasks 为空：请至少提供一个任务' }
        const agent = exec && exec.agent
        if (!agent) return { results: [], note: '无法确定调用方会话，拒绝派发' }
        if (subagents === undefined || typeof subagents.start !== 'function') {
          return { results: [], note: 'subagents 服务不可用，无法派发' }
        }
        const provider = pickProvider(subagents)
        if (!provider) return { results: [], note: '没有可用的 subagent provider' }
        const caps = provider.capabilities || {}

        // 1) 归一化 + 分类 + 去重
        const items = []
        for (let i = 0; i < tasks.length; i++) items.push(normalizeTask(cfg, tasks[i], i))
        const byKey = new Map()
        const uniq = []
        for (let j = 0; j < items.length; j++) {
          const it = items[j]
          if (byKey.has(it.key)) { byKey.get(it.key).merged += 1 }
          else { byKey.set(it.key, it); uniq.push(it) }
        }

        // 2) 歧义澄清
        const noteParts = []
        if (cfg.askWhenAmbiguous) {
          const ambiguous = uniq.filter((u) => u.ambiguity >= 3 && !u.skipped)
          if (ambiguous.length) {
            const asked = await tryAsk(exec, ambiguous)
            if (asked) {
              let skipped = 0
              let clarified = 0
              for (let k = 0; k < ambiguous.length; k++) {
                const u2 = ambiguous[k]
                const ans = asked['task-' + u2.key]
                if (ans) {
                  if (ans.selected && ans.selected.indexOf('本轮先跳过') !== -1) { u2.skipped = true; skipped++ }
                  else {
                    if (ans.custom) { u2.description = clip(u2.description + '\n用户澄清：' + ans.custom, 5000); clarified++ }
                    else clarified++
                  }
                }
              }
              noteParts.push('已向用户澄清 ' + ambiguous.length + ' 个任务：' + clarified + ' 个继续，' + skipped + ' 个跳过')
            } else {
              noteParts.push('澄清提问不可用，按当前理解继续')
            }
          }
        }

        // 3) 解析路由并执行
        const runnable = uniq.filter((u) => !u.skipped)
        for (let m = 0; m < runnable.length; m++) {
          const u3 = runnable[m]
          u3.route = resolveRoute(cfg, u3.type, u3.difficulty)
          if (u3.route && caps.agentOptions === false) {
            u3.note = 'provider 不支持模型覆盖，已忽略指定模型'
            u3.route = null
          }
        }
        const limit = Math.max(1, Math.min(8, cfg.maxParallel | 0))
        const settled = await pool(runnable, limit, (u) => runOne(subagents, provider.name, caps, u, exec))

        // 4) 组装结果
        const results = []
        for (let n = 0; n < settled.length; n++) {
          const u4 = settled[n]
          let rn = u4.note || ''
          if (u4.merged > 1) rn = (rn ? rn + '；' : '') + '合并了 ' + u4.merged + ' 个相同任务'
          results.push({
            title: u4.title,
            type: u4.type,
            difficulty: u4.difficulty,
            status: u4.status || 'error',
            model: u4.route ? (u4.route.provider + '/' + u4.route.model) : 'inherit',
            summary: u4.summary || '',
            childId: u4.childId || '',
            note: rn,
          })
        }
        for (let s = 0; s < uniq.length; s++) {
          const u5 = uniq[s]
          if (u5.skipped) {
            results.push({
              title: u5.title, type: u5.type, difficulty: u5.difficulty,
              status: 'skipped', model: '-', summary: '', childId: '',
              note: u5.note || '用户选择本轮跳过',
            })
          }
        }
        if (noteParts.length) return { results, note: noteParts.join('；') }
        return { results }
      },
    })
  }

  // ── 3. mode：systemPrompt 段 ──
  const sp = ctx.get('systemPrompt')
  if (sp !== undefined && typeof sp.section === 'function') {
    sp.section({
      name: 'model-dispatch:policy',
      order: 470,
      text(ac) {
        const cfg = getConfig()
        const sid = ac && ac.agent ? ac.agent.id : undefined
        if (!modeFor(cfg, sid)) return ''
        return buildPolicyText(cfg)
      },
    })
  }

  // ── 4. /mdisp 命令 ──
  const commands = ctx.get('commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    commands.register({
      name: 'mdisp',
      description: '模型分工模式：on / off / status（仅影响当前会话）',
      handler(inv) {
        const cfg = getConfig()
        const arg = (inv.rawInput || '').trim().toLowerCase()
        const sid = inv.agent ? inv.agent.id : undefined
        if (arg === 'on' || arg === 'off') {
          sessionModes.set(sid, arg === 'on')
          return {
            kind: 'success',
            text: '本会话模型分工模式已' + (arg === 'on' ? '开启' : '关闭') + '（也可点输入框左侧的「分工」药丸切换）',
          }
        }
        return { kind: 'success', text: '本会话模型分工模式：' + (modeFor(cfg, sid) ? '开启' : '关闭') + '。用法：/mdisp on、/mdisp off' }
      },
    })
  }

  // ── 5. Client RPC HTTP 路由 ──
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    // GET /api/mdisp/state — 获取配置、目录、诊断、会话模式
    webServer.register({
      kind: 'exact',
      path: '/api/mdisp/state',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')
          const cfg = getConfig()
          const built = await buildCatalog(llm, settings)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            config: cfg,
            catalog: built.catalog,
            diagnostics: built.diagnostics,
            sessionId,
            mode: modeFor(cfg, sessionId || undefined),
          }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: errText(e) }))
        }
      },
    })

    // POST /api/mdisp/set-mode — 会话级模式开关
    webServer.register({
      kind: 'exact',
      path: '/api/mdisp/set-mode',
      handler: async (req, res) => {
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          const data = JSON.parse(body || '{}')
          const cfg = getConfig()
          const sessionId = data.sessionId || null
          const active = !!data.active
          if (!sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: '缺少 sessionId' }))
            return
          }
          sessionModes.set(sessionId, active)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, sessionId, mode: active }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: errText(e) }))
        }
      },
    })

    // POST /api/mdisp/save-config — 保存配置（持久化）
    webServer.register({
      kind: 'exact',
      path: '/api/mdisp/save-config',
      handler: async (req, res) => {
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          const data = JSON.parse(body || '{}')
          const next = data.config
          const built = await buildCatalog(llm, settings)
          validateConfig(next, built.catalog)

          if (settingsScope && typeof settingsScope.update === 'function') {
            await settingsScope.update({
              enabled: next.enabled === true,
              askWhenAmbiguous: next.askWhenAmbiguous !== false,
              maxParallel: Math.max(1, Math.min(8, next.maxParallel || 4)),
              taskTypes: next.taskTypes.map((t) => String(t).trim()),
              routes: (Array.isArray(next.routes) ? next.routes : [])
                .filter((r) => r && typeof r.provider === 'string' && r.provider && typeof r.model === 'string' && r.model)
                .map((r) => ({ type: r.type, difficulty: r.difficulty, provider: r.provider, model: r.model })),
              fallback: {
                high: cleanRoute(next.fallback && next.fallback.high),
                medium: cleanRoute(next.fallback && next.fallback.medium),
                low: cleanRoute(next.fallback && next.fallback.low),
              },
            })
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, enabled: next.enabled === true }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: errText(e) }))
        }
      },
    })

    // POST /api/mdisp/set-enabled — 全局开关
    webServer.register({
      kind: 'exact',
      path: '/api/mdisp/set-enabled',
      handler: async (req, res) => {
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          const data = JSON.parse(body || '{}')
          const enabled = !!data.enabled

          if (settingsScope && typeof settingsScope.update === 'function') {
            await settingsScope.update({ enabled })
          }
          sessionModes.clear()

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, enabled }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: errText(e) }))
        }
      },
    })
  }
}
