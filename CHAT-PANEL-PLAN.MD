# Chat Panel 消息展示实施计划（CHAT-PANEL-PLAN）

> **目的**：为 littlebench 实现一个 agent 聊天面板的消息展示方案，支持流式输出、工具调用折叠、思考链展示、错误处理与会话持久化。
> **读者**：负责实现的 AI agent / 工程师。本文档自包含，无需其他上下文。
> **来源**：对成熟 agent 桌面客户端（opencode desktop，Electron + SolidJS 架构）渲染层与事件层的逆向分析，所有规则均来自真实实现，非理论设计。

---

## 0. 一句话总纲

**消息是"Part 流"而非整块文本；UI 按 Part 类型决定显隐（正文全显、思考折叠、工具折叠+专属渲染、搜索类合并计数）；瞬态 token 增量走节流缓冲保证流式顺滑；全量数据实时落盘 JSON、重启可重放。**

---

## 1. 总体架构：三层流水线

```
模型侧                      Agent 运行时(服务层)                      Chat Panel(渲染层)
─────────                  ──────────────────────────              ─────────────────────
LLM API SSE 流      ──▶    解析 delta
(chat/completions)         组装 Message / Part
                           ──实时落盘──▶  JSON 文件存储
                           发布事件(事件总线)
                                   │  (SSE 或 IPC 转发)
                                   ▼
                          渲染层事件订阅
                          本地 store(节流合帧)
                                   │
                                   ▼
                          constructTimelineRows()
                                   │
                                   ▼
                          TimelineRow[] → 组件树渲染
```

三个关键分离：
1. **服务层**负责跑 agent 循环（模型调用 → 工具执行 → 再调用），产出结构化 Message/Part，落盘并发布事件。
2. **事件层**区分"持久事件"（需要落盘、断线可补）和"瞬态事件"（逐 token 增量，只进 UI）。
3. **渲染层**不直接理解模型协议，只消费 Message/Part 事件，把 Part 流重排为时间线行。

---

## 2. 核心概念

### 2.1 一切皆 Part

助手的一条"回复"是一个**容器消息**，内部是按时间顺序排列的 Part 序列。典型一轮：

```
[step-start] → [reasoning 思考中...] → [text 正文] → [tool 调 bash]
→ [tool 调 read] → [text 继续正文] → [text 最终结论]
```

**为什么这样设计**：流式场景下内容是增量产出的，Part 是最小的增量单元；不同 Part 类型用不同组件渲染，互不干扰。

### 2.2 时间线行（TimelineRow）

渲染层不直接渲染 Part，而是先把消息流**重排**为时间线行：

| 行类型 | 含义 |
|--------|------|
| `UserMessage` | 用户消息气泡 |
| `AssistantPart` | 助手的一个可见 Part |
| `Thinking` | 忙碌且尚无可见 Part 时的"思考中"占位指示器 |
| `TurnDivider` | 分割线，label = `compaction`（上下文压缩）或 `interrupted`（中途打断） |
| `Retry` | 打断后的重试入口行 |
| `DiffSummary` | 空闲(idle)时显示的本轮文件改动统计 |
| `Error` | 错误行 |
| `TurnGap` | 轮次间距（纯布局） |

---

## 3. 数据模型（TypeScript 定义，直接采用）

