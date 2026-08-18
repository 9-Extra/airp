# AIRP 角色扮演 — DSH Agent Preset

AI 推理世界、玩家扮演角色（PC）的文字角色扮演引擎。以 DSH agent preset 形式分发。

- **持久代码裁决**：内置 `world_run` 工具提供持久 JavaScript 环境（`node:vm`，按会话分键）。所有数值、随机性与规则判定由代码完成；全局对象 `state` 与全局函数自动持久化，跨会话恢复；每次执行返回 state 变化 diff 供模型确认。- **原子执行与试运行**：代码出错自动整体回滚（state/钩子/函数定义），不留半更新；`dry: true` 试运行返回完整结果但不提交任何变化，供复杂结算前排错。
- **选择生成**：`present_options` 弹出选择卡片（0–4 个选项 + 自由输入框），阻塞等待玩家点选或自行输入，答案直接作为工具结果返回，模型同一回合内继续推进。
- **交接模式可开关**：会话中输入 `/options off` 即关闭选择卡片，回退为普通对话模式（AI 以纯叙事结尾，直接等待你的消息）；`/options on` 恢复。
- **世界包渐进加载**：世界设定（规则书）以 skill 形式提供，开局按需加载；附带的 `writing-world-packs` 技能指导世界包写作。

## 安装

1. 把整个 `airp/` 目录复制到你的的 DSH 用户预设根目录：

   ```
   Windows:  %USERPROFILE%\.dsh\.agent-presets\airp\
   macOS/Linux: ~/.dsh/.agent-presets/airp/
   ```

   （若设置了 `DSH_HOME` 环境变量，则为 `$DSH_HOME/.agent-presets/airp/`。）

2. 把skills内的writing-world-packs复制到你技能目录，见“世界包小节”
3. 无需重启：roster 实时扫描，目录放入后即可在新建会话界面的 preset 选择器中看到「AIRP 角色扮演」。

## 世界包

世界包（对应ST的角色卡），本质上是AI自行按需读取的skill，不用写任何代码，非常灵活。本预设中不能提供，需参照`writing-world-packs`（建议放到工作区技能目录）自行编写或转化。把世界包目录放入用户技能根目录 `<dshHome>/skills/`或者工作区的技能目录`./.agents/skills`等能检测到的地方AI就能自己读。开局时对 AI 说世界名或者显式调用技能即可加载；（注意本预设没有提供写文件功能，建议使用标准模式调用writing-world-packs技能。如果包含R18内容，建议配破限提示词。如果是ST角色卡，建议再找个解包角色卡的skill，或者相信模型的智商）

## 运行要求

- 开发与验证环境：DSH `0.1.0-rc.6`（标准宿主组合）。
- 依赖宿主提供的 shipped 包与服务：`dsh-persona`、`dsh-skill-filesystem`、`dsh-tool-skill`、`dsh-compaction-basic`、`dsh-command-compact`、`dsh-compaction-tool-result-pruner`，以及 `tools`/`agents`/`userQuestions` 服务——标准安装均自带，无需额外配置。
- DSH 无预设补丁语义：升级 DSH 不会更新本目录；若上述包的配置形状或服务接口变更，预设可能需要同步修改。
- 选择卡片需要 Web GUI（`userQuestions` 的 UI provider）；在 headless/无界面环境会自动退化为普通消息交接，功能不缺失。

## 安全提示

preset 与其插件同权（等同 shell 访问）。`world_run` 让模型在**你的机器上**执行任意 JavaScript——`node:vm` 是持久隔离环境，不是安全边界。请只运行你信任其内容的会话与世界包。

会话运行数据（state、函数、钩子、模式）以 `airp/state` / `airp/mode` 日志事件随会话存档（见「本地补丁」），并在各会话工作目录的 `.airp/` 下双写兜底文件，两者都与本目录无关，删除预设不影响历史会话存档。

## 本地补丁（DSH 本体）

本预设依赖/受益于对 DSH 安装的两处本地补丁（升级 DSH 会被覆盖，需重新应用）：

1. **`dsh-session`：append 透传 `ignorable`（状态随分支继承所必需）**
   文件：`<dsh>/node_modules/@deepseek-ai/dsh-session/lib/index.js` 与 `lib/types/index.js`，
   在 `Session.append()` 构造 `surfaceMetadata` 的对象字面量中追加一行：
   `...surfaceOpts?.ignorable === true ? { ignorable: true } : {},`
   （本仓库副本已带 `LOCAL PATCH (airp preset)` 注释。）
   原理：DSH 的持久化读路径拒绝加载含未知事件类型的日志，除非事件带 `ignorable: true`
   信封标记——这是官方为下游插件事件预留的机制，但 `append()` 尚未暴露它。
   未打补丁时预设自动检测并退化为仅 `.airp/` 文件持久化（功能完整，但分支不继承状态）。

2. **（可选，未打）`dsh-session` repair 去重**：给崩溃修复器加"已回答调用"集合，
   避免把 replace 副本里的旧调用重复登记为悬空。不打也可——预设的中断自愈会清理其产物。

## 已知问题
dsh的分支功能约束过严，以工具调用结尾的回合无法分支会话。选项卡片模式（默认）下所有回复都以工具调用结尾，无法回滚或重roll；`/options off` 切到自由对话模式后回合以纯叙事结尾，分支即恢复可用（配合上述补丁 1，分支还会继承分支点的世界状态与模式）。卡片模式下的根本修复要等 dsh 更新。

dsh 的崩溃修复器（dsh-session repair）不理解 surface 的 replace 语义：历史里有 replace 副本时，它会为早已被回答的旧调用补出多余合成结果，使后续请求被 provider 400 拒绝。本预设的中断自愈会在会话启动时自动清理这些残留，历史坏档下次打开即恢复；若想从源头根治，需要给 dsh 的 repair 加"已回答调用"去重（即上述补丁 2，可向 dsh 反馈）。
系统提示词定义见agent.cordis.yml，带一个比较弱的破限（大肥鱼没有问题），你可以换你认为更好的，但别把工具相关提示删了。