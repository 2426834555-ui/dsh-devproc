# dsh-devproc

输入框上方的开发进程胶囊：显示正在跑的 dev server（uni-app 小程序 / H5 / 后端），
带复制地址、打开浏览器、打开产物目录、「微」打开微信开发者工具、关进程，以及「正在修改 / 已改好」标记。

> 另一个独立插件：[dsh-workspace-explorer-fork](https://github.com/2426834555-ui/dsh-workspace-explorer-fork)（右侧工作区文件树 + 文件编辑）。
> 两者互不依赖，各自克隆、各自安装。两个都装，界面才和作者本机一致。

## 功能

| | 说明 |
| --- | --- |
| 进程识别 | 复用项目里的 `scripts/devctl.mjs` 扫进程与监听端口，认 uni-app / vite / Java / Python / Node / Go / .NET 等 |
| 平台区分 | uni-app 显示「小程序 / H5 / 支付寶…」；小程序显示产物目录，H5 显示 `http://127.0.0.1:<端口>` |
| 胶囊按钮 | `⧉` 复制地址 `↗` 打开浏览器 `▤` 打开产物目录 `微` 微信开发者工具 `✕` 关进程 |
| 改动标记 | 琥珀色呼吸点「正在修改」→ 绿点「已改好 ✓」 |
| 推送方式 | SSE（变化即推，15s 心跳），连不上降级为 10s 轮询 |

## 安装

前置：装好 DSH 桌面版，profile 目录是 `~/.dsh/profiles/<profile>`（本机是 `desktop`）。

```powershell
# 1) 克隆
git clone https://github.com/2426834555-ui/dsh-devproc.git "$HOME\.dsh\plugins\dsh-devproc"

# 2) 链接进 profile
cd "$HOME\.dsh\profiles\desktop"
pnpm add "dsh-devproc@link:../../plugins/dsh-devproc"
```

3. 打开 `$HOME\.dsh\profiles\desktop\package.json`，在 `dsh.profile.bundles` 数组里加一行：

```json
"dsh-devproc"
```

4. 重启 DSH。装好后输入框上方会出现胶囊。

不用 pnpm 的替代做法：在 `$HOME\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加

```yaml
- insert:
    - id: devproc
      name: dsh-devproc
```

并把仓库目录手工链接/复制到 `node_modules\dsh-devproc`。

卸载：`node "$HOME\.dsh\plugins\dsh-devproc\uninstall.mjs"`（会从 profile 摘掉依赖与 bundle，再删 junction）。

## 两个插件一起装

```powershell
git clone https://github.com/2426834555-ui/dsh-devproc.git "$HOME\.dsh\plugins\dsh-devproc"
git clone https://github.com/2426834555-ui/dsh-workspace-explorer-fork.git "$HOME\.dsh\plugins\dsh-workspace-explorer-fork"

# 文件树是 TS 源码仓库，必须先构建出 lib/，否则装了也加载不出来
cd "$HOME\.dsh\plugins\dsh-workspace-explorer-fork"
npm install --legacy-peer-deps
npm run build

cd "$HOME\.dsh\profiles\desktop"
pnpm add "dsh-devproc@link:../../plugins/dsh-devproc"
pnpm add "dsh-workspace-explorer@link:../../plugins/dsh-workspace-explorer-fork"
```

`dsh.profile.bundles` 里加两行：

```json
"dsh-devproc",
"dsh-workspace-explorer"
```

重启 DSH：胶囊在输入框上方，文件树在右侧面板。

## 配置

设置页 →「终端进程」：刷新间隔、项目路径（留空用当前工作区）、只显示平台、URL 真实探测、微信开发者工具 `cli.bat` 路径。
配置文件：`~/.dsh/dsh-devproc.config.json`。

## 改动标记怎么来的

| 状态 | 显示 | 触发 |
| --- | --- | --- |
| `editing` | 琥珀色呼吸点 + `正在修改` | `<项目>/src` 有文件变动，或 POST 上报 `editing` |
| `done` | 绿点 + `已改好 ✓` | 变动静默 2.5s，或 POST 上报 `done`；保持 3 分钟后回 idle |
| `idle` | 无标签 | 默认 |

- 自动：`fs.watch` 递归盯 `<项目>/src`（没有 src 就盯项目根），忽略 `node_modules` / `.git` / `dist` / `.cache` / `unpackage` / `tmp`。
- 手动：代理改完可以主动上报，带上说明文字，鼠标悬停就能看到。

```powershell
# 注意：PowerShell 里中文要按 UTF-8 字节发，否则会变成问号
$body = [Text.Encoding]::UTF8.GetBytes('{"state":"editing","note":"改首页 tab"}')
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<DSH端口>/api/devproc/agent `
  -ContentType 'application/json; charset=utf-8' -Body $body
# done / idle 同理：{"state":"done"} / {"state":"idle"}
```

没有 dev 进程时，只要状态是 editing/done，也会单独显示一枚胶囊。

## 「微」按钮：为什么以前总打开上一个项目

微信开发者工具默认恢复上次打开的项目，只有走它的 CLI 或服务端口才能指定项目。现在的做法：

1. IDE 设置 → 安全设置 → **服务端口** 开启（只需一次，之后 `%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\Default\.ide-status` 为 `On`）。
2. 插件读同目录的 `.ide` 拿端口，先试 `GET http://127.0.0.1:<端口>/open?projectpath=<产物目录>`（`method: "rest"`，1.5s 超时）。
3. 不通就跑 `<安装目录>\node.exe cli.js open --project <产物目录>`（**不走 `cmd /c`**：中文路径加引号转义会被 cmd 吃掉，报「不是内部或外部命令」），并预喂 `y` 应答端口确认，25s 超时。
4. 服务端口没开时不会假装成功，返回 `needsServicePort: true`，胶囊提示「服务端口没开」。

另外：检测 IDE 是否已运行用绝对路径的 `tasklist.exe`，并把「服务端口已开」也视为已运行，
避免重复拉起导致开两个窗口。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/devproc/status` | 快照（含 `agent`、`procs[]`） |
| GET | `/api/devproc/stream` | SSE 推送 |
| GET/POST | `/api/devproc/config` | 读写设置，热生效 |
| POST | `/api/devproc/stop` | `{pid}` 只关一条，不传则全关 |
| POST | `/api/devproc/open` | `{target}` 打开 URL 或项目内目录 |
| POST | `/api/devproc/wechat` | `{target}` 用开发者工具打开产物目录 |
| GET/POST | `/api/devproc/agent` | 读取 / 上报改动状态 |

## 开发

- 服务端 `lib/index.js`：改完要在 设置 → 插件 里把 `dsh-devproc` 关再开（或重启 App），文件改动不会热更。
- 客户端 `lib/client.js`：刷新页面即可。
- 调试接口时注意 DSH Web 端口每次启动可能变化，用当前 GUI 地址。

## License

MIT