```ts
// ============ 消息 ============
interface ChatMessage {
  id: string                      // "msg_" 前缀 + 随机串
  sessionID: string               // "ses_" 前缀
  role: "user" | "assistant"
  time: {
    pending:   number | null      // 消息创建(排队)时间戳
    streaming: number | null      // 首个 token 到达时间戳
    completed: number | null      // 生成完成时间戳
  }
  error?: string | null
  providerID?: string             // 模型供应方
  modelID?: string                // 模型名
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
    cost: number                  // 本条消息成本，UI 逐条展示用
  }
  parts: Part[]                   // Part 内嵌于消息对象
}

// ============ Part 联合类型 ============
type Part = TextPart | ReasoningPart | ToolPart | StepStartPart | SnapshotPart

interface BasePart { id: string } // "part_" 前缀

interface TextPart extends BasePart {
  type: "text"
  text: string
}

interface ReasoningPart extends BasePart {
  type: "reasoning"
  text: string
  metadata?: Record<string, unknown>
}

interface StepStartPart extends BasePart { type: "step-start" }   // 仅标记步骤边界，不渲染
interface SnapshotPart extends BasePart { type: "snapshot" }      // 不渲染

interface ToolPart extends BasePart {
  type: "tool"
  tool: string                    // 工具名："bash" / "read" / "edit" / "write" / "glob" / "grep" / ...
  state: {
    status: "pending" | "running" | "completed" | "error"
    input: unknown                // 工具入参（对象）
    output?: unknown              // 工具返回（任意可序列化值）
    error?: string
    title?: string                // 工具侧生成的摘要标题（如命令行文本）
    metadata?: Record<string, unknown>
  }
}

// ============ 瞬态增量载荷 ============
interface PartDelta {
  sessionID: string
  messageID: string
  partID: string
  field: "text" | "reasoning"     // 增量属于正文还是思考
  delta: string                   // 本次追加的文本片段
}
```

---

## 4. 事件协议（渲染层唯一输入源）

渲染层通过事件总线（SSE / IPC 均可）接收以下事件，**这是渲染层对服务层的全部依赖**：

### 4.1 持久事件（改变消息/会话的权威状态）

| 事件 | 载荷 | 语义 |
|------|------|------|
| `message.updated` | `{ sessionID, info: ChatMessage }` | 整条消息创建/更新（含完整 parts） |
| `message.removed` | `{ sessionID, messageID }` | 删除消息 |
| `message.part.updated` | `{ sessionID, part: Part, messageID }` | 单个 Part 更新（工具状态变更等） |
| `message.part.removed` | `{ sessionID, messageID, partID }` | 删除 Part |
| `session.created` / `session.updated` / `session.deleted` | `{ sessionID, info }` | 会话级元数据 |
| `session.error` | `{ sessionID, error }` | 会话级错误 |

### 4.2 瞬态事件（只进 UI 缓冲，不落盘）

| 事件 | 载荷 | 语义 |
|------|------|------|
| `message.part.delta` | `PartDelta`（见上） | **逐 token 文本增量**，field 区分正文/思考 |
| `session.diff` | `{ sessionID, diff[] }` | 文件改动流 |

### 4.3 投递语义要求

- **排序**：同一 Part 的 `delta` 必须有序；`part.updated`（终态）必须晚于该 Part 的所有 `delta`。
- **幂等**：渲染层按 `partID` 幂等处理，重复事件不产生重复内容。
- **终态覆盖**：收到 `part.updated` 终态时，丢弃该 Part 的缓冲增量、以终态为准（防止瞬态与持久不一致）。

---

## 5. 渲染管线

### 5.1 管线流程

```
事件 → store 更新（消息列表 + delta 缓冲）→ [节流合帧] → constructTimelineRows() → 组件渲染
```

### 5.2 constructTimelineRows 伪代码（核心算法，照抄）

```ts
function constructTimelineRows(messages: ChatMessage[], opts: {showReasoning: boolean}): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const msg of messages) {
    if (msg.role === "user") {
      rows.push({ type: "UserMessage", message: msg })
      continue
    }
    // 助手消息：先做可见性过滤
    const visible = msg.parts.filter(p => renderable(p, opts.showReasoning))
    // 思考占位：忙碌中 且 还没有任何可见 part
    if (isBusy(msg) && visible.length === 0) {
      rows.push({ type: "Thinking", label: "思考中" })
    }
    // 打断检测：aborted 在中断点插入分割线 + Retry 行
    if (msg.error instanceof AbortedError) {
      rows.push({ type: "TurnDivider", label: "interrupted" })
      rows.push({ type: "Retry", message: msg })
    }
    // 分组渲染（glob/grep 合并规则见 5.4）
    for (const group of groupParts(visible)) {
      if (group.kind === "ContextToolGroup") {
        rows.push({ type: "ContextToolGroup", parts: group.parts, trigger: group.trigger, count: group.parts.length })
      } else {
        rows.push({ type: "AssistantPart", part: group.part, message: msg })
      }
    }
    // 空闲时附加文件改动摘要
    if (isIdle()) rows.push({ type: "DiffSummary", message: msg })
  }
  return rows
}
```

