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
dsh plugin --profile web add github:HansonFeng123/dsh-model-dispatch
```

> 注意：命令必须带 `--profile web`（或你的 profile 名），否则会报 `error: required option '--profile <name>' not specified`。

安装完成后**重启 DSH Web**（关闭再重新打开，或重新运行 `dsh web`），插件才会加载。

### 方式二：本地开发/测试

把本目录放入 profile 的 `node_modules`：

```powershell
# Windows PowerShell：直接复制整个文件夹
Copy-Item -Recurse -Force dsh-model-dispatch "$env:USERPROFILE\.dsh\profiles\web\node_modules\"
```

```bash
# macOS / Linux
cp -r dsh-model-dispatch ~/.dsh/profiles/web/node_modules/
```

然后重启 DSH Web。

> ⚠️ 手动复制方式还需要把 `"dsh-model-dispatch"` 加进 profile 的 `package.json` 的 `dsh.profile.bundles` 数组，否则 DSH 启动时不会加载它。推荐使用方式一，`dsh plugin add` 会自动完成这一步。

### 查看已安装的插件

```bash
dsh --profile web plugin list
```

## 卸载

### 方法一：使用 dsh 命令（推荐）

```bash
dsh plugin --profile web remove dsh-model-dispatch
```

### 方法二：手动删除（命令报错时的兜底）

1. 删除插件目录：

```powershell
# Windows PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-model-dispatch"
```

```bash
# macOS / Linux
rm -rf ~/.dsh/profiles/web/node_modules/dsh-model-dispatch
```

2. 编辑 profile 的 `package.json`（`~/.dsh/profiles/web/package.json`）：
   - 从 `dependencies` 里删除 `"dsh-model-dispatch": ...` 这一行
   - 从 `dsh.profile.bundles` 数组里删除 `"dsh-model-dispatch"` 这一项

3. 重启 DSH Web。

### 清理残留配置（可选）

插件保存的配置持久化在 profile 的 settings 文档里。想彻底清掉的话：

- 编辑 `~/.dsh/profiles/web/settings.yaml`，删除 `model-dispatch` 命名空间那一节。

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

## 预设（v1.1.0 新增）

一个预设 = 一套完整的「类型×难度矩阵 + 通用回退」存档。适合「便宜日常」和「强力攻坚」等多套组合来回切换。

### 管理预设（设置 → 模型分工 → 预设卡片）

- **把当前配置另存为预设**：输入名称 → 点按钮。保存后该预设立即成为「使用中」。
- **应用**：切换到该预设（把预设的矩阵+回退拷贝为当前生效配置，立即生效；预设里出现而当前没有的任务类型会自动并入）。
- **用当前配置覆盖**：把当前矩阵+回退写回该预设。
- **重命名**：在下方「重命名为」框输入新名字，再点某条预设的「重命名」。
- **删除**：删除该预设（不影响当前生效配置）。

### 快速切换预设

- **输入框药丸**：「分工 开/关」按钮右侧多了一段当前预设名，点它就轮换到下一个预设（无预设时置灰，悬停有提示）。
- **命令**：
  - `/mdisp preset` —— 列出全部预设（→ 标记当前生效）
  - `/mdisp preset 2` 或 `/mdisp preset 强力攻坚` —— 按序号或名称切换

### 语义说明

- 预设存的是**矩阵+回退的副本**；「应用」是拷贝而非引用。应用之后再改矩阵，预设不会跟着变（需要「用当前配置覆盖」回写）。
- 当前生效配置如果和某个预设内容一致，设置页和药丸会以 `activePreset` 标记「使用中」；手动改过矩阵后标记仍在（表示「源自该预设」），以设置页内容为准。
- 最多 20 个预设，名称不可重复。

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
node test-validate.mjs
```

用探针实测到的真实目录作夹具，覆盖 16 个用例（含导致过线上故障的「回退选了模型」、`type:null` 的畸形工具 schema，以及各类必须被拦住的坏输入），全绿才算通过。当前结果：**16/16 PASS**。

## 已知限制

- 启发式分类/歧义打分为关键词规则，无法覆盖全部场景；模型可在 `dispatch_task` 参数中显式指定 `type`/`difficulty`/`needsClarification` 纠正。
- `dispatch_task` 为独占工具（`isConcurrencySafe` 未开启），同一会话内并发调用会排队。
- 会话级模式开关不跨重启保留（符合预期）。

## 常见问题与故障排除

### 问题 1：`error: required option '--profile <name>' not specified`

**原因**：`dsh plugin` 命令必须指定 profile。

**解决**：命令里加上 `--profile web`：

```bash
dsh plugin --profile web add github:HansonFeng123/dsh-model-dispatch
dsh plugin --profile web remove dsh-model-dispatch
dsh --profile web plugin list
```

### 问题 2：`pnpm failed ... git-hosted plugins build on install via their prepare script`（EPERM）

**原因**：插件包带有 `dependencies` 时，pnpm 安装 git 包会尝试跑构建脚本，被 Windows 权限拦住。本插件 v1.0.1 起已移除全部依赖，正常不会再触发。

