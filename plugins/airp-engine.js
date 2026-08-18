// airp-engine: AIRP 预设的引擎插件。
//
// 提供三件能力，全部与世界设定无关：
//   1. `world_run` 工具      —— 持久 JavaScript 执行环境（vm 上下文，按会话分键）。
//      跨调用保留全局函数（源码落盘）与全局对象 `state`（JSON 落盘），
//      每次执行只返回 state 的变化 diff，供模型确认更新并据此叙事；
//      查看具体字段用 return 返回（例如 return state.hp），
//      调试与批量输出用 print(...)（安全序列化，循环引用不炸）。
//      命名钩子（hooks.add/remove/list/order/clear，源码与顺序落盘随会话恢复）在每次
//      用户代码成功后、state diff 前自动按序运行：变量约束与阈值提醒
//      （钩子内 print 即提醒），单钩子出错只回滚它自己的改动并记录。
//      执行是原子的：用户代码出错自动整体回滚（state/钩子/函数定义）；
//      传 dry:true 试运行——返回完整结果但一切变化不生效，供复杂更新前排错。
//      状态持久化双通道：`.airp/` 文件（兜底/调试）+ `airp/state` 会话日志事件
//      （log-only、ignorable，随 fork 切片被分支精确继承；需 dsh-session 补丁，
//      未打补丁自动退化为仅文件）。
//   2. `present_options` 工具 —— 阻塞式回合交接。通过宿主 userQuestions 服务
//      弹出选择卡片（0–4 个选项 + 自由输入框；0 个选项 = 纯文本输入），
//      挂起直到玩家点选或输入，答案直接作为工具结果返回，模型同一回合内继续
//      推进游戏。无 UI 环境（headless/子代理）或玩家取消时回退为非阻塞模式：
//      exec.concludeTurn() 结束回合，等玩家的普通消息。执行时顺手把历史中
//      更早的 present_options 调用参数洗成 {"options":[]}（surfaceOp replace），
//      使未被选择的旧选项从模型视野中消失。
//   3. turn-stopping 守卫      —— 选项模式下，回合即将关闭却没有 present_options
//      调用时，steer 一次提醒补交（每回合最多一次，防止死循环）。
//   4. 选项模式开关（/options 命令）—— 玩家可用 /options on|off（缺省为切换）
//      在「选项卡片」与「自由对话」两种交接模式间切换。模式按会话持久化
//      （airp/mode 日志事件 + .airp/<session>.mode.json 双写；缺省取本插件配置的
//      optionCards），分支随事件流继承；切换时通过 agent.inject() 注入一条持久的
//      模式指令消息（不唤醒回合），模型下一轮请求即可看到。自由对话模式下：
//      present_options 不再弹卡片，返回纠正文案并 concludeTurn()；
//      回合守卫自动停用（该模式下本就不需要工具交接）。
//   5. 取消/中断的上下文修复 —— 玩家取消作答（或进程中断）时，把悬空的
//      present_options 调用块从 assistant 消息中剔除（surfaceOp replace 为纯文本版），
//      强制提交/崩溃修复器合成的 tool 结果随即替换为一条极简用户注释。
//      模型视野中该调用彻底消失，回合自然退化为普通叙事；同时清理 DSH 崩溃修复器
//      受 replace 副本误导生成的多余 TOOL_NOT_STARTED 结果（其位置不与任何
//      tool_calls 相邻，会导致之后每个请求被 provider 400 拒绝）。
//
// 本插件只消费宿主服务（tools、agents），不发布任何服务，因此无需 isolate realm。
// 不 import 任何 @deepseek-ai 包（预设目录不在 harness 的 node_modules 解析链上），
// 工具定义按 ToolDefinition 形状手工构造。

import vm from 'node:vm'
import fs from 'node:fs/promises'
import path from 'node:path'

const name = 'airp-engine'
const inject = ['tools', 'agents']

const OPTIONS_TOOL = 'present_options'
const SANITIZED_ARGUMENTS = '{"options":[]}'
const DIFF_ENTRY_CAP = 60
const VM_TIMEOUT_MS = 10000
const ASYNC_TIMEOUT_MS = 30000
const LOG_LINE_CAP = 2000
const LOG_COUNT_CAP = 100

/** 循环引用安全的序列化：函数→源码，BigInt→`123n`，循环引用→'[Circular]'。 */
function safeStringify(value) {
  const seen = new WeakSet()
  try {
    const text = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return `${v}n`
      if (typeof v === 'function') {
        try { return Function.prototype.toString.call(v) } catch { return '[function]' }
      }
      if (v !== null && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    })
    return text === undefined ? String(value) : text
  } catch {
    try { return String(value) } catch { return '[unprintable]' }
  }
}

/** print/console 的单个参数转文本：字符串原样，函数→源码，其余走安全序列化。 */
function printPart(p) {
  if (typeof p === 'string') return p
  if (typeof p === 'function') {
    try { return Function.prototype.toString.call(p) } catch { return '[function]' }
  }
  if (p === undefined) return 'undefined'
  if (typeof p === 'bigint') return `${p}n`
  return safeStringify(p)
}

/** 写入当次日志（带行数与行长上限，防止巨型输出撑爆上下文）。 */
function pushLog(logs, text) {
  if (!logs.current) return
  if (logs.current.length >= LOG_COUNT_CAP) {
    if (logs.current.length === LOG_COUNT_CAP) logs.current.push('（日志过多，后续输出已省略）')
    return
  }
  logs.current.push(text.length > LOG_LINE_CAP ? `${text.slice(0, LOG_LINE_CAP)}…（截断）` : text)
}

// ── 持久执行环境（按会话分键） ──────────────────────────────────────────────

/** sessionId -> { context, sandbox, cwd, persisted } */
const runtimes = new Map()

function isJsonSafe(value) {
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

function snapshotState(state) {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(state ?? {})) }
  } catch {
    return { ok: false }
  }
}

/** 递归比较两个 JSON 快照，产出有界 diff 条目列表。 */
function diffJson(before, after, base = '', out = []) {
  if (out.length >= DIFF_ENTRY_CAP) return out
  if (JSON.stringify(before) === JSON.stringify(after)) return out
  const beforeObj = before !== null && typeof before === 'object'
  const afterObj = after !== null && typeof after === 'object'
  if (!beforeObj || !afterObj || Array.isArray(before) !== Array.isArray(after)) {
    out.push({ path: base || '(root)', kind: 'changed', from: before, to: after })
    return out
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of [...keys].sort()) {
    if (out.length >= DIFF_ENTRY_CAP) break
    const p = base ? `${base}.${key}` : key
    if (!(key in before)) out.push({ path: p, kind: 'added', to: after[key] })
    else if (!(key in after)) out.push({ path: p, kind: 'removed', from: before[key] })
    else diffJson(before[key], after[key], p, out)
  }
  return out
}

