# Token 统计 (实时计价) — SillyTavern 扩展

实时统计每次对话的 Token 用量并按**人民币（¥）**计价，支持 DeepSeek / Claude / GPT 等多家模型。
所有数据按对话独立存储，切换角色 / 对话自动保存与恢复，刷新浏览器不丢失。
哈哈 我放弃了 token统计还是好实现的 但是缓存命中统计就不是我能实现的了
## ✨ 功能

- **实时 Token 统计**：输入 / 输出 / 合计，精确读取 API 真实 `usage`（含缓存字段），解析失败时自动回退到本地估算。
- **人民币计价**：内置 DeepSeek / Claude / GPT 默认价（¥ / 百万 token），可在设置面板自由修改。
- **每对话独立存储**：以对话 ID 为键，切换对话自动恢复，基于 `localStorage` 持久化。
- **紧凑中文数字**：`1.2万` / `1.0亿`。
- **缓存效率评分**：优秀 / 良好 / 一般 / 较低，带颜色编码（绿 / 蓝 / 黄 / 红）。
- **吞吐量追踪**：tok/秒。
- **趋势图**：最近 20 次请求合计 Token 的柱状图。
- **浮动面板**：可拖拽、可折叠、可隐藏，位置与状态记忆。
- **成本节省显示**：缓存命中累计节约金额。
- **多轮工具调用不丢数据**：同一回合的多次请求自动累加。

## 中文 Slash 指令

| 指令 | 说明 |
| --- | --- |
| `/token` | 显示当前对话的 Token 用量与费用摘要 |
| `/token-reset` | 重置当前对话的统计数据 |
| `/token-panel` | 显示 / 隐藏浮动面板 |

## 安装

1. 在 SillyTavern 中打开 **扩展（Extensions）→ 安装扩展（Install Extension）**。
2. 粘贴仓库地址 `https://github.com/rskzayton/st-token-checker` 并安装；或将整个 `st-token-checker` 文件夹放入
   `data/<用户名>/extensions/`（或 `public/scripts/extensions/third-party/`）后重启 ST。
3. 在扩展列表中确认「Token 统计 (实时计价)」已启用。

## 设置

打开 **扩展设置** 面板，找到「Token 统计 (实时计价)」：

- 勾选 / 取消「显示浮动面板」。
- 编辑各模型的 **输入 / 缓存读 / 输出** 单价（¥ / 百万 token，匹配规则为「模型名包含关键字」）。
- 「重置本对话」「重置全部」「恢复默认价」。

## ⚠️ 关于缓存数据

- 缓存效率与节省金额依赖 API 返回的真实缓存字段（Claude 的 `cache_read_input_tokens`、
  DeepSeek 的 `prompt_cache_hit_tokens`、OpenAI 的 `cached_tokens`）。
- 若使用**流式**且服务商未返回 `usage`，面板会标注「估算」并回退到本地分词估算，此时缓存命中无法精确得知。

## 🔧 维护者发布流程

1. 更新 `manifest.json` 的 `version` 与 `CHANGELOG.md`。
2. `git tag v1.0.0 && git push --tags`。
3. 在 GitHub 创建对应 Release。
4. `manifest.json` 中 `auto_update: true` 会让用户在更新检查时自动获取新版本。

## 许可

MIT
