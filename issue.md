问题：总结长期记忆方案
解决方案：采用分阶段落地，先实现本地记忆存储，再在会话结束时保存 summary，随后增加结构化记忆提取、对话前上下文拼装、记忆管理 UI，最后再扩展 embedding 检索、按项目分组与过期策略。
相关架构原理：整体采用“存储层 -> 提取层 -> 上下文层 -> 管理层 -> 检索增强层”的渐进式架构，优先保证本地可用、易验证、低耦合，再逐步增强召回能力与治理能力。

问题：AGENTS.md 里的规则是否会被 Codex 自动参考
解决方案：明确区分当前 IDE 代理是否注入 AGENTS.md 规则，与独立 Codex 或其他代理是否自动读取仓库规则文件。当前会话中的代理会遵循已注入的 AGENTS.md 规则；但独立工具是否参考该文件，取决于其工具链是否显式支持自动加载这类仓库指令文件。
相关架构原理：仓库规则文件属于提示词注入层，而不是业务代码层。只有宿主代理框架在启动或构建会话时主动读取并注入这些规则，模型才会稳定遵循；否则不能假设任意代理都会自动生效。

问题：Codex 中的问题无法自动同步到 issue.md
解决方案：确认 issue.md 文件存在且可写，当前已有手动记录；问题不在文件路径，而在机制预期。AGENTS.md 只能约束代理行为，不会提供后台自动同步能力；每次记录都需要代理在回答过程中主动执行文件编辑，或额外实现脚本/插件/钩子来监听对话并写入 issue.md。
相关架构原理：AGENTS.md 属于提示词规则层，issue.md 属于仓库文件层，中间没有内置事件总线或自动持久化链路。要做到稳定自动同步，需要由 Codex 宿主、CLI 钩子、编辑器插件或项目脚本把“用户提问事件”转换成实际文件写入。

问题：如何稳定记录 Codex 提问到 issue.md
解决方案：短期采用“AGENTS.md 明确要求 + 仓库内记录脚本/固定格式”的半自动方案，由代理在每次回答前后调用脚本追加记录；中期可把记录动作封装成 Codex skill/plugin 或编辑器命令；长期如果宿主支持对话事件钩子，再做真正自动监听和写入。
相关架构原理：可靠同步需要把提示词约束转成可执行工具链。最小闭环是“规则触发 -> 标准化输入 -> 脚本追加 -> 文件持久化”，比单纯依赖模型自觉更稳定，也比一开始做后台监听插件成本更低。

问题：实现 issue.md 记录脚本
解决方案：新增 scripts/record-issue.mjs，并在 package.json 暴露 record:issue 命令；同时更新 AGENTS.md，要求优先调用该命令追加标准格式记录。
相关架构原理：采用仓库根目录定位和 Node ESM 脚本追加 UTF-8 文本，把提示词约束转成可执行工具链，兼容 Windows 与 macOS。

问题：为什么应用占用特别高，造成桌面卡顿
解决方案：定位后发现桌面卡顿并不只来自 OpenPets，截图里更大的内存压力来自 Windsurf；OpenPets 自身的主要成本在 Windows 上的透明置顶 Electron 窗口、持续动画与合成表面，以及默认关闭 GPU 加速后的软件合成路径。当前代码没有明显的无限创建窗口泄漏，更多是 Chromium 合成和系统总内存压力叠加导致卡顿。
相关架构原理：OpenPets 桌宠渲染基于透明无边框 BrowserWindow 与 HTML/CSS 精灵动画。Windows 上为了规避透明窗口 GPU 合成问题，main.ts 默认调用 app.disableHardwareAcceleration()，这会把更多渲染压力转移到 CPU/系统内存；当系统整体内存已高、Chromium 又出现 tile memory limits exceeded 时，就更容易引发桌面合成卡顿。

问题：制定 Windows 透明宠物窗低占用优化方案
解决方案：基于截图、Electron 官方文档和现有 pet-window/default-pet-controller 代码，给出先度量再优化的分阶段方案：增加进程指标采样，降低 Windows 透明窗动画/移动/气泡合成成本，提供 GPU 实验开关与低功耗模式。
相关架构原理：优化重点放在 Electron 主进程指标层、BrowserWindow 透明合成层、CSS sprite 渲染层和默认宠物控制器调度层，避免把系统总内存压力误判成单一 JS 泄漏。

问题：落地 Windows 透明宠物窗低占用模式
解决方案：新增 render-mode.ts 统一解析 low-power/balanced/full，新增 render-metrics.ts 在 OPENPETS_RENDER_METRICS=1 时采样 Electron 进程指标；Windows low-power 下放慢 auto-walk、暂停 idle sprite 动画、减弱气泡阴影并停止 busy pulse。
相关架构原理：把性能治理拆成模式层、采样层、窗口渲染层和默认宠物调度层：先用指标确认是否泄漏，再通过渲染模式降低透明置顶窗口的 Chromium 合成和重绘成本，同时保持 macOS/Linux 默认行为不变。