/** 收集 sandbox 中模型定义的全局函数源码（注入键除外）。 */
function collectLib(sandbox, injectedKeys) {
  const lib = {}
  for (const key of Object.getOwnPropertyNames(sandbox)) {
    if (injectedKeys.has(key)) continue
    const value = sandbox[key]
    if (typeof value === 'function') {
      try { lib[key] = Function.prototype.toString.call(value) } catch { /* 跳过 */ }
    }
  }
  return lib
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

async function runtimeFor(agent) {
  const sessionId = agent.session.id
  const existing = runtimes.get(sessionId)
  if (existing) return existing

  const cwd = agent.session.header?.cwd
  const sandbox = {}
  const injectedKeys = new Set(['state', 'console', 'print', 'hooks'])
  const logs = { current: null }
  const consoleShim = {}
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    consoleShim[method] = (...parts) => pushLog(logs, parts.map(printPart).join(' '))
  }
  // 命名自动钩子：name → 函数源码。Map 插入顺序即执行顺序；
  // 源码随 .airp/<session>.hooks.json 落盘，恢复时重新编译校验。
  const hooks = new Map()
  sandbox.state = {}
  sandbox.console = consoleShim
  // print：唯一输出通道。用户代码与钩子共用，输出随当次结果的日志返回。
  sandbox.print = (...parts) => pushLog(logs, parts.map(printPart).join(' '))
  sandbox.hooks = {
    add(hookName, fn) {
      if (typeof hookName !== 'string' || hookName.length === 0) {
        throw new Error('hooks.add: 钩子名必须是非空字符串')
      }
      if (typeof fn !== 'function') throw new Error(`hooks.add(${JSON.stringify(hookName)}): 第二个参数必须是函数`)
      let source
      try { source = Function.prototype.toString.call(fn) } catch {
        throw new Error(`hooks.add(${JSON.stringify(hookName)}): 无法读取函数源码`)
      }
      const replaced = hooks.has(hookName)
      // 覆盖语义：同名只更新逻辑、保留原执行位置；
      // 换位置用 hooks.order(...) 显式表达，两个动作正交。
      hooks.set(hookName, source)
      const msg = `钩子 ${JSON.stringify(hookName)} 已${replaced ? '覆盖（保持原执行位置）' : '注册'}（共 ${hooks.size} 个），将在每次 world_run 执行后、state diff 前自动运行。`
      pushLog(logs, msg)
      return msg
    },
    remove(hookName) {
      const removed = hooks.delete(hookName)
      pushLog(logs, removed ? `钩子 ${JSON.stringify(hookName)} 已删除。` : `钩子 ${JSON.stringify(hookName)} 不存在。`)
      return removed
    },
    // list 的返回顺序即执行顺序（明文契约）。
    list() { return [...hooks.entries()].map(([hookName, source]) => ({ name: hookName, source })) },
    // 重排执行顺序：列出的钩子按给定顺序排前，未列出的保持相对顺序跟在后面；
    // 未知名字与重复名字报错（防笔误）。顺序随 hooks.json 一并持久化。
    order(names) {
      if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
        throw new Error('hooks.order: 参数必须是钩子名数组，例如 hooks.order(["a", "b"])')
      }
      const unknown = names.filter((n) => !hooks.has(n))
      if (unknown.length > 0) {
        throw new Error(`hooks.order: 未知钩子 ${unknown.map((n) => JSON.stringify(n)).join(', ')}（当前：${[...hooks.keys()].join(', ') || '无'}）`)
      }
      const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
      if (dup.length > 0) {
        throw new Error(`hooks.order: 名单中重复 ${dup.map((n) => JSON.stringify(n)).join(', ')}`)
      }
      const rest = [...hooks.keys()].filter((k) => !names.includes(k))
      const seq = [...names, ...rest]
      const entries = seq.map((k) => [k, hooks.get(k)])
      hooks.clear()
      for (const [k, v] of entries) hooks.set(k, v)
      const msg = `钩子执行顺序已更新：${seq.join(' → ') || '（无钩子）'}`
      pushLog(logs, msg)
      return msg
    },
    clear() {
      const n = hooks.size
      hooks.clear()
      pushLog(logs, `已清空 ${n} 个钩子。`)
      return n
    },
  }
  vm.createContext(sandbox)

  const rt = { context: sandbox, sandbox, cwd, logs, hooks, injectedKeys, stateFile: null, libFile: null, hooksFile: null }
  if (cwd) {
    const dir = path.join(cwd, '.airp')
    rt.stateFile = path.join(dir, `${sessionId}.state.json`)
    rt.libFile = path.join(dir, `${sessionId}.lib.json`)
    rt.hooksFile = path.join(dir, `${sessionId}.hooks.json`)
    // 恢复顺序：优先本会话事件流中最后一条 airp/state（fork 切片自动携带、
    // 分支点精确）；旧会话没有该事件，回退读 .airp/ 三件套——自身文件不存在时
    // （分支自旧格式会话）再回退父会话的文件（过渡期近似：父的当前状态可能
    // 领先分支点，父下次提交后事件通道接管即恢复精确）。
    const fromLog = lastStateEvent(agent.session)
    if (fromLog) {
      hydrateRuntime(rt, fromLog)
    } else {
      const lib = (await readJsonSafe(rt.libFile)) ?? (await readJsonSafe(parentFileFor(agent, 'lib')))
      const state = (await readJsonSafe(rt.stateFile)) ?? (await readJsonSafe(parentFileFor(agent, 'state')))
      const savedHooks = (await readJsonSafe(rt.hooksFile)) ?? (await readJsonSafe(parentFileFor(agent, 'hooks')))
      hydrateRuntime(rt, { state, lib, hooks: savedHooks })
      // 领养即钉住：立即以本会话 id 落盘并写入状态事件，避免父继续前进后
      // 本分支重复领养到"未来"状态，也让本分支之后的 fork 有事件可继承。
      if (state || lib || savedHooks) {
        try {
          await persistRuntime(rt, agent.session)
        } catch (error) {
          console.error('[airp-engine] 领养快照落盘失败：', error)
        }
      }
    }
  }
  runtimes.set(sessionId, rt)
  return rt
}

