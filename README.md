# dsh-terminal-button

DeepSeek Harness 插件：把「打开终端」从弹出系统默认终端窗口，改为在 DSH 界面内嵌终端面板，借鉴 opencode 的内嵌终端方案。

## 功能

- **内嵌终端**：会话头部工具栏新增终端图标按钮（Lucide `SquareTerminal`，与 DSH 标题栏原生终端按钮同一图标，插槽 `conversation.session.header.actions`，order 30），点击即打开内嵌终端。终端渲染用 [@xterm/xterm](https://www.npmjs.com/package/@xterm/xterm)（构建时内联进 `client.js`）
- **原生入口拦截**：桌面版的「打开终端」原生入口（托盘 / 设置页 / 标题栏 IPC）也会被重定向到内嵌终端——Host 端 patch `desktopRuntime.openTerminal`，经 SSE `/dsh-terminal/events` 通知前端打开面板；选择「系统弹窗」时放行原生行为
- **位置可配置**：插件 → 插件列表 → 本插件详情里的「终端显示位置」（原生 Menu 下拉；DSH 0.1.5 及更早仍在设置 → 通用）可选 **右侧栏**（DockKit Tab，支持分栏/浮动/折叠，默认）、**底部面板**（`conversation.composer.dock`，会话列最底部、token 用量表下方独占一行，与主界面同宽，从底部向上顶起输入框和对话内容而不遮挡——同 opencode 底部面板的做法；默认高 260px，顶部拖拽调高度，范围 120px~60% 窗高，只持久化高度、每次启动默认收起）或 **系统弹窗**。配置写入 profile 里 `terminal-plugin` 条目的 volatile `position` 字段，热更新、跨窗口同步。`position` 必须带 `meta.volatile`（schemastery ≥ 3.18.4 的 `.volatile()`，旧副本回退 `.extra('volatile', true)`），否则 Host 不服务该条目，详情页不会出现选择器。**注意：「系统弹窗」模式下会话头部的终端按钮点击无效**（此时请用系统原生入口，或经 `POST /dsh-terminal/open-native` 打开）
- **底部终端不跟会话走**：底部面板的插槽是 session 作用域，切换会话会卸掉面板，但 shell 不是。同一个 xterm 和 PTY 会被摘下再挂上，不会新开进程、也不会清屏。关掉面板再打开还是这个 shell。要换一个新 shell，用状态栏的「重开终端」（工作目录取当前会话）
- **主题跟随**：终端配色实时读取 DSH 的 CSS 设计变量（`--dsw-alias-bg-base` / `--dsw-alias-label-primary` 等），亮色 / 暗色切换、`theme/change` 事件都会即时刷新终端颜色与代码字体（`--ds-font-family-code`）
- **工作区根目录**：PTY 的 cwd 由 Host 端根据会话 ID 解析（活跃会话 → 持久化会话日志 → 前端提示 → 沙箱根目录），**始终是当前会话工作区根目录，而不是 DSH 的 profile 目录**
- **状态栏**：面板底部显示运行状态（连接中 / 运行中 / 已退出 / 错误）与 cwd；Shell 退出后可一键「重开终端」
- **终端尺寸保护**：内置最小行列限制（50x5）与延迟握手机制，确保面板在初次挂载或动画未就绪时不会生成畸形 2x1 窗口，避免 PowerShell PSReadLine 因窗口过小关闭自动补全或抛出提示告警
- **Shell 选择**：Windows 优先本机的 PowerShell 7（`%ProgramFiles%\PowerShell\7\pwsh.exe -NoLogo`，会加载 PowerShell 7 的 `$PROFILE`），找不到时回退 PATH 里的裸 `pwsh.exe`（**没有** `powershell.exe` 兜底；要用 Windows PowerShell 5.1 请显式指定）。可用环境变量 `DSH_TERMINAL_SHELL` 指定 `powershell` / `pwsh` / `cmd` / `bash` / 绝对路径；POSIX 默认 `$SHELL -l`（登录 shell）
- **`dsh` 命令**：DSH 启动子进程时会清掉全部 `DSH_*` 环境变量。桌面版没有独立的 `dsh` 可执行文件，CLI 入口在 `app.asar` 里，只能靠 `DSH_DESKTOP_NODE_EXECUTABLE` 找到 Electron 的 Node。插件据此生成 `dsh.cmd`（`ELECTRON_RUN_AS_NODE=1` 直接调用 `lib/bin.js`），放到临时目录并前插到 PATH，不把 `DSH_*` 重新注入 shell。已安装到 PATH 的 `dsh`（`DSH_EXECUTABLE`）优先使用
- **复制**：选中文字后松开鼠标即复制；`Ctrl+Shift+C` 复制，`Ctrl+Shift+V` 或 `Ctrl+V` 粘贴。没有选区时 `Ctrl+C` 仍是中断；有选区时 `Ctrl+C` 同时复制并中断。右键在有选区时复制，否则粘贴
- **零原生依赖**：Host 半部只用 Node 内置模块（WebSocket 帧手写实现），PTY 复用 DSH 自带的 `subprocess` 服务（node-pty / ConPTY）。唯一声明的 dependencies 是 `@deepseek-ai/schemastery`，且为容错动态 import——缺失时自动降级、跳过设置注册，不影响终端功能
- **WebSocket 安全**：同源 Origin 校验（跨域 403）、握手参数校验（400）、ping/pong 保活与输出背压 pause/resume；终端尺寸上限 500x200

## 安装

发布到 npm 后（或本地包目录）：

```sh
dsh plugin --profile desktop add dsh-terminal-button
```

本地开发版：

```sh
dsh plugin --profile desktop add /绝对路径/dsh-terminal-button
```

> [!IMPORTANT]
> **启动顺序决定是否需要重启。** DSH 的插件 bundle 组合发生在进程**启动时**，安装命令只改磁盘上的 profile 文件：
>
> - **先安装 → 再启动**：直接生效；
> - **先启动 → 再安装**：装完后**必须完全退出并重新启动** DSH Desktop（不是刷新页面）。
>
> 安装后可用 `dsh --profile desktop --dump-config | grep terminal` 确认插件已进入 bundle 层，
> 或启动后访问 `http://127.0.0.1:<port>/dsh-terminal/health`（返回 `{"ok":true}` 即 Host 半部已生效）。

## 架构

```
dsh-terminal-button/
├── index.js           # Host 半部：settings 命名空间注册（≤0.1.5）/ Config volatile（≥0.1.6）、
│                      #   /dsh-terminal/pty 的 WebSocket upgrade 路由、/dsh-terminal/events（SSE）、
│                      #   /dsh-terminal/open-native、cwd 解析、ctx.subprocess.spawnTerminal 启停 PTY、
│                      #   desktopRuntime.openTerminal 拦截、dsh.cmd shim 生成
├── frames.js          # RFC 6455 帧编解码（被 index.js 和单测共用）
├── client.js          # Client 半部（构建产物，勿手改）：侧栏 Tab + 底部抽屉 + 设置行
├── src/client.jsx     # Client 源码（esbuild 打包，xterm/CSS 内联）
├── src/pinned-terminal.js    # 底部 dock 的页面级终端 registry（detach/attach 复用）
├── src/terminal-session.js   # xterm + WebSocket 会话封装
├── build.mjs          # 构建脚本：npm run build
├── sync-plugin.ps1    # 开发同步脚本：等 DSH 退出后把产物复制进 desktop profile
├── cordis.patch.yml   # bundle 组合补丁
├── test/frames.test.js      # WebSocket 帧编解码单测：npm test
├── test/config.test.js      # 配置项 volatile 声明单测：npm test
├── test/pinned-terminal.test.js  # pinned registry 单测：npm test
└── script/integration-test.mjs  # 真实 PTY 端到端集成测试（需本机装有 DSH Desktop）
```

- **Host**：`ctx.webServer.registerUpgrade({ path: '/dsh-terminal/pty' })` 拿到裸 socket 后自实现 RFC 6455
  握手与帧编解码（`frames.js`）。下行 PTY 输出走**二进制帧**（原始 UTF-8），控制消息（ready / exit / error）走 JSON 文本帧；
  上行键盘输入与 resize 是 JSON 文本帧。连接关闭即终止 PTY，PTY 退出即通知前端并关流。
  配置注册按版本分路：DSH ≥ 0.1.6 经 `export const Config`（schemastery，`position` 标 volatile）
  由 loader 条目 `terminal-plugin` 承载；DSH ≤ 0.1.5 经 `ctx.settings.register('dsh-terminal-button', schema)`
  注册配置命名空间，使 `settings.yaml` 的 `position` 字段生效并接入客户端 settingsScope 镜像。
  另提供 `GET /dsh-terminal/health`（返回 `{"ok":true}`）、`GET /dsh-terminal/events`（SSE，30s 心跳）
  与 `POST /dsh-terminal/open-native`（系统弹窗逃生口）。
- **Client**：`ctx.sidebarRightTabs.register({ id: 'dsh-terminal', kind: 'terminal', ... })` 注册侧栏 Tab 类型，
  正文与标题分别 keyed 注册到 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`；
  底部面板形态注册到 `conversation.composer.dock`（session 作用域，composer 卡片底部行内；
  CSS 把该行换行成整宽、独占一行置于 token 用量表下方，负边距抵消 composer 的左右留白，
  面板与主界面同宽、从最底部顶起，不遮挡任何内容）。这个插槽会随会话卸载，
  所以底部终端的 xterm/PTY 放在页面级 registry 里：卸载只 `detach` 到屏幕外，
  下一次挂载再 `attach`，不重新握手；`dispose` 只发生在「重开终端」和插件卸载；
  按钮注册到 `conversation.session.header.actions`（order 30），按配置分发到侧栏或底部；
  「终端显示位置」注册到插件详情的 `plugins.bundle.config`（包名 `dsh-terminal-button`），
  值经 `configForms.get('terminal-plugin')` 写入 profile patch；DSH 0.1.5 及更早仍走 `settings.general.item`。
- **协议**：
  - client → host：`{type:'input', data}` / `{type:'resize', cols, rows}`
  - host → client：二进制帧 = 终端输出；文本帧 = `{type:'ready', cwd, shell, pid}` / `{type:'exit', exitCode, signal}` / `{type:'error', message}`

## 开发

```sh
npm install     # 安装 esbuild / @xterm/*（仅构建期依赖）
npm run build   # src/client.jsx -> client.js
npm test        # node --test
```

改完 `src/client.jsx` 必须重新 `npm run build`；改完任意文件后重启 DSH Desktop 生效。

## 调试

- DSH 标题栏扳手图标 → Developer Tools（或 `Ctrl+Shift+I`），Console 里可查 `window.__DSH_BOOT__` / `window.__ModuleLoader__`
- `curl http://127.0.0.1:<port>/dsh-terminal/health` 验证 Host 半部
