# 更新日志

本文件记录 `dsh-terminal-button` 的版本变更。版本号遵循 SemVer；格式参考 Keep a Changelog。

## 0.4.1 — 2026-10-19

### 修复

- 恢复 0.4.0 重构时丢失的底部面板外框布局：补回 composer 底部行的 `:has()` 换行规则（面板独占整行、与主界面同宽、位于 token 用量表下方），以及头部关闭按钮避让会话宽度拖拽热区的样式。
- 恢复面板底部状态行（连接中 / 运行中 / 已退出 / 错误 + 路径 + 「重开终端」）。官方 `TerminalBody` 只在非运行态显示自己的状态条，面板高度仍按拖拽值计算，终端区域自动让出状态行的高度。
- 样式注入改为复用并更新已有 `<style>` 标签，client-hmr 热更新插件后新样式立即生效，不需要刷新窗口。

## 0.4.0 — 2026-10-19

### 变更（不兼容）

- 插件重构为**官方终端的扩展**：底部面板复用官方 `@deepseek-ai/dsh-client-ui-sidebar-terminal` 的 `TerminalBody`（经 client module system 懒加载官方 chunk `client.terminal.js`），数据来自官方 `webTerminals` 客户端服务；不再自带第二套终端实现。
- 移除插件自己的 PTY/WebSocket 桥、xterm 打包、侧栏 Tab 与标题/Guide 注册、会话恢复、主题与剪贴板实现（`client.js` 从 461 KB 降到约 27 KB）。
- 保留独有能力：底部面板位置、桌面「打开终端」入口拦截（SSE + `desktopRuntime.openTerminal` patch）、`external` 系统弹窗模式、`dsh` CLI shim。
- `dsh` shim 改为 patch `ctx.subprocess.spawnTerminal`，向 PATH 前插临时目录里的 `dsh.cmd` / `dsh`；官方右侧栏终端与底部面板内的 `dsh` 命令均生效，且不重新注入任何 `DSH_*` 变量。
- 位置设置收敛为「底部面板 / 系统弹窗」两项；旧配置中的 `sidebar` 自动归一为底部面板（右侧栏终端由官方提供）。
- 新增窗口 hold 桥接（包装官方 `webTerminals.retainTabs`），让没有侧栏 Tab 的底部终端不被官方 hold 调和逻辑释放。
- 兼容性要求提升为 **DSH 0.2.1-rc.2+**，且官方终端插件启用。

## 0.3.9 — 2026-10-19

### 修复

- 进入「新会话 / 空白会话」界面（hero，DSH 不渲染 `conversation.composer.dock`）时底部面板收起，且发出第一条消息后不再自动弹回；shell 进程保留，点终端图标可重新挂出。
- 监听会话主体的 `data-content-phase="hero"`；只认可见标记，连接/流式输出期间不触发布局查询。

## 0.3.8 — 2026-10-19

### 修复

- 修复桌面版点击终端后出现「WebSocket 连接失败」：DSH 0.2 起 Host 以 `--port 0` 启动、端口不再固定，改为从 `globalThis.__DSH_TRANSPORT__.streamBaseUrl` 解析 Host 源；兼容旧版 `window.__DSH_BOOT__` 与 `dshDesktopBoot.ready()` IPC，移除写死 `19387` 的默认连接。
- 地址解析改为异步并加连接并发守卫；解析失败显示错误状态，不再一直停留在「连接中」。

## 0.3.7 — 2026-10-08

### 变更

- 版本发布：`package.json` / `package-lock.json` 版本号对齐 npm 0.3.7（功能与 0.3.6 相同）。

## 0.3.6 — 2026-09-30

### 修复

- 底部终端跨会话切换保留：会话作用域插槽卸载时只 `detach`，xterm 与 PTY 复用，不新开进程、不清屏；重新挂载即恢复画面。

## 0.3.5 — 2026-09-30

### 修复

- 修复 `Ctrl+Shift+V` 粘贴两次（同时经过 xterm 自定义键处理和浏览器 paste 事件）。

## 0.3.4 — 2026-09-29

### 修复

- 保存终端显示位置时不再使用过期的 settings revision（避免配置写入被拒绝）。

## 0.3.3 — 2026-09-28

### 变更

- 新增 PTY 最小几何限制（50×5）并延迟握手，避免 PSReadLine 因窗口过小关闭补全/告警。
- 改进底部面板布局与拖拽高度。

## 0.3.2 — 2026-09-28

### 新增

- 首个公开版本：内嵌终端（右侧栏 DockKit Tab + 底部面板）、桌面「打开终端」原生入口拦截、位置设置、主题跟随、会话工作区根目录、`dsh` 命令 shim、复制/粘贴快捷键。