/** 把 { state, lib, hooks } 水合进运行时：先重放函数源码，再恢复 state 与钩子源码。 */
function hydrateRuntime(rt, saved) {
  const { sandbox, hooks } = rt
  if (saved?.lib && typeof saved.lib === 'object') {
    for (const [key, source] of Object.entries(saved.lib)) {
      if (typeof source !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) continue
      try { vm.runInContext(`globalThis[${JSON.stringify(key)}] = (${source})`, sandbox, { timeout: 5000 }) } catch { /* 跳过损坏条目 */ }
    }
  }
  // 事件来源的 state 被 session.append 深度冻结，必须克隆为可变副本再挂载，
  // 否则用户代码对 state 的赋值会被静默吞掉（非严格模式）。文件来源无此问题。
  if (saved?.state && typeof saved.state === 'object' && !Array.isArray(saved.state)) {
    const snap = snapshotState(saved.state)
    if (snap.ok) sandbox.state = snap.value
  }
  if (saved?.hooks && typeof saved.hooks === 'object') {
    for (const [hookName, source] of Object.entries(saved.hooks)) {
      if (typeof source !== 'string') continue
      try {
        const fn = vm.runInContext(`(${source})`, sandbox, { timeout: 5000 })
        if (typeof fn === 'function') hooks.set(hookName, source)
      } catch { /* 跳过损坏条目 */ }
    }
  }
}

// ── 会话日志内状态事件（方案 A：状态随 fork 切片自动携带） ──────────────────
//
// world_run 每次提交后把 { turn, state, lib, hooks } 作为 airp/state log-only
// 事件写入会话日志（不进 surface/模型上下文/UI）。恢复时取本会话事件流中最后
// 一条：fork 按边界切片 → 分支点精确状态；重启 → 最新；随会话导出/删除。
// 事件携带 ignorable: true，需要 dsh-session 的本地补丁（append 透传 ignorable）；
// 未打补丁时自动退化为仅 .airp/ 文件持久化（分支不继承状态），功能不受影响。
// mode 同理走 airp/mode 事件。旧会话无事件时回退读文件，文件保持双写兜底。

/** 进程级缓存：append 是否透传 ignorable（本地补丁存在与否）。 */
let ignorableSupport

function supportsIgnorableEvents(session) {
  if (ignorableSupport === undefined) {
    try {
      ignorableSupport = typeof session.append === 'function' && session.append.toString().includes('ignorable')
    } catch {
      ignorableSupport = false
    }
    if (!ignorableSupport) {
      console.warn('[airp-engine] 当前 dsh-session 未包含 ignorable 补丁，状态仅写入 .airp/ 文件（分支不继承）。')
    }
  }
  return ignorableSupport
}

/** 当前回合号：事件流中最后一条 turn/start 的 turn；无则 0。 */
function currentTurn(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event.type === 'turn/start') return event.data.turn
  }
  return 0
}

/** 事件流中最后一条 airp/state 事件的数据；无则 undefined。 */
function lastStateEvent(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event.type === 'airp/state') return event.data
  }
  return undefined
}

/** 事件流中最后一条 airp/mode 事件的 optionCards；无则 undefined。 */
function lastModeEvent(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event.type === 'airp/mode' && typeof event.data?.optionCards === 'boolean') return event.data.optionCards
  }
  return undefined
}

async function persistRuntime(rt, session) {
  if (!rt.stateFile) return false
  const state = snapshotState(rt.sandbox.state)
  if (!state.ok) return false
  const lib = collectLib(rt.sandbox, rt.injectedKeys)
  const hooks = Object.fromEntries(rt.hooks)
  await fs.mkdir(path.dirname(rt.stateFile), { recursive: true })
  await fs.writeFile(rt.stateFile, JSON.stringify(state.value, null, 2), 'utf8')
  await fs.writeFile(rt.libFile, JSON.stringify(lib, null, 2), 'utf8')
  await fs.writeFile(rt.hooksFile, JSON.stringify(hooks, null, 2), 'utf8')
  // 方案 A：状态随会话日志（fork 自动继承）。文件保持双写作为兜底与调试入口。
  if (session && supportsIgnorableEvents(session)) {
    try {
      session.append('airp/state', { turn: currentTurn(session), state: state.value, lib, hooks }, { ignorable: true })
    } catch (error) {
      console.error('[airp-engine] 状态事件写入失败（文件已落盘，本会话不受影响）：', error)
    }
  }
  return true
}

// ── 运行时快照/恢复（原子执行与试运行的共同基础） ──────────────────────────

/** 快照：state 深拷贝 + 钩子注册表 + 全局函数源码 + 全局键列表。state.ok=false 时无法回滚。 */
function snapshotRuntime(rt) {
  return {
    state: snapshotState(rt.sandbox.state),
    hooks: [...rt.hooks.entries()],
    lib: collectLib(rt.sandbox, rt.injectedKeys),
    keys: new Set(Object.getOwnPropertyNames(rt.sandbox)),
  }
}

/** 恢复：重挂 state、还原钩子注册表、删除新增全局、还原被覆盖/删除的全局函数。 */
function restoreRuntime(rt, snap) {
  if (snap.state.ok) rt.sandbox.state = snap.state.value
  rt.hooks.clear()
  for (const [k, v] of snap.hooks) rt.hooks.set(k, v)
  for (const key of Object.getOwnPropertyNames(rt.sandbox)) {
    if (!snap.keys.has(key)) { try { delete rt.sandbox[key] } catch { /* 忽略 */ } }
  }
  for (const [key, source] of Object.entries(snap.lib)) {
    const current = rt.sandbox[key]
    let currentSource
    try { currentSource = typeof current === 'function' ? Function.prototype.toString.call(current) : undefined } catch { /* 忽略 */ }
    if (currentSource !== source) {
      try { vm.runInContext(`globalThis[${JSON.stringify(key)}] = (${source})`, rt.context, { timeout: 5000 }) } catch { /* 忽略 */ }
    }
  }
}

/** ReferenceError 自愈提示：引导模型把局部声明改为全局函数定义。 */
function undefinedNameHint(message) {
  const m = /(\S+) is not defined/.exec(message)
  return m
    ? `（提示：${m[1]} 未定义。程序体内的 function/const/let 声明都是局部的、调用结束即消失；跨调用或钩子要引用的辅助函数请定义为全局函数：globalThis.${m[1]} = ...）`
    : ''
}

