# dsh-devproc

输入框上方的开发进程胶囊：显示 `/api/devproc/status` 里跑着的 dev server（uni 小程序 / H5 / 后端），
带复制地址、打开浏览器、打开产物目录、「微」开微信开发者工具、关进程。

## 安装

```powershell
# 1) 克隆到任意位置
git clone https://github.com/<你的账号>/dsh-devproc.git "$HOME\.dsh\plugins\dsh-devproc"

# 2) 让 profile 认出它（等价于 pnpm link 进 node_modules）
cd "$HOME\.dsh\profiles\desktop"
#   package.json 的 dependencies 里加：  "dsh-devproc": "link:../../plugins/dsh-devproc"
#   dsh.profile.bundles 里加：           "dsh-devproc"
pnpm install

# 3) 重启 DSH（或 设置 → 插件 里关/开 dsh-devproc）
```

也可以不装成 bundle，而是在 `~/.dsh/profiles/<你的 profile>/cordis.patch.yml` 里直接插入：

```yaml
- insert:
    - id: devproc
      name: dsh-devproc
```

卸载：`node uninstall.mjs`。

## 配置项

设置页 →「终端进程」：刷新间隔、项目路径（留空用当前工作区）、只显示平台、URL 真实探测、微信开发者工具 `cli.bat` 路径。
配置文件写在 `~/.dsh/dsh-devproc.config.json`。

## 代理改动标记（1.1.0）

胶囊上多一个状态标签，表示「当前这份代码是不是在被改 / 改完了」：

| 状态 | 显示 | 触发 |
| --- | --- | --- |
| `editing` | 琥珀色呼吸点 + `正在修改` | 项目 `src` 下文件变动，或代理 POST 上报 |
| `done` | 绿点 + `已改好 ✓` | 文件变动静默 2.5s，或代理 POST `done`；保持 3 分钟后回到就绪 |
| `idle` | 无标签 | 默认 |

没有 dev 进程时，只要状态是 editing/done 也会单独显示一枚胶囊。

自动来源：`fs.watch` 递归盯 `<项目>/src`（无 src 则盯项目根），忽略 `node_modules/.git/dist/.cache/unpackage/tmp`。

手动上报（代理用，UTF-8 JSON）：

```powershell
$body = '{"state":"editing","note":"改首页 tab"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/api/devproc/agent -ContentType application/json -Body $body
# done / idle 同理：{"state":"done"}  {"state":"idle"}
```

`GET /api/devproc/agent` 读当前状态与正在监视的目录。

## 接口

- `GET /api/devproc/status` 快照（含 `agent`）
- `GET /api/devproc/stream` SSE（变化即推送，15s 心跳）
- `GET|POST /api/devproc/config` 设置
- `POST /api/devproc/stop` 关进程（`{pid}` 只关一条）
- `POST /api/devproc/open` 打开 URL / 目录
- `POST /api/devproc/wechat` 微信开发者工具打开产物目录

### 「微」按钮为什么会打开错项目

微信开发者工具自己会恢复上次的项目，只有走它的 CLI / 服务端口才能指定项目。所以：

1. IDE 设置 → 安全设置 → **服务端口** 开启（一次即可，之后 `.ide-status` 为 `On`）。
2. 插件读 `%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\Default\.ide` 拿端口；`/open?projectpath=` 能通就切过去（`method: "rest"`）。
3. 否则起 `<安装目录>\node.exe cli.js open --project <产物目录>`（不走 `cmd /c`，中文路径 + 引号转义会被 cmd 吃掉），并预喂 `y` 应答端口确认，超时 25s。
4. 端口没开时返回 `needsServicePort: true`，胶囊提示「服务端口没开」。
- `GET|POST /api/devproc/agent` 代理改动状态

改完服务端代码需要在设置 → 插件里关再开 `dsh-devproc`（或重启 App）才会重载；客户端代码刷新页面生效。