### 5.3 renderable() —— 可见性过滤（照抄）

```ts
function renderable(part: Part, showReasoning: boolean): boolean {
  switch (part.type) {
    case "text":      return true
    case "reasoning": return showReasoning          // 用户设置控制，默认 false 可完全不渲染
    case "tool":      // glob/grep 默认不可见（被合并进组，见 5.4），除非被预览/手动展开
      return !(part.tool === "glob" || part.tool === "grep") || isPreviewed(part.id) || isExpanded(part.id)
    default:          return false                  // step-start / snapshot / 未知类型一律不渲染
  }
}
```

### 5.4 groupParts() —— 连续同类搜索工具合并（照抄）

```ts
function groupParts(parts: Part[]): Group[] {
  const out: Group[] = []
  for (const p of parts) {
    const trigger = p.type === "tool" && p.tool === "glob" ? "searched (file list)"
                  : p.type === "tool" && p.tool === "grep" ? "searched (content)"
                  : null
    // 仅当与上一组同类且同为 glob/grep 时并入，否则新建组
    if (trigger && out.length && out.at(-1)!.kind === "ContextToolGroup" && out.at(-1)!.trigger === trigger) {
      out.at(-1)!.parts.push(p)
    } else if (trigger) {
      out.push({ kind: "ContextToolGroup", trigger, parts: [p] })
    } else {
      out.push({ kind: "Part", part: p })
    }
  }
  return out
}
```

**效果**：agent 连续调 5 次 glob + 3 次 grep，UI 只显示两行："searched (file list) ×5"、"searched (content) ×3"，点击展开明细。

### 5.5 reasoningHeading() —— 思考行折叠标签

```ts
function reasoningHeading(text: string): string {
  const firstLine = text.split("\n")[0] ?? ""
  return firstLine.length > 12 ? firstLine.slice(0, 12) + "…" : firstLine
}
```

---

## 6. 显示与折叠规则总表（⭐ 本方案核心策略）

| 内容类型 | 展示策略 | 折叠默认态 | 展开方式 |
|----------|----------|:---:|----------|
| 用户消息 | 完整气泡显示 | — | — |
| 助手正文 `text` | **永远显示**，Markdown 渲染（代码块语法高亮） | 不折叠 | — |
| 思考 `reasoning` | 折叠为**单行**，标签 = `reasoningHeading(text)` | **默认折叠** | 点击展开为 Markdown 块 |
| 工具调用 `tool` | 折叠为**触发行**：图标 + 标题 + 状态（running 转 spinner，completed 显示摘要标题，error 显示错误） | **默认折叠** | 点击展开：上半区 input 参数（Markdown），下半区 output（`JSON.stringify(output, null, 2)` 美化） |
| 连续 glob/grep | 合并为一行计数组 `ContextToolGroup` | **默认折叠** | 点击展开逐条明细 |
| `step-start` / `snapshot` / 未知类型 | **完全不渲染** | — | — |
| 上下文压缩 compaction | `TurnDivider` 分割线，label="compaction" | — | — |
| 中途打断 | `TurnDivider` label="interrupted" + `Retry` 行 | — | Retry 点击重发 |
| 工具失败 | Error 样式，**自动展开高亮**（正常完成不展开） | 自动展开 | — |
| 文件改动 | 空闲时 `DiffSummary` 统计行 | 折叠 | 展开看 diff 明细 |
| 忙碌且无可见 Part | `Thinking` 占位指示器（转圈/呼吸动画） | — | — |

**设计原则**：折叠不只是省空间，更是**性能设计**——一次文件读取工具的输出可能几百 KB，默认折叠保护滚动体验与 DOM 规模。

---

## 7. 工具专属渲染器注册表

