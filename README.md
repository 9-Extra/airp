# AIRP 角色扮演 — DSH Agent Preset

AI 推理世界、玩家扮演角色（PC）的文字角色扮演引擎。以 DSH agent preset 形式分发。

AI一共四个工具，减少注意力浪费：
- **持久化代码环境**：内置 `world_run` 工具提供持久 JavaScript 环境（`node:vm`，按会话分键）。所有数值、随机性与规则判定由代码完成；全局对象 `state` 与全局函数自动持久化，跨会话恢复；每次执行返回 state 变化 diff 供模型确认。原子执行与试运行：代码出错自动整体回滚（state/钩子/函数定义），不留半更新；`dry: true` 试运行返回完整结果但不提交任何变化，供复杂结算前排错。
- **选项生成**：`present_options` 弹出选择卡片（0–4 个选项 + 自由输入框），阻塞等待玩家点选或自行输入，答案直接作为工具结果返回，模型同一回合内继续推进。（可以用/options [on|off]开关）
- **skill检索**：dsh原生工具，加载skill，不仅可用于规则书，也可以用来加载文风啊，xxx描写指导什么的（咳咳）
- **读文件**：`read_file`读文件，世界包（世界设定，规则书）以 skill 形式提供，模型自主按需加载；

系统提示词见agent.cordis.yml，带一个比较弱的破限（大肥鱼没有问题），你可以换你认为更好的，但别把工具相关提示删了。

## 安装

1. 把整个 `airp/` 目录复制到你的的 DSH 用户预设根目录：

   ```
   Windows:  %USERPROFILE%\.dsh\.agent-presets\airp\
   macOS/Linux: ~/.dsh/.agent-presets/airp/
   ```
2. 把skills文件夹内的writing-world-packs复制到你技能目录，见“世界包小节”
3. 新建会话界面，preset 选择器中可以看到「AIRP 角色扮演」。

## 世界包

dsh的技能目录包括用户技能根目录 `<dshHome>/skills/`和工作区的技能目录`./.agents/skills`。

世界包（对应ST的角色卡），被设定为AI自行按需读取的skill，非常灵活。本预设中不能提供（不能转载，我自己写的也没脸发），需使用`writing-world-packs`自行编写或转化。写好的世界包也一起放到技能目录里就好了。开局时对 AI 说世界名或者显式调用技能即可加载；
注意本预设没有提供写文件工具，调用writing-world-packs技能时建议使用**标准模式**预设。
如果包含R18内容，建议配破限提示词，并且不要放在用户技能目录里，可以误触发API拒绝。
如果是ST角色卡，建议再找个解包角色卡的skill，或者相信模型的智商。

## 运行要求

- 开发与验证环境：DSH `0.1.0-rc.7`。
- 依赖的包和服务DSH均自带，无需额外安装配置。

## 安全提示

preset 与其插件同权（等同 shell 访问）。`world_run` 让模型在**你的机器上**执行任意 JavaScript——`node:vm`的隔离环境并非绝对安全。请只运行你信任其内容的会话与世界包。

## 本地补丁（DSH 本体）

本预设部分依赖/受益于对 DSH 的一处补丁（没有补丁整体可用，但会影响会话分支时的状态保留）：

**`dsh-session`：append 透传 `ignorable`（状态随分支继承所必需）**
文件：`<dsh>/node_modules/@deepseek-ai/dsh-session/lib/index.js` 与 `lib/types/index.js`，
在 `Session.append()` 构造 `surfaceMetadata` 的对象字面量中追加一行：
`...surfaceOpts?.ignorable === true ? { ignorable: true } : {},`
（本仓库副本已带 `LOCAL PATCH (airp preset)` 注释。）
原理：DSH 的持久化读路径拒绝加载含未知事件类型的日志，除非事件带 `ignorable: true`
信封标记——这是官方为下游插件事件预留的机制，但 `append()` 尚未暴露它。
未打补丁时预设自动检测并退化为仅 `.airp/` 文件持久化（功能完整，但分支不继承状态）。

## 已知问题
dsh的分支功能约束过严，以工具调用结尾的回合无法分支会话。选项卡片模式（默认）下所有回复都以工具调用结尾，无法回滚或重roll；`/options off` 切到自由对话模式后回合以纯叙事结尾，分支即恢复可用（配合上述补丁，分支还会继承分支点的世界状态与模式）。卡片模式下的根本修复要等 dsh 更新。