问题：再次分析 OpenPets 内存占用仍高
解决方案：截图和日志显示当前运行的是 balanced 模式且 renderMetrics=false，未启用 low-power 与指标采样；实时进程数据中 Electron 4 个进程约 889MB 工作集/467MB 私有内存，而 Windsurf 45 个进程约 8.4GB 工作集/21.8GB 私有内存。需要先用 low-power+metrics 重启验证，再判断是否继续把 Windows 默认切到 low-power。
相关架构原理：性能判断需要结合任务管理器截图、Electron 启动日志和系统进程口径。OpenPets 的透明 BrowserWindow 合成成本存在，但必须区分工作集、私有内存、共享 Chromium 资源和其他 Electron 应用带来的系统总内存压力。

问题：low-power 模式下 Electron 内存仍持续增长
解决方案：通过 render.metrics 确认增长主要发生在 Electron GPU 进程：主进程 JS heap 和 Tab 私有内存基本稳定，GPU working set/private 持续上升。已将 Windows low-power 模式改为不启动自动走路定时器，并停止移动状态的环境气泡，同时在 metrics 中记录 BrowserWindow 列表，便于确认窗口数量。
相关架构原理：Windows 透明置顶窗口的内存问题更接近 Chromium/DWM 合成缓存增长，而不是业务 JS 堆泄漏。修复点放在默认宠物调度层，减少透明窗口持续移动和合成表面更新；采样层补充窗口拓扑，方便把 GPU 进程增长与具体窗口数量关联。

问题：宠物停止后内存不再增长
解决方案：确认内存持续增长与宠物窗口持续运动/重绘强相关。low-power 禁止自动走路后，GPU/合成缓存不再继续上涨，说明优先治理方向应放在 Windows 透明窗口移动和动画调度，而不是主进程 JS heap 泄漏。
相关架构原理：OpenPets 桌宠由透明置顶 BrowserWindow、CSS sprite 动画和窗口移动调度组成。Windows 上持续移动透明窗口会驱动 Chromium/DWM 合成缓存增长；停止运动相当于切断合成层持续更新路径，因此内存趋于稳定。

问题：Windows 宠物动画导致内存持续增长
解决方案：将 Windows 渲染策略产品化为活动模式：默认 Still low power，停止自动透明窗口行走并暂停 idle sprite；Balanced 保留轻量移动；Full 保留完整动画。保留 OPENPETS_WINDOWS_RENDER_MODE 调试覆盖，并用 OPENPETS_RENDER_METRICS 采样 Electron GPU/Tab/Browser 进程内存与窗口数量。
相关架构原理：Windows 透明置顶宠物窗的主要增长来自 Chromium 合成/GPU 进程，而不是主进程 JS 堆。render-mode 统一解析默认值、持久化偏好和 env 覆盖；app-state 持久化 windowsRenderMode；windows/preload 暴露设置项；default-pet-controller 根据当前模式开关 auto-walk；pet-window 根据模式调整动画倍率和 idle play-state；render-metrics 只在 opt-in 时记录诊断数据。

问题：低占用模式下仍需要宠物走动
解决方案：将 Windows low-power 从静止策略改为低耗走动策略：保留自动走动，但把窗口移动降为低频脉冲；每次只移动小步长，并在短暂走路动画后 settle 回 idle，避免 CSS sprite 和透明窗口合成持续活跃。设置页文案同步改为 Low-power walk。
相关架构原理：低占用不是完全停止行为，而是控制透明置顶 BrowserWindow 的更新频率和动画活跃时长。default-pet-controller 负责按 render mode 选择 tick/speed，并为 low-power 调度 settle；pet-behavior-machine 新增 settle 事件回到 idle；pet-window 继续让 low-power 的 idle 动画保持暂停，只在移动脉冲期间短暂播放走路帧。

问题：低占用走动不能在运动和停止之间切换
解决方案：移除 low-power 的 settle 脉冲机制，让 Windows low-power 保持连续 walk-left/walk-right 行为；通过降低窗口移动 cadence 到 240ms、步长到 5px 来降低透明窗口 setPosition 和合成压力，同时避免视觉上走一下停一下。设置页文案改为 Low-power continuous walk。
相关架构原理：低占用连续运动应控制更新频率而不是切换行为状态。default-pet-controller 只按 render mode 选择 tick/speed；pet-behavior-machine 保持 tick 驱动的 walk 状态，不再引入 settle 回 idle；pet-window 继续按 low-power 放慢帧动画，从而在保持持续走动语义的同时减少 Chromium/DWM 合成更新量。
