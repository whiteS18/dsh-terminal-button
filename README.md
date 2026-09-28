# dsh-terminal-button

DeepSeek Harness 插件：把「打开终端」从弹出系统默认终端窗口，改为在 DSH 界面内嵌终端面板，借鉴 opencode 的内嵌终端方案。

## 功能

- **内嵌终端**：会话头部工具栏新增终端图标按钮（Lucide `SquareTerminal`，与 DSH 标题栏原生终端按钮同一图标），点击即打开内嵌终端。终端渲染用 [@xterm/xterm](https://www.npmjs.com/package/@xterm/xterm)（构建时内联进 `client.js`）
- **位置可配置**：插件 → 插件列表 → 本插件详情里的「终端显示位置」（原生 Menu 下拉；DSH 0.1.5 及更早仍在设置 → 通用）可选 **右侧栏**（DockKit Tab，支持分栏/浮动/折叠，默认）、**底部面板**（`conversation.composer.dock`，会话列内嵌于输入框下方，把输入框和对话内容顶起来而不遮挡——同 Kimi Code Desktop 底部面板的做法；顶部拖拽调高度）或 **系统弹窗**。配置写入 profile 里 `terminal-plugin` 条目的 volatile `position` 字段，热更新、跨窗口同步
- **主题跟随**：终端配色实时读取 DSH 的 CSS 设计变量（`--dsw-alias-bg-base` / `--dsw-alias-label-primary` 等），亮色 / 暗色切换、`theme/change` 事件都会即时刷新终端颜色与代码字体（`--ds-font-family-code`）
- **工作区根目录**：PTY 的 cwd 由 Host 端根据会话 ID 解析（活跃会话 → 持久化会话日志 → 前端提示 → 沙箱根目录），**始终是当前会话工作区根目录，而不是 DSH 的 profile 目录**
- **状态栏**：面板底部显示运行状态（连接中 / 运行中 / 已退出 / 错误）与 cwd；Shell 退出后可一键「重开终端」
- **Shell 选择**：Windows 优先本机的 PowerShell 7（`pwsh.exe -NoLogo`，会加载 PowerShell 7 的 `$PROFILE`，而不是 Windows PowerShell 5.1 的 profile）；找不到时回退 `powershell.exe -NoLogo`。可用环境变量 `DSH_TERMINAL_SHELL` 或连接参数指定 `powershell` / `pwsh` / `cmd` / `bash` / 绝对路径
- **`dsh` 命令**：DSH 启动子进程时会清掉全部 `DSH_*` 环境变量。桌面版没有独立的 `dsh` 可执行文件，CLI 入口在 `app.asar` 里，只能靠 `DSH_DESKTOP_NODE_EXECUTABLE` 找到 Electron 的 Node。插件据此生成 `dsh.cmd`（`ELECTRON_RUN_AS_NODE=1` 直接调用 `lib/bin.js`），放到临时目录并前插到 PATH，不把 `DSH_*` 重新注入 shell。已安装到 PATH 的 `dsh`（`DSH_EXECUTABLE`）优先使用
- **复制**：选中文字后松开鼠标即复制；`Ctrl+Shift+C` 复制，`Ctrl+Shift+V` 或 `Ctrl+V` 粘贴。没有选区时 `Ctrl+C` 仍是中断；有选区时 `Ctrl+C` 同时复制并中断。右键在有选区时复制，否则粘贴
- **零运行时依赖**：Host 半部只用 Node 内置模块（WebSocket 帧手写实现），PTY 复用 DSH 自带的 `subprocess` 服务（node-pty / ConPTY）

## 安装

发布到 npm 后（或本地包目录）：

```sh
dsh plugin --profile desktop add dsh-terminal-button
```

本地开发版：

```sh
dsh plugin --profile desktop add C:/Users/scw/project/exp/dsh-plugin/dsh-terminal-button
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
├── index.js           # Host 半部：settings 命名空间注册、/dsh-terminal/pty 的 WebSocket
│                      #   upgrade 路由、cwd 解析、ctx.subprocess.spawnTerminal 启停 PTY
├── frames.js          # RFC 6455 帧编解码（被 index.js 和单测共用）
├── client.js          # Client 半部（构建产物，勿手改）：侧栏 Tab + 底部抽屉 + 设置行
├── src/client.jsx     # Client 源码（esbuild 打包，xterm/CSS 内联）
├── build.mjs          # 构建脚本：npm run build
├── cordis.patch.yml   # bundle 组合补丁
├── test/frames.test.js      # WebSocket 帧编解码单测：npm test
└── script/integration-test.mjs  # 真实 PTY 端到端集成测试（需本机装有 DSH Desktop）
```

- **Host**：`ctx.webServer.registerUpgrade({ path: '/dsh-terminal/pty' })` 拿到裸 socket 后自实现 RFC 6455
  握手与帧编解码（`frames.js`）。下行 PTY 输出走**二进制帧**（原始 UTF-8），控制消息（ready / exit / error）走 JSON 文本帧；
  上行键盘输入与 resize 是 JSON 文本帧。连接关闭即终止 PTY，PTY 退出即通知前端并关流。
  同时经 `ctx.settings.register('dsh-terminal-button', schema)` 注册配置命名空间，
  使 `settings.yaml` 的 `position` 字段生效并接入客户端 settingsScope 镜像。
- **Client**：`ctx.sidebarRightTabs.register({ id: 'dsh-terminal', kind: 'terminal', ... })` 注册侧栏 Tab 类型，
  正文与标题分别 keyed 注册到 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`；
  底部面板形态注册到 `conversation.input.dock`（session 作用域，输入框卡片上方的布局流内，
  不遮挡任何内容）；
  按钮注册到 `conversation.session.header.utilities`（order -20），按配置分发到侧栏或底部；
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