async function runProgram(rt, program, dry, session) {
  const snap = snapshotRuntime(rt)
  const before = snap.state
  const logs = []
  rt.logs.current = logs
  let value
  let error
  let rolledBack = false
  try {
    const wrapped = `(async () => {\n${program}\n})()`
    const result = vm.runInContext(wrapped, rt.context, { timeout: VM_TIMEOUT_MS, filename: 'world_run.js' })
    let timer
    try {
      value = await Promise.race([
        Promise.resolve(result),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`异步执行超过 ${ASYNC_TIMEOUT_MS / 1000} 秒`)), ASYNC_TIMEOUT_MS) }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (value !== undefined && !isJsonSafe(value)) {
      error = 'return 的值不是可 JSON 序列化的数据；如需查看复杂对象请先用 JSON.stringify 转换'
      value = undefined
    }
  } catch (e) {
    const msg = String((e && e.message) || e)
    error = msg + undefinedNameHint(msg)
  }
  const hookErrors = []
  if (error) {
    // 原子执行：用户代码出错 → 整体回滚（state、钩子注册表、本次新增/覆盖的全局函数），
    // 不留下半更新的状态；state 已回滚，钩子无中间态可钳制，故不再执行。
    if (before.ok) {
      restoreRuntime(rt, snap)
      rolledBack = true
    }
  } else {
    // 自动钩子：用户代码成功之后、state diff 之前，按注册顺序执行。
    // 钩子级原子：单钩子出错只回滚它自己的改动并记录，不影响其余钩子与用户代码的成果；
    // 钩子内的 print 与用户代码共用当次日志（提醒即日志）。
    // 注意先拷贝条目再迭代：钩子可能注册新钩子，出错回滚也会重建注册表，
    // 直接迭代 rt.hooks 会把删除后重插的条目当作新条目反复访问（死循环）。
    for (const [hookName, source] of [...rt.hooks.entries()]) {
      const hookSnap = snapshotRuntime(rt)
      try {
        const fn = vm.runInContext(`(${source})`, rt.context, { timeout: VM_TIMEOUT_MS, filename: `hook-${hookName}.js` })
        if (typeof fn !== 'function') throw new Error('钩子源码编译结果不是函数')
        let timer
        try {
          await Promise.race([
            Promise.resolve(fn()),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`异步执行超过 ${ASYNC_TIMEOUT_MS / 1000} 秒`)), ASYNC_TIMEOUT_MS) }),
          ])
        } finally {
          clearTimeout(timer)
        }
      } catch (e) {
        const msg = String((e && e.message) || e)
        hookErrors.push(`${hookName}：${msg}${undefinedNameHint(msg)}（该钩子的改动已回滚）`)
        restoreRuntime(rt, hookSnap)
      }
    }
  }
  rt.logs.current = null
  if (!before.ok) {
    error = (error ? `${error}\n` : '') + 'state 在执行前已含不可 JSON 序列化的内容（循环引用？），本次变化无法追踪，出错时也无法回滚'
  }
  // diff 在恢复之前计算：试运行也要展示「假如提交」的完整变化。
  const after = snapshotState(rt.sandbox.state)
  const diff = before.ok && after.ok ? diffJson(before.value, after.value) : []
  let persisted
  if (dry) {
    // 试运行：无条件恢复到执行前，不落盘（state、钩子注册、函数定义全部还原）。
    restoreRuntime(rt, snap)
    persisted = true // 不触发「仅内存」提示，由 dry 标注替代
  } else {
    persisted = await persistRuntime(rt, session)
  }
  return { value, logs, diff, error, hookErrors, persisted, rolledBack, dry: dry === true }
}

function formatRunResult(r) {
  const parts = []
  if (r.error) parts.push(`执行出错：${r.error}`)
  if (r.value !== undefined) parts.push(`返回值：${JSON.stringify(r.value)}`)
  if (r.logs.length > 0) parts.push(`日志：\n${r.logs.join('\n')}`)
  if (r.diff.length > 0) {
    const lines = r.diff.map((d) => {
      if (d.kind === 'added') return `  + ${d.path} = ${JSON.stringify(d.to)}`
      if (d.kind === 'removed') return `  - ${d.path}（原 ${JSON.stringify(d.from)}）`
      return `  ~ ${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`
    })
    parts.push(`state 变化：\n${lines.join('\n')}`)
  } else if (!r.error) {
    parts.push('state 无变化。')
  }
  if (r.hookErrors.length > 0) parts.push(`钩子错误：\n${r.hookErrors.map((e) => `  - ${e}`).join('\n')}`)
  if (r.rolledBack) parts.push('已回滚：执行出错，state、钩子注册与函数定义均已恢复到执行前，未留下半更新。')
  if (r.dry) parts.push('（试运行：以上变化、钩子注册与函数定义均未生效。）')
  else if (!r.persisted) parts.push('（注意：本会话无工作目录，状态仅保留在内存中，进程重启后丢失。）')
  return parts.join('\n\n')
}

// ── 旧选项剪枝（surfaceOp replace） ─────────────────────────────────────────

/**
 * 把历史中更早的 present_options 调用参数洗成 {"options":[]}。
 * 当前调用（currentCallId）保持完整——它的选项正要展示给玩家。
 * 叙事正文与调用同住一个 assistant 节点，因此只改 tool-call 块的 arguments，
 * 保留节点与 callId 配对。
 */
function sanitizeOlderOptions(session, currentCallId) {
  let pruned = 0
  const liveNodes = new Set(session.surface.nodes)
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue
    if (!liveNodes.has(event.seq)) continue
    const content = event.data.message?.content
    if (!Array.isArray(content)) continue
    let dirty = false
    const newContent = content.map((block) => {
      if (
        block && block.type === 'tool-call' &&
        block.name === OPTIONS_TOOL &&
        block.id !== currentCallId &&
        block.arguments !== SANITIZED_ARGUMENTS
      ) {
        dirty = true
        return { ...block, arguments: SANITIZED_ARGUMENTS }
      }
      return block
    })
    if (!dirty) continue
    const message = { ...event.data.message, content: newContent }
    session.append('assistant/message', { ...event.data, message }, {
      surfaceOp: { op: 'replace', start: event.seq, end: event.seq },
      sourceEventSeqs: [event.seq],
    })
    pruned++
  }
  return pruned
}

// ── 选项模式开关（/options 命令 + 按会话持久化） ─────────────────────────────

/** 切换为自由对话模式时注入会话的持久指令（agent.inject：不唤醒，下一次请求可见）。 */
const MODE_INJECT_OFF =
  '选项卡片模式已关闭（玩家使用 /options 命令切换）：从现在起不要再调用 present_options。' +
  '每轮回复以纯叙事结尾，叙事完成后直接停止输出，回合到此为止，等待玩家以普通消息描述行动。' +
  '若你刚才习惯性地调用了 present_options，忽略其结果，按新模式继续。'
/** 切换回选项卡片模式时注入会话的持久指令。 */
const MODE_INJECT_ON =
  '选项卡片模式已开启（玩家使用 /options 命令切换）：从现在起，每轮回复结束后调用 present_options，' +
  '给出 0–4 个简明、互不重叠的行动选项把行动权交给玩家；玩家的选择作为工具结果返回后，你在同一回合内继续推进。'
