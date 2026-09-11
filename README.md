# 模型分工（Model Dispatch）— DSH 静态插件

> 插件 ID：`model-dispatch` ｜ 类型：静态 Cordis 插件（Host + Client）｜ **配置持久化，重启不丢失**

## 简介

在 DSH 中创建一个 **「模型分工」模式**：主代理把可独立完成的子任务交给 `dispatch_task` 工具，插件会：

1. **评估任务的类型与难度**（类型：`architecture` 架构设计 / `coding` 编码 / `ui-design` UI 设计 / `bugfix` 纠错改正 / `review` 评审 / `docs` 文档 / `testing` 测试 / `research` 调研，可自定义扩展；难度：high / medium / low）。调用方提供类型/难度时直接采用，否则由插件用零 token 的启发式规则兜底分类。
2. **按用户在设置页配置的模型矩阵路由到不同模型**：`type × difficulty → provider/model`，未定点配置时回退到该难度通用回退，仍未配置则继承当前会话模型。
3. **spawn 子代理执行**（走 DSH 官方 `subagents.start`，通过 `SubagentStartRequest.agentOptions` 覆盖子代理的 provider/model）。
4. **并行 / 去重**：同一次调用携带的多个独立任务并行执行（受「最大并行数」限制）；重复或同质的任务自动合并为一个。
5. **复杂或歧义任务先向用户确认**（`userQuestions.ask` 结构化提问），确认后再架构设计、再派发编码——符合「先思考理解 → 必要时提问确认 → 架构设计 → 编写」的流程。
6. **省 token 且保证成果质量**：低难度任务可派给便宜模型、高难度任务派给强模型；子代理 prompt 只携带最小必要上下文，并要求返回 ≤300 字的结构化摘要，主会话只回收精简结果。

## 安装

### 方式一：从 GitHub 安装（推荐）

```bash
dsh plugin add github:HansonFeng123/dsh-model-dispatch
```

### 方式二：本地开发/测试

把本目录放入 profile 的 `node_modules`：

```bash
# 在 profile 目录下
ln -s /path/to/dsh-model-dispatch node_modules/dsh-model-dispatch
# 或直接把整个文件夹复制过去
cp -r dsh-model-dispatch ~/.dsh/profiles/web/node_modules/
```

然后重启 DSH Web（`pnpm run dev:web` 或重启 `dsh web`）。

### 方式三：通过 cordis.patch.yml 手动挂载

在 profile 的 `cordis.patch.yml` 里添加：

```yaml
- insert:
    - id: model-dispatch
      name: dsh-model-dispatch
```

## 功能清单

| 能力 | 实现位置 |
| --- | --- |
| 模式（mode） | Host：`systemPrompt.section('model-dispatch:policy')`，模式开启时向每步请求注入分工指导（含当前路由表）；关闭时输出空字符串 |
| 会话级开关（可见） | Client：`conversation.input.left` —— 输入框工具栏左侧的「分工 开/关」药丸（additive 槽位，replaceRisk: none） |
| 会话级开关（命令） | `/mdisp on` / `/mdisp off`；全局默认值在设置页 |
| 设置板块 | Client：`settings.section` 新增「模型分工」页——类型×难度矩阵、通用回退、并行数、澄清开关、自定义类型 |
| 派发工具 | Host：`dispatch_task`（模型可见，经 `tools.register` 注册） |
| 模型目录 | `llm.listProviders()` + `llm.listModels(provider)` 实时读取 DSH 已录入的模型 |
| 运行卡 | Client：`tool.view.cordis`（key `self`）展示模式状态、路由摘要与用法 |

## 使用方法

1. 安装插件后，打开 **设置 → 模型分工**，为每种「任务类型 × 难度」选择模型（下拉直接列出 DSH 已录入的 provider/model；「继承上级模型」= 不指定，沿用当前会话模型），点击 **保存配置**。
2. **开启模式（三种方式，任选）**：
   - **输入框工具栏左侧的「分工 开/关」药丸** —— 点一下即切换（对本会话生效，会变蓝底白字）；
   - 输入框直接打 **`/mdisp on`** / **`/mdisp off`**（本会话）；
   - **设置 → 模型分工 → 「新会话默认启用该模式」** —— 只决定新会话的默认值。