通用渲染器 `BasicTool`（触发行 + 可展开的 input/output）覆盖大多数工具；以下工具注册**专属渲染器**提升可读性：

| 工具 | 渲染器 | 触发行显示 | 展开后 |
|------|--------|-----------|--------|
| `read` | FileLoadTool | 图标 + "已加载 {文件名}" + 行范围 | 文件内容行列表（带行号） |
| `bash` / shell | TerminalBlock | `$ {命令}` 摘要 | 终端样式输出块（黑底等宽，保留 ANSI 最好） |
| `edit` | DiffView（**可编辑**） | "编辑 {文件名}" | diff 视图：红删绿增，支持**手动修正后重新应用** |
| `write` | DiffView（**可编辑**） | "写入 {文件名}" | 同上，新文件全绿 |
| `task`（子 agent） | TaskCard | 子 agent 名 + 目标摘要 | 卡片：状态、耗时、返回摘要 |
| `ask`/`question` | QuestionDock | — | 底部停靠交互区：问题 + 选项按钮（支持多选/自定义输入） |
| `todo` | TodoList | 任务摘要 | 待办清单：状态图标（pending/in_progress/completed）+ 标题 |
| 其他任意工具 | `BasicTool` | `getToolInfo(tool, input)` 生成标题 | input(Markdown) + output(JSON 2空格美化) |

实现为注册表模式：

```ts
const ToolRegistry: Record<string, ToolRenderer> = {
  read: FileLoadTool, bash: TerminalBlock, edit: DiffView, write: DiffView,
  task: TaskCard, ask: QuestionDock, todo: TodoList,
  // 未注册的走默认
}
const Renderer = ToolRegistry[part.tool] ?? BasicTool
```

组件命名约定：`data-component="tool-trigger"`、`"tool-output"`、`"reasoning-part"` 等 kebab-case 属性，便于测试与样式隔离。

---

## 8. 流式渲染与性能策略（⭐ 防卡顿关键）

### 8.1 增量缓冲（delta accumulation）

```
message.part.delta ──▶ buffer[partID] += delta     （纯字符串追加，O(1)）
                    （不直接 setState！）
```

### 8.2 节流合帧 + "runaway"保护

- delta 高频到达（每秒可达数十次），**严禁逐 delta 触发渲染**。
- 定时（如 50–100ms）+ 空闲帧（rAF）批量把缓冲区刷入响应式状态。
- **runaway 保护**：单帧若积累 delta 超过阈值（如 8KB），直接整块刷入并跳过平滑动画，防止长输出时永远追不上。
- 工具状态变更（running→completed）等低频持久事件直接应用，不必节流。

### 8.3 PacedMarkdown（匀速放字）

- 流式期间正文/思考用 `PacedMarkdown`：缓冲区文本以恒定速率"放出"渲染，视觉平滑、无跳变。
- 判定流式结束：`role === "assistant" && typeof time.completed !== "number"` 为流式中；`completed` 落定后**切换为静态 Markdown 组件**（一次性渲染，脱离动画路径）。

### 8.4 长会话防护（建议项）

- 时间线列表做虚拟滚动（仅渲染视口附近行）。
- 折叠态的工具行不渲染其 output DOM（展开时才挂载）。
- Markdown 语法高亮异步/按需加载（shiki 按语言分包）。

---

## 9. 生命周期状态机

### 9.1 消息级

```
time.pending ──▶ time.streaming ──▶ time.completed
  (排队)       (首token到达)        (finish_reason=stop)
                   ├──▶ error    → 渲染 Error 行
                   └──▶ aborted  → "interrupted" 分割线 + Retry 行（可重试）
```

- UI 判定"忙碌中"：`time.streaming != null && time.completed == null`。
- aborted 与 error 区分：aborted 是用户主动打断，给 Retry；error 是运行失败，给错误详情。

### 9.2 工具 Part 级

```
pending ──▶ running ──▶ completed
   (排队)    (执行中:    (成功: 显示标题摘要, 折叠)
             spinner)      └──▶ error (自动展开高亮 + 错误文本)
```