/** 自由对话模式下模型仍调用 present_options 时的纠正文案（作为工具结果返回，自愈式纠错）。 */
const PLAIN_MODE_TOOL_REPLY =
  '选项卡片模式当前已关闭（玩家通过 /options 命令切换）。不要再调用本工具：直接以纯叙事结尾并停止输出，' +
  '等待玩家以普通消息行动。若玩家想恢复选项卡片，可输入 /options on。'

/**
 * 新会话的默认模式，由 apply 用插件配置（optionCards，缺省 true）赋值。
 * 模块级是因为模式存储本身也是模块级的；同一预设挂载的多个会话共享同一份配置，
 * 且已持久化模式的会话恢复时以 .airp/<id>.mode.json 为准，不读此默认值。
 */
let defaultOptionCards = true

/** sessionId -> Promise<boolean>。懒加载：优先读持久化文件，缺省取 defaultOptionCards。 */
const modes = new Map()

function modeFileFor(agent) {
  const cwd = agent.session.header?.cwd
  return cwd ? path.join(cwd, '.airp', `${agent.session.id}.mode.json`) : null
}

/** 父会话（fork 来源）的 .airp/ 文件路径；无血统或无 cwd 时返回 null。 */
function parentFileFor(agent, kind) {
  const parent = agent.session.header?.parentSession
  const cwd = agent.session.header?.cwd
  return parent && cwd ? path.join(cwd, '.airp', `${parent}.${kind}.json`) : null
}

async function loadMode(agent) {
  // 优先本会话事件流中的 airp/mode（fork 自动继承）；旧会话回退读文件，
  // 自身文件不存在时（分支自旧格式会话）再回退父会话的文件。
  const fromLog = lastModeEvent(agent.session)
  if (typeof fromLog === 'boolean') return fromLog
  for (const file of [modeFileFor(agent), parentFileFor(agent, 'mode')]) {
    if (!file) continue
    const saved = await readJsonSafe(file)
    if (typeof saved?.optionCards === 'boolean') return saved.optionCards
  }
  return defaultOptionCards
}

/** 当前会话是否处于选项卡片模式。 */
function modeFor(agent) {
  const sessionId = agent.session.id
  let pending = modes.get(sessionId)
  if (!pending) {
    pending = loadMode(agent)
    modes.set(sessionId, pending)
  }
  return pending
}

/** 切换模式：更新内存、持久化（airp/mode 事件 + 文件双写）、注入模式指令。 */
async function setMode(agent, enabled) {
  modes.set(agent.session.id, Promise.resolve(enabled))
  if (supportsIgnorableEvents(agent.session)) {
    try {
      agent.session.append('airp/mode', { optionCards: enabled }, { ignorable: true })
    } catch (error) {
      console.error('[airp-engine] 模式事件写入失败：', error)
    }
  }
  const file = modeFileFor(agent)
  if (file) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify({ optionCards: enabled }, null, 2), 'utf8')
    } catch (error) {
      console.error('[airp-engine] 模式持久化失败（仅内存生效）：', error)
    }
  }
  const text = enabled ? MODE_INJECT_ON : MODE_INJECT_OFF
  try {
    agent.inject({
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
    })
  } catch (error) {
    console.error('[airp-engine] 模式指令注入失败：', error)
  }
}

// ── 取消/中断的上下文修复（零痕迹移除悬空调用，注释兜底） ─────────────────────
//
// 背景：present_options 阻塞等待作答期间，玩家取消或进程中断会让日志停在
// tool/call 之后（结果未落盘）。DSH 的崩溃修复器在下次加载时会给悬空调用补一条
// 冗长的英文合成结果；且修复器不理解 surface 的 replace 语义，会把剪枝器替换副本
// 中早已被回答的旧调用重复登记为悬空，合成出多余的 TOOL_NOT_STARTED 结果——
// 其位置不与任何 assistant tool_calls 相邻，导致之后每个请求被 provider 400 拒绝。
//
// DSH 的 surface 只有 append/replace 两种写法和"一个节点替换一个区间"的语义，
// 没有纯删除——但 replace 允许一个节点吞掉一个区间，本模块借此实现零痕迹移除：
//   1. 合并：把 [含调用的 assistant 消息, 其 tool 结果] 区间一次性 replace 为剔除
//      该 tool-call 块的纯文本 assistant 消息——模型视野中只剩叙事，调用从未存在；
//   2. 吞并：删除孤儿 tool 结果时，把 [前驱节点, 目标] replace 为前驱的克隆——
//      等于原样重发前驱、吞掉目标，效果即删除；
//   3. 兜底：以上条件不满足（不紧邻、前驱不可克隆等）时，退化为 剔除 + 极简注释。

/** DSH 崩溃修复器合成结果携带的错误码。 */
const REPAIR_CODES = new Set(['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED'])
/** 兜底：替代中断残留的极简用户注释。 */
const CANCEL_NOTE = '（选择卡片在作答前被取消/中断，视为玩家未作答；请忽略该处，直接继续。）'
/** 取消时 present_options 提交的极简结果文本（提交后随即被合并移除或替换为注释）。 */
const CANCEL_RESULT_TEXT = '（玩家取消了本次选择。）'

/**
 * 在 surface 上找到包含指定 tool-call 块的 assistant 消息，返回其 seq 与剔除该块后
 * 的事件数据（叙事保留；剔除后无内容块则补占位文本，避免空消息）。找不到返回 null。
 */
function findStrippedAssistant(session, callId, liveNodes) {
  for (const event of session.events) {
    if (event.type !== 'assistant/message' || !liveNodes.has(event.seq)) continue
    const content = event.data.message?.content
    if (!Array.isArray(content)) continue
    if (!content.some((b) => b?.type === 'tool-call' && b.id === callId)) continue
    const stripped = content.filter((b) => !(b?.type === 'tool-call' && b.id === callId))
    const message = { ...event.data.message, content: stripped.length > 0 ? stripped : [{ type: 'text', text: '……' }] }
    return { seq: event.seq, data: { ...event.data, message } }
  }
  return null
}

/** 兜底路径之一：单节点 replace，把 assistant 消息替换为剔除调用块的纯文本版。 */
function stripToolCallBlock(session, callId, liveNodes) {
  const found = findStrippedAssistant(session, callId, liveNodes)
  if (!found) return false
  session.append('assistant/message', found.data, {
    surfaceOp: { op: 'replace', start: found.seq, end: found.seq },
    sourceEventSeqs: [found.seq],
  })
  return true
}

/** 兜底路径之二：把一条 surface 上的 tool/result 事件 replace 成极简 user 注释。 */
function replaceResultWithNote(session, resultEvent, note) {
  session.append('user/message', {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: note }],
    source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text: note }] },
  }, {
    surfaceOp: { op: 'replace', start: resultEvent.seq, end: resultEvent.seq },
    sourceEventSeqs: [resultEvent.seq],
  })
}

