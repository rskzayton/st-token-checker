# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

## [1.0.0] - 2026-06-06

### 新增

- 实时 Token 统计：输入 / 输出 / 合计，通过拦截 `window.fetch` 精确读取 API 真实 `usage`。
- 人民币（¥）计价，内置 DeepSeek / Claude / GPT 默认价，支持设置面板自定义。
- 每对话独立存储，基于 `localStorage` 持久化，切换对话自动恢复。
- 解析失败时回退到 `getTokenCountAsync` 本地估算，面板标注数据来源（精确 / 估算）。
- 缓存效率评分（优秀 / 良好 / 一般 / 较低），带颜色编码。
- 吞吐量追踪（tok/秒）。
- 最近 20 次请求趋势图（Canvas 柱状图，零依赖）。
- 可拖拽、可折叠、可隐藏的浮动面板，位置与状态记忆。
- 成本节省显示（缓存命中累计节约金额）。
- 多轮工具调用不丢数据：同一回合多次请求自动累加。
- 中文 Slash 指令：`/token`、`/token-reset`、`/token-panel`。
- 全中文界面（面板、设置、提示、指令）。

[1.0.0]: https://github.com/rskzayton/st-token-checker/releases/tag/v1.0.0