### 9.3 会话级

- 会话可被压缩（compaction）：旧上下文摘要化，UI 插入 "compaction" 分割线提示上下文已折叠。
- 会话支持**分叉/回滚**：`session.parentID` / `revertToID` 字段实现 revert 到历史节点（磁盘上同一会话目录内完成）。

---

## 10. 持久化设计

### 10.1 目录结构（事件驱动实时落盘）

```
<dataRoot>/storage/instance-<N>/storage/ses_<sessionID>/
  ├─ session.json                    # 会话元数据: {id, title, time, parentID, revertToID}
  └─ message/
      ├─ msg_<messageID>.json        # 每条消息一个文件（含 time/tokens/cost/parts）
      └─ msg_<messageID>/
          └─ part_<partID>.json      # 每个 part 单独一个文件（可选，大 part 拆出）
```

### 10.2 规则

- 每个持久事件（message.updated / part.updated / removed）实时写对应 JSON 文件，**不做定时批量**——保证崩溃后最多丢瞬态 delta，不丢结构。
- 启动时扫描目录重建消息列表（按文件内 time 排序），实现**断点重放**。
- 瞬态 `message.part.delta` **不落盘**。
- 辅助 SQLite（如 session.db）只存轻量映射（如 agent↔session），消息本体一律 JSON 文件。
- 每条消息落盘 `tokens/cost`，供 UI 逐条显示成本。

---

## 11. 交互细节清单

- [ ] 所有折叠行（reasoning / tool / ContextToolGroup）点击整行切换展开态，展开态记入本地状态（按 partID 记忆）
- [ ] 工具 error 自动展开；用户手动收起后不再强制展开
- [ ] edit/write 展开态支持手动修正 diff 并"重新应用"
- [ ] Retry 行点击 = 以同参数重发该轮
- [ ] 设置项 `showReasoning`：关闭时 reasoning Part 完全不渲染（连折叠行都没有）
- [ ] 流式中自动吸底滚动；用户向上滚动时暂停吸底，回到底部时恢复
- [ ] 每条助手消息尾部展示 tokens/cost 徽标

---

## 12. 验收清单（实现完成后逐条自测）

**功能**
- [ ] 发送消息 → 出现 Thinking 占位 → 思考折叠行(首行12字+…) → 正文流式平滑输出 → 完成
- [ ] 工具调用：折叠行 spinner → 完成显示标题；展开可见参数与 JSON 美化输出
- [ ] 连续多次 glob/grep 合并为一行计数组，展开见明细
- [ ] 工具报错自动展开高亮
- [ ] 中途打断显示 interrupted + Retry，点击可重试
- [ ] read/bash/edit/write/task/ask/todo 使用专属渲染器，未知工具回退 BasicTool
- [ ] step-start/snapshot 不产生任何 DOM

**性能**
- [ ] 单条 10k token 长输出流式期间不掉帧（delta 缓冲 + 节流生效）
- [ ] 单条 100KB 工具输出默认折叠，展开前不挂载内容 DOM
- [ ] 500+ 消息会话滚动流畅（虚拟滚动生效，若实现）

**持久化**
- [ ] 对话中途杀进程重启，时间线完整恢复（不含未完成流的尾部增量）
- [ ] 每条消息的 tokens/cost 重启后仍可显示

---

## 13. 实施阶段建议

| 阶段 | 内容 | 产出 |
|------|------|------|
| P1 | 数据模型 + 事件协议 + store（含 delta 缓冲与节流） | 消息流可驱动一个纯文本列表 |
| P2 | constructTimelineRows + 折叠规则 + BasicTool | 正文/思考/工具折叠行可用 |
| P3 | 工具专属渲染器注册表 + ContextToolGroup 合并 + 错误/打断/Retry | 完整交互 |
| P4 | 持久化落盘 + 启动重放 + PacedMarkdown/虚拟滚动打磨 | 生产可用 |

---

*文档结束。实现时如有歧义，以第 5/6/8 节的伪代码与规则表为准。*