/**
 * 零痕迹移除一次被取消/中断的调用：把 [assistant 消息, 其 tool 结果] 的 surface
 * 区间一次性 replace 为剔除调用块后的纯文本 assistant 消息（叙事吞掉调用与结果）。
 * 要求两者在 surface 上紧邻；不满足时返回 false，由调用方退化为 剔除 + 注释。
 */
function mergeCallIntoNarrative(session, assistantSeq, assistantData, resultSeq) {
  const nodes = session.surface.nodes
  const i = nodes.indexOf(assistantSeq)
  if (i === -1 || nodes[i + 1] !== resultSeq) return false
  session.append('assistant/message', assistantData, {
    surfaceOp: { op: 'replace', start: assistantSeq, end: resultSeq },
    sourceEventSeqs: [assistantSeq, resultSeq],
  })
  return true
}

/**
 * 零痕迹删除一个孤儿 tool 结果：把 [前驱节点, 目标] replace 为前驱的克隆
 * （原样重发前驱、吞掉目标，等效删除）。前驱不是可克隆的消息节点时退化为极简注释。
 */
function deleteOrphanResult(session, resultEvent, note) {
  const nodes = session.surface.nodes
  const idx = nodes.indexOf(resultEvent.seq)
  const prevSeq = idx > 0 ? nodes[idx - 1] : undefined
  const prev = prevSeq === undefined ? undefined : session.events.find((e) => e.seq === prevSeq)
  if (prev && (prev.type === 'user/message' || prev.type === 'assistant/message')) {
    session.append(prev.type, prev.data, {
      surfaceOp: { op: 'replace', start: prevSeq, end: resultEvent.seq },
      sourceEventSeqs: [prevSeq, resultEvent.seq],
    })
    return 'deleted'
  }
  replaceResultWithNote(session, resultEvent, note)
  return 'noted'
}

/**
 * 会话启动时的上下文修复，两遍扫描：
 *  第一遍（崩溃修复器残留）：
 *   - 合成结果是该调用的唯一结果 → 真正的中断：优先把调用与合成结果零痕迹合并进
 *     叙事（mergeCallIntoNarrative），不紧邻时退化为 剔除 + 注释；
 *   - 该调用早有正常结果 → 修复器受 replace 副本误导生成的冤案：零痕迹删除，
 *     失败退化为注释。
 *  第二遍（位置级配对扫描，与 provider 校验同构）：
 *   按 surface 顺序重放，凡不与紧邻前述 assistant tool_calls 配对的 tool 结果
 *   （冤案残留、取消清理失败留下的孤儿结果等一切形态）一律零痕迹删除或注释。
 * 注释事件不携带 error.code 且为 user/message，两遍扫描均天然幂等。
 * 目标已被压缩遮蔽时 replace 会抛错，跳过即可。
 */
function repairInterruptedHandoffs(session) {
  const liveNodes = new Set(session.surface.nodes)
  const resultsByCall = new Map()
  const synthetics = []
  for (const event of session.events) {
    if (event.type !== 'tool/result') continue
    const callId = event.data.message?.source?.callId
    if (!callId) continue
    const list = resultsByCall.get(callId)
    if (list) list.push(event)
    else resultsByCall.set(callId, [event])
    if (liveNodes.has(event.seq) && REPAIR_CODES.has(event.data.error?.code)) synthetics.push(event)
  }
  let fixed = 0
  for (const event of synthetics) {
    const callId = event.data.message.source.callId
    try {
      if ((resultsByCall.get(callId) ?? []).length === 1) {
        const found = findStrippedAssistant(session, callId, liveNodes)
        if (found && mergeCallIntoNarrative(session, found.seq, found.data, event.seq)) {
          fixed++
          continue
        }
        stripToolCallBlock(session, callId, liveNodes)
        replaceResultWithNote(session, event, CANCEL_NOTE)
      } else {
        deleteOrphanResult(session, event, CANCEL_NOTE)
      }
      fixed++
    } catch (error) {
      console.error('[airp-engine] 中断残留清理失败：', error)
    }
  }
  // 第二遍：位置级配对扫描（在第一遍之后重读 surface 与事件表）。
  const bySeq = new Map()
  for (const event of session.events) bySeq.set(event.seq, event)
  let pending = new Set()
  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (!event) continue
    if (event.type === 'assistant/message') {
      pending = new Set(
        (event.data.message?.content ?? [])
          .filter((b) => b?.type === 'tool-call')
          .map((b) => b.id),
      )
    } else if (event.type === 'tool/result') {
      const callId = event.data.message?.source?.callId
      if (callId && pending.has(callId)) {
        pending.delete(callId)
        continue
      }
      try {
        deleteOrphanResult(session, event, CANCEL_NOTE)
        fixed++
      } catch (error) {
        console.error('[airp-engine] 孤儿工具结果清理失败：', error)
      }
    }
    // user/message 到达时仍有未答调用属于"缺失结果"方向的损坏，目前无已知产生者，不处理。
  }
  // 第三遍：旧版本（注释方案）留下的极简注释尽量零痕迹回收——克隆前驱吞并；
  // 前驱不可克隆时保留（注释本身合法，只是多花十余 token）。仅匹配插件来源的
  // 精确注释文本，绝不会误伤玩家消息。
  {
    const bySeq2 = new Map()
    for (const event of session.events) bySeq2.set(event.seq, event)
    for (const seq of [...session.surface.nodes]) {
      const event = bySeq2.get(seq)
      if (!event || event.type !== 'user/message') continue
      const content = event.data.content ?? event.data.message?.content
      const text = Array.isArray(content) ? content.map((b) => b?.text ?? '').join('') : ''
      if (text !== CANCEL_NOTE || event.data.source?.kind !== 'plugin') continue
      try {
        const nodes = session.surface.nodes
        const idx = nodes.indexOf(seq)
        const prevSeq = idx > 0 ? nodes[idx - 1] : undefined
        const prev = prevSeq === undefined ? undefined : bySeq2.get(prevSeq)
        if (prev && (prev.type === 'user/message' || prev.type === 'assistant/message')) {
          session.append(prev.type, prev.data, {
            surfaceOp: { op: 'replace', start: prevSeq, end: seq },
            sourceEventSeqs: [prevSeq, seq],
          })
          fixed++
        }
      } catch (error) {
        console.error('[airp-engine] 旧注释回收失败：', error)
      }
    }
  }
  if (fixed > 0) console.log(`[airp-engine] 已清理 ${fixed} 条中断残留。`)
  return fixed
}