3. 模式开启后，系统提示词会注入分工策略与当前路由表（`model-dispatch:policy` 段）；主代理随后会：拆解任务 → 评估类型/难度 →（歧义则先 `ask_user_question` 确认）→ 调用 `dispatch_task` 派发。你也可以直接命令主代理「用 dispatch_task 把 X 和 Y 并行做掉」。
4. 关闭：再点一次药丸，或 `/mdisp off`。

## 配置说明（设置页「模型分工」）

- **新会话默认启用该模式**：全局开关，作为新会话模式默认值。**出厂默认关闭**（模式是显式选择，不静默消耗 token）；勾选并保存后才默认开启。
- **歧义/信息不足时向用户提问确认**：开启后，`dispatch_task` 对信息不足或有歧义的任务先弹出结构化提问（选项：按当前理解继续 / 本轮先跳过 + 可自由补充），再决定派发。
- **最大并行子代理数**：1–8，控制同时运行的子代理数量。
- **通用回退**：每个难度一档，用于没有定点配置的「类型 × 难度」组合。
- **任务类型 × 难度 → 模型**：矩阵表格，每个格子一个模型下拉。
- **添加类型**：支持自定义任务类型（如 `database`），启发式分类无法命中自定义类型时，请让调用方在 `dispatch_task` 参数里显式传 `type`。

## 持久化

- **配置持久化**：通过 `settings.register('model-dispatch', Config)` 注册命名空间，用户保存的配置落到 profile 的 settings 文档中（`~/.dsh/profiles/web/settings.yaml`），**重启不丢失**。
- **会话级模式开关**：保存在插件运行期内存中（`sessionModes` Map），重启后丢失（符合预期——会话级状态不应跨重启保留）。

## 工作原理（关键接口）

- 子代理模型覆盖：`subagents.start(name, { prompt, parent: Agent, signal, agentOptions: { provider, model } })`
- 模型目录：`llm.listProviders(): LlmProviderInfo[]`、`llm.listModels(provider): LlmModelInfo[]`
- 提问确认：`userQuestions.ask({ questions, agent, signal })`
- 模式注入：`systemPrompt.section({ name, order, text: (AssembleContext) => string })`
- 会话级开关：`commands.register({ name: 'mdisp', handler })`
- Client→Host 通信：`webServer.register()` 注册 HTTP 路由，`fetch('/api/mdisp/...')` 调用
- 配置持久化：`settings.register('model-dispatch', Config)` + `settingsScope.update(patch)`

## 纯逻辑的回归测试（`test-validate.mjs`）

Host 侧的校验函数不依赖任何服务，可以直接测：

```bash
node model-dispatch/test-validate.mjs
```

用探针实测到的真实目录作夹具，覆盖 11 个用例（含导致过线上故障的「回退选了模型」、以及各类必须被拦住的坏输入），全绿才算通过。当前结果：**11/11 PASS**。

## 已知限制

- 启发式分类/歧义打分为关键词规则，无法覆盖全部场景；模型可在 `dispatch_task` 参数中显式指定 `type`/`difficulty`/`needsClarification` 纠正。
- `dispatch_task` 为独占工具（`isConcurrencySafe` 未开启），同一会话内并发调用会排队。
- 会话级模式开关不跨重启保留（符合预期）。

## Credits / 借鉴来源

- [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM) — 基于查询复杂度的强弱模型路由框架
- [ulab-uiuc/LLMRouter](https://github.com/ulab-uiuc/LLMRouter) — 按任务复杂度、成本、性能要求智能选模的库
- [anyscale/llm-router](https://github.com/anyscale/llm-router) — 基于查询复杂度分类器训练路由器的教程
- [yenanjing/awesome-model-routing](https://github.com/yenanjing/awesome-model-routing) — LLM 路由框架/网关/推理引擎的精选清单

## 源码

- `index.js` — Host 半（工具、模式、命令、HTTP 路由、持久化）
- `client.js` — Client 半（设置页、运行卡、输入框「分工」药丸）
- `cordis.patch.yml` — 自动挂载到 profile 的组成补丁
- `test-validate.mjs` — 配置校验的纯逻辑回归测试