**解决**：
1. 确认安装的是 v1.0.1+（`package.json` 无 `dependencies` 字段）
2. 若仍失败，用「卸载 → 方法二：手动删除」清理后，改用「安装 → 方式二：本地复制」
3. 若 pnpm 明确提示需要 allowBuilds 键，可在 profile 的 `pnpm-workspace.yaml` 里加：
   ```yaml
   allowBuilds:
     - dsh-model-dispatch
   ```
   然后重试安装。

### 问题 3：安装成功，但设置页看不到「模型分工」

**排查顺序**：
1. 确认**重启过 DSH Web**（安装后不重启不加载）
2. 确认插件在 bundles 里：查看 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组是否有 `"dsh-model-dispatch"`（`dsh plugin add` 会自动加；手动复制方式需要自己加）
3. 确认版本 ≥ v1.0.3（v1.0.0 客户端缺 `apply` 导出；v1.0.1 的 schema 用了 schemastery 不存在的 `.optional()` 导致启动崩溃；v1.0.2 的客户端访问了未注入的 `ctx.styles` 导致浏览器端加载失败）
4. 打开浏览器开发者工具（F12）看 Console 是否有 `dsh-model-dispatch` 相关报错

### 问题 4：配置保存后重启丢失

**排查**：
1. 确认插件加载正常（设置页能打开）
2. 检查 `~/.dsh/profiles/web/settings.yaml` 里是否出现 `model-dispatch` 段；没有的话说明 settings 服务写入失败，看 DSH 启动日志里 `[model-dispatch]` 的报错

### 问题 5：`dispatch_task` 工具没有出现在会话里

**排查**：
1. 确认插件已加载（设置 → 模型分工 页面能打开）
2. 工具注册发生在插件启动时，重启 DSH Web 后新会话才可见
3. 查看 DSH 启动日志有无 `model-dispatch` 相关错误

### 彻底重置（插件导致 DSH 无法启动时的终极方案）

如果插件导致 DSH 启动异常：

```powershell
# 1. 删插件目录
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-model-dispatch"
```

然后编辑 `~/.dsh/profiles/web/package.json`，删掉 `dependencies` 和 `dsh.profile.bundles` 里的 `dsh-model-dispatch` 两处，重启即可恢复。插件的全部行为只来自上面这两处 + 可选的 settings.yaml 配置段，不碰任何 DSH 本体文件。

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

## 版本历史

- **v1.1.2**（2026-09-12）
  - **修复 `deepseek-v4.1-flash` 报 `schema must be a JSON Schema of 'type: "object"', got 'type: null'`**：根因是 `parameters` 沿用了动态插件专有的「隐式属性映射 DSL」（顶层没有 `type:'object'` / `properties` 包装），而静态 `tools.register()` 不像 `harness.defineTool()` 那样做规范化，缺 `type` 的 schema 会被模型方校验成 `type: null` 而拒收
  - 新增注册前 schema 自检 `assertJsonObjectSchema()`：顶层必须是 `type:'object'` + `properties`，且递归检查每个节点，畸形 schema 在本地就报错（附路径），不再等到模型请求时才失败
  - 回归测试从 11 项扩到 **16 项**，新增 5 项 schema 形状用例（含本次故障形状）
- **v1.1.1**（2026-09-11）
  - 修复 `dispatch_task` 参数 schema：静态 `tools.register` 走标准 JSON Schema（`type:'object'` + `properties` + `required` 数组），此前误用动态插件专有的隐式映射 DSL，导致模型看到畸形 schema、只能传 `{}` 并反复空调用（截图中的 `dispatch_task × 5` 重复即由此而来）
  - tasks 为空时返回带 JSON 示例的自纠错误（`error: INVALID_ARGUMENTS`），模型收到后知道如何正确传参，不再盲目重试
  - `difficulty` 增加 `enum: ['high','medium','low']` 约束，减少模型乱填
- **v1.1.0**（2026-09-11）
  - 新增预设功能：一套组合的模型矩阵存档（另存 / 应用 / 覆盖 / 重命名 / 删除，最多 20 个）
  - 「分工」药丸变为两段：左半开/关模式，右半显示当前预设名、点击轮换预设
  - 新增 `/mdisp preset [序号|名称]` 命令查看与切换预设
  - 运行卡显示当前预设
- **v1.0.3**（2026-09-11）
  - 修复浏览器端加载失败：`cannot get property "styles" without inject` —— 静态 client bundle 不能访问 `ctx.styles`（需声明 inject），样式改回带 id 的幂等 `<style>` DOM 注入（与 dsh-mood-light 相同的标准做法）
- **v1.0.2**（2026-09-11）
  - 修复启动崩溃：`z.object(...).optional is not a function` —— schemastery 没有 `.optional()` 方法，fallback 字段改用 `.default({})` + 内部字段 `.default('')` 表达（空 provider 视为未配置，行为不变）
  - 保存配置时把「清空的回退」统一写成空对象 `{}`，与 schema 兼容
- **v1.0.1**（2026-09-11）
  - 移除 `schemastery` 依赖 → 修复 `dsh plugin add` 的 EPERM 安装失败
  - 客户端补上 `apply` / `inject` 导出 → 修复「安装成功但设置页不显示」
  - 修复 Host 端 `tryAsk` 误引用 `exec.ctx` 的错误
  - README 新增完整的安装/卸载/故障排除说明
- **v1.0.0**（2026-09-10）
  - 初始版本：由动态 Cordis 插件改造为静态插件，配置持久化