// ── 回合交接守卫 ────────────────────────────────────────────────────────────

const GUARD_REMINDER = '回合交接检查：你还没有调用 present_options 把行动权交给玩家。请现在调用它（0–4 个选项；0 个表示请玩家自由描述行动），然后等待玩家作答。'
/** sessionId -> 已 steer 过的回合号（每回合最多提醒一次，防止死循环） */
const steeredTurns = new Map()

function turnHasHandoff(session, turn) {
  return session.events.some((event) =>
    event.type === 'assistant/message' &&
    event.data.turn === turn &&
    Array.isArray(event.data.message?.content) &&
    event.data.message.content.some((block) => block?.type === 'tool-call' && block.name === OPTIONS_TOOL))
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

/**
 * 配置 schema（手写的 StandardSchema，预设目录不在 node_modules 解析链上，
 * 不 import schemastery）。字段：
 *   optionCards: boolean —— 新会话的初始交接模式，true（缺省）=选项卡片，
 *   false=自由对话。会话内 /options 命令的切换结果持久化后优先于此默认值。
 */
const Config = {
  '~standard': {
    version: 1,
    vendor: 'airp-engine',
    validate(value) {
      const input = value ?? {}
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: 'airp-engine 配置必须是对象' }] }
      }
      if (input.optionCards !== undefined && typeof input.optionCards !== 'boolean') {
        return { issues: [{ message: 'optionCards 必须是布尔值', path: ['optionCards'] }] }
      }
      return { value: { optionCards: input.optionCards !== false } }
    },
  },
}

function apply(ctx, config) {
  defaultOptionCards = config?.optionCards !== false

  // 取消/中断修复之一：加载时清理崩溃修复器留下的中断残留（session-start 在
  // 首个请求之前触发，resume 与新建都会经过）。
  ctx.on('agent/session-start', ({ agent }) => {
    try {
      repairInterruptedHandoffs(agent.session)
    } catch (error) {
      console.error('[airp-engine] 中断残留清理失败：', error)
    }
  })

  // 取消/中断修复之二：玩家取消时（execute 的 cancel 分支已把调用信息登记进
  // pendingDeletes），强制提交的 tool/result 一落盘，就把 [assistant 消息, 结果]
  // 区间一次性 replace 为纯文本叙事——模型视野中这次调用彻底消失、零痕迹。
  // 注意：session/event 在 append 发布栈内同步派发，栈内禁止再次 append
  // （"cannot reenter while another append is being published"），
  // 因此替换推迟到下一个事件循环节拍；回合已 concludeTurn，不存在竞争。
  const pendingDeletes = new Map()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'tool/result') return
    const callId = event.data?.message?.source?.callId
    if (!callId || !pendingDeletes.has(callId)) return
    const found = pendingDeletes.get(callId)
    pendingDeletes.delete(callId)
    setImmediate(() => {
      try {
        if (mergeCallIntoNarrative(session, found.seq, found.data, event.seq)) return
        // 兜底：剔除 + 极简注释（区间不紧邻等意外形态）。
        const liveNodes = new Set(session.surface.nodes)
        stripToolCallBlock(session, callId, liveNodes)
        replaceResultWithNote(session, event, CANCEL_NOTE)
      } catch (error) {
        console.error('[airp-engine] 取消结果清理失败：', error)
      }
    })
  })

  // /options 命令：注册进 commands 注册表（宿主服务，本插件作用域随预设按 agent
  // 分层，多个 AIRP 会话互不冲突）。commands 缺失的部署（如无界面主干）只是
  // 没有切换入口，其余功能不受影响。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'options',
      description: '开关选项卡片交接：/options on 恢复选择卡片，/options off 回退自由对话，缺省为切换',
      input: { hint: '[on|off]' },
      async handler({ agent, rawInput }) {
        const arg = rawInput.trim().toLowerCase()
        let next
        if (arg === '') next = !(await modeFor(agent))
        else if (arg === 'on') next = true
        else if (arg === 'off') next = false
        else return { kind: 'error', text: '用法：/options [on|off]（缺省为切换）' }
        const current = await modeFor(agent)
        if (next === current) {
          return { kind: 'success', text: `选项卡片模式本已${current ? '开启' : '关闭'}，无需切换。` }
        }
        await setMode(agent, next)
        return {
          kind: 'success',
          text: next
            ? '选项卡片模式已开启：将向 AI 注入模式指令，下一轮回复起恢复选择卡片交接。'
            : '选项卡片模式已关闭：将向 AI 注入模式指令，下一轮回复起以纯叙事结尾、等待你的普通消息。',
        }
      },
    })
  })

  ctx.tools.register({
    name: 'world_run',
    description:
      '在持久的 JavaScript 环境中执行一段代码，用于一切涉及数值与规则的判定与状态更新。' +
      '跨调用保留：全局函数与全局对象 state自动持久化。' +
      '约定：所有需要追踪的游戏数据放进 state；辅助函数必须定义为全局函数才能跨调用保留：' +
      '用 globalThis.foo = function...（或裸赋值 foo = ...）。注意：程序体内的 function foo(){}、const、let 声明都是本次调用的局部量，调用结束即消失；' +
      '钩子与后续调用只能引用 state、print、hooks 和全局函数。' +
      '代码作为 async 函数体执行，可用顶层 await/return。' +
      '输出：print(...值) 把任意值（可多个、含不可 JSON 化的对象）写入当次日志返回；return 返回单个值。注意return和钩子外的print会输出钩子执行前的值。钩子执行后的值会在state diff中自动返回' +
      '原子执行：代码出错时自动回滚到执行前（state、钩子注册、函数定义全部还原），不会留下半更新的状态。' +
      '排错：传 dry:true 试运行——照常执行并返回完整结果（含钩子效果与 diff），但一切变化不生效，适合复杂更新前确认效果。' +
      '自动钩子：hooks.add(名字, 函数) 注册后，每次执行成功后、生成 state diff 之前都会按注册顺序自动运行所有钩子，' +
      '同名 add 只更新逻辑、保持原执行位置；hooks.order([名字…]) 重排执行顺序（未列出的保持相对顺序跟在后面），hooks.list() 按执行顺序返回所有钩子；' +
      'hooks.remove(名字)/clear() 删除，钩子源码与顺序跨调用自动持久化；单个钩子出错只回滚它自己的改动并记录，不影响其余钩子。' +
      '每次执行返回：返回值、日志、state 的变化 diff、钩子错误（如有）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['program'],
      properties: {
        program: {
          type: 'string',
          description: '要执行的 JavaScript 代码（async 函数体）。读取/修改 state，或定义全局函数供后续调用使用；如需查看具体字段，用 return 返回它。',
        },
        dry: {
          type: 'boolean',
          description: '试运行：照常执行并返回完整结果（含钩子效果与 state diff），但不提交任何变化（state、钩子注册、函数定义全部还原）。用于复杂更新前排错确认。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: () => ({ card: 'generic', title: '世界判定', kind: 'other' }),
    async execute(args, exec) {
      if (!exec.agent) throw new Error('world_run 需要在会话上下文中执行')
      const rt = await runtimeFor(exec.agent)
      const result = await runProgram(rt, String(args.program ?? ''), args.dry === true, exec.agent.session)
      return { text: formatRunResult(result) }
    },
  })

  ctx.tools.register({
    name: 'present_options',
    description:
      '把行动权交给玩家：弹出选择卡片展示 0–4 个行动选项，玩家也可以不理会选项自行输入（0 个选项 = 纯自由输入）。' +
      '调用后阻塞等待玩家作答，答案作为本工具的结果返回，随后你在同一回合内继续推进：结算行动（需要数值/规则判定时用 world_run）、叙事，然后再次调用本工具等待下一步。' +
      '玩家每次行动都应通过恰好一次本工具调用交接。' +
      '在无交互界面的环境或玩家取消作答时，自动回退为结束回合、等待玩家以普通消息行动。' +
      '模式开关：玩家可用 /options 命令关闭选项卡片（自由对话模式）；若会话中出现关闭模式的指令，则不要调用本工具——' +
      '此时调用不会展示任何选项，只会收到纠正提醒并直接结束回合。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['options'],
      properties: {
        options: {
          type: 'array',
          maxItems: 4,
          description: '0–4 个行动选项（仅供参考，玩家可自行输入）。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label'],
            properties: {
              label: { type: 'string', description: '选项内容' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => {
      const options = Array.isArray(args?.options) ? args.options : []
      if (options.length === 0) return { card: 'generic', title: '等待玩家自由行动', kind: 'other' }
      return {
        card: 'generic',
        title: '选择你的行动',
        kind: 'other',
        rawInput: options.map((o, i) => `${i + 1}. ${o.label}`).join('\n'),
      }
    },
    async execute(args, exec) {
      // 自由对话模式：不弹卡片、不剪枝，返回纠正文案并结束回合（自愈式纠错）。
      if (exec.agent && !(await modeFor(exec.agent))) {
        exec.concludeTurn()
        return { text: PLAIN_MODE_TOOL_REPLY }
      }
      const options = (Array.isArray(args.options) ? args.options : [])
        .map((o) => String(o?.label ?? '').trim())
        .filter((label) => label !== '')
      // 剪枝失败（如 surface 校验拒绝）不应破坏交接本身。
      if (exec.agent) {
        try {
          sanitizeOlderOptions(exec.agent.session, exec.callId)
        } catch (error) {
          console.error('[airp-engine] 旧选项剪枝失败：', error)
        }
      }
      // 回退路径：无会话上下文、无 UI 提供者、子代理、玩家取消作答等，
      // 一律退化为非阻塞交接——结束回合，等玩家以普通消息行动。
      const fallback = () => {
        exec.concludeTurn()
        return {
          text: options.length > 0
            ? `已向玩家展示 ${options.length} 个行动选项。回合到此结束——不要再输出任何内容，等待玩家的选择以新消息到达。`
            : '旧上下文中的选择总是空的是因为系统过滤，如果你因为模仿旧轮次的行为提供空数组，请重新调用本工具生成选项。如果这是正常结束，则不要再输出任何内容，等待玩家输入。',
        }
      }
      const userQuestions = ctx.get('userQuestions')
      if (!userQuestions || !exec.agent) return fallback()
      let answer
      try {
        const response = await userQuestions.ask({
          questions: [{
            id: 'action',
            header: '行动交接',
            question: options.length > 0 ? '选择你的行动（也可以自行输入）' : '输入你的行动',
            options: options.map((label) => ({ label })),
          }],
          agent: exec.agent,
          signal: exec.signal,
        })
        answer = response.answers.find((a) => a.id === 'action') ?? response.answers[0]
      } catch (error) {
        // 取消的三种落定：GUI 卡片取消 = ASK_CANCELLED；信号中止 = ASK_ABORTED；
        // RPC 边界透传 = cancelled。其余错误才视为意外。
        if (error?.code === 'ASK_CANCELLED' || error?.code === 'ASK_ABORTED' || error?.code === 'cancelled') {
          // 玩家取消/回合中止：登记调用信息（此时结果尚未提交，不能动 surface），
          // 等结果落盘后由上方 session/event 监听把 [调用消息, 结果] 合并为纯叙事。
          if (exec.agent) {
            try {
              const liveNodes = new Set(exec.agent.session.surface.nodes)
              const found = findStrippedAssistant(exec.agent.session, exec.callId, liveNodes)
              if (found) pendingDeletes.set(exec.callId, found)
            } catch (stripError) {
              console.error('[airp-engine] 取消时定位调用块失败：', stripError)
            }
          }
          exec.concludeTurn()
          return { text: CANCEL_RESULT_TEXT }
        }
        // 无提供者/非 root 代理等意外错误：静默回退，不打扰玩家。
        console.error('[airp-engine] 弹出选择卡片失败，回退为消息交接：', error)
        return fallback()
      }
      const selected = Array.isArray(answer?.selected) ? answer.selected.filter((s) => typeof s === 'string' && s.trim() !== '') : []
      const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
      if (selected.length === 0 && custom === '') return fallback()
      const decision = custom !== ''
        ? `玩家行动：「${custom}」。`
        : `玩家行动：「${selected[0]}」。`
      return {
        text: decision
      }
    },
  })

  // 监听器返回 Promise：事件在回合边界提交前等待其结算，steer 才能及时进入 inbox。
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      // 自由对话模式：本就不需要工具交接，守卫停用。
      if (!(await modeFor(agent))) return
      const session = agent.session
      if (turnHasHandoff(session, turn)) return
      if (steeredTurns.get(session.id) === turn) return
      steeredTurns.set(session.id, turn)
      agent.steer({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: GUARD_REMINDER }],
        source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text: GUARD_REMINDER }] },
      })
    } catch (error) {
      console.error('[airp-engine] 回合守卫失败：', error)
    }
  })
}

// 离线测试钩子：供脚本验证 surface 修复逻辑；loader 只读取 name/inject/apply/Config。
const __test = { repairInterruptedHandoffs, stripToolCallBlock, replaceResultWithNote, findStrippedAssistant, mergeCallIntoNarrative, deleteOrphanResult, runtimeFor, runProgram, lastStateEvent, lastModeEvent }

export { name, inject, apply, Config, __test }
