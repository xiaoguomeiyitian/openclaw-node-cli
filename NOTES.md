# node-term 备忘(踩坑记录 / 协议约束)

本目录是可移植单目录脚本包:整目录拷贝到任意位置即可运行,依赖网关宿主机已有的
`openclaw` CLI + Node v24+(内置 WebSocket)。所有脚本用 `import.meta.url` 定位同目录文件,
无绝对路径硬编码。

## 文件职责

| 文件 | 作用 |
| --- | --- |
| `cli.sh` | 主入口:列节点 → 序号选择 → 进节点 shell(`--gateway` 进网关 PTY) |
| `node-term.mjs` | 节点选择器(选完接管 stdin 传给子进程) |
| `node-shell.mjs` | 节点 shell(逐条经 `system.run` 执行,cd 持久化,exit 退出) |
| `gateway-term.mjs` | 网关 PTY 客户端(连 Gateway `terminal.*` RPC) |
| `gw-sysrun.mjs` | 节点命令执行底层(经底层 RPC `node.invoke` + `system.run`) |
| `node-exec` | 转发命令到已选节点(读同目录 `.node-term-profile.json`) |
| `README.md` | 用法说明 |
| `NOTES.md` | 本备忘 |

## 认证(按优先级)

1. 环境变量 `GW_PASSWORD`
2. 本目录 `gw-pass` 文件(600,不提交版本库)
3. 环境变量 `API_KEY`(网关配置里 `gateway.auth.password` 写作 `${API_KEY}`,运行时从环境展开)

> ⚠️ 踩坑记录:网关真正的密码是**容器 PID 1 环境里的 `API_KEY`**(8 字符),不是
> 交互 shell 里 OpenClaw 注入的那个同名 `API_KEY`。两者同名不同值。若在本地 shell
> 直接跑 `./cli.sh` 连不上,先确认 shell 里的 `API_KEY` 是否等于 PID 1 的。
> 真密码可取 `cat /proc/1/environ | tr '\0' '\n' | grep '^API_KEY=' | cut -d= -f2-`。

## 关键协议约束(连真实网关才暴露,务必遵守)

以下三条如果回退,会立刻报错,别重踩:

### 1. `connect` 的 `client.id` / `client.mode` 必须是合法枚举值

- `client.id` 仅接受 `GATEWAY_CLIENT_IDS`(operator CLI 连接用 `"cli"`)
- `client.mode` 仅接受 `GATEWAY_CLIENT_MODES`(operator CLI 用 `"cli"`)
- 写自定义名(如 `"node-term-client"`)会报:
  `invalid connect params: at /client/id: must be equal to one of the allowed values`
- 正确形态:
  ```js
  client: { id: "cli", version: "1.0.0", platform: "linux", mode: "cli" }
  ```

### 2. `node.invoke` 必须带 `idempotencyKey`

- 缺了会报:`invalid node.invoke params: must have required property 'idempotencyKey'`
- 用 `crypto.randomUUID()` 生成即可。

### 3. `system.run` 的 `command` 是 argv 数组,不是字符串

- 复合 shell 命令必须用 `bash -lc` 封装成 argv:
  ```js
  // 错(会报 INVALID_REQUEST: command required)
  params: { command: "echo x && hostname" }

  // 对
  params: { command: ["bash", "-lc", "echo x && hostname"], cwd: "...", timeoutMs: ... }
  ```
- 想纯字符串形式则同时传 `rawCommand`(但 `rawCommand` 必须与 argv 规范化结果一致,
  否则报 `RAW_COMMAND_MISMATCH`)。当前实现只用了 argv 数组,未用 rawCommand。

## 网关连接事实(2026-09-08 核实)

- Gateway WS:`ws://127.0.0.1:20000`,`gateway.auth.mode = "password"`,`gateway.bind = "lan"`
- 认证字段:`connect.params.auth.password`(password 模式)
- operator 连接需 `role: "operator"` + `scopes: ["operator.admin"]`(node 命令 + 终端都是 admin 面)

## 终端本质(易误解点)

- `terminal.open` 起的是 **Gateway 宿主机的 PTY**,不是节点 shell
  实测:`[终端已启动: /bin/bash @ /root/.openclaw/workspace]`
- 节点侧没有通用 shell PTY 命令;唯一例外是插件拥有的 `codex.cli.session.resume`
  (Codex 专用会话 relay,非通用 bash)
- 因此「操作节点」分两种:
  - **节点 shell**(默认,`./cli.sh`):逐条 `node.invoke(system.run)`,cd 持久化,非全屏
  - **网关 PTY**(`./cli.sh --gateway`):网关宿主机完整 bash TTY

## 已验证可用的调用链(端到端实测)

```bash
cd /root/cli
./cli.sh                 # 列节点 → 选序号 → 进节点 shell(交互)
./cli.sh --gateway       # 进网关宿主机完整终端
./node-exec 'cmd'        # 单条转发到已选节点
```

实测结果:节点 shell 的 `cd`/`ls`/`svn info`/复合命令均正常,cwd 持久化、exitCode 透传。

## stdin 处理(踩坑记录)

- Node `readline` 一轮 `close` 后会把整条 stdin 流关闭,后续 listener 再也收不到数据。
  这是「选序号」和「进 shell」两阶段各自 new readline 时的坑(管道模式下暴露,TTY 无感)。
- 解法:全目录统一用**自带行读取器**(`process.stdin.on("data")` 累积
  `lineQ[]` + `lineWaiters[]`),永不 close stdin;父进程选完序号后把缓冲的行
  写进子进程 stdin(`pipe`),再由子进程自己的行读取器消费。
- **TTY 下才进 raw mode**:node-term 用 `process.stdin.isTTY` 判断,TTY 用
  `stdio:"inherit"` 让 node-shell 拿到真实 fd 开 `setRawMode(true)` 逐键读;
  非 TTY(管道)退回按行读。

## Tab 补全(方案 B,TTY 下生效)

- 核心:raw mode 逐字符读 → 按 Tab 时取光标前最后 token → 发去节点跑
  `ls -d1 <dir>/<token>*` → 回填/列候选。
- **坑:glob 的 `*` 不能加引号**,否则 shell 不展开通配符(返回空)。只对目录部分
  做单引号转义,`*` 处保持裸写。
- **坑:`data` 事件 chunk 可能是多字符**(非逐字符),必须 `for (const ch of chunk)`
  逐字遍历;若把整 chunk 当单字符,`cursor` 只 +1 但 lineBuf 加了 N 字符,补全 token
  会取错。
- 目录补全自动加 `/`;多候选列出来并补到公共前缀。

## 方向键 / 历史命令(TTY 下)

自研的 raw mode 逐键读取器现已支持终端常用快捷键。核心是 **ESC 转义序列状态机**:

- 方向键是 ANSI 转义序列(如上键 `\x1b[A`、下键 `\x1b[B`、左键 `\x1b[D`、右键
  `\x1b[C`),**可能跨多个 `data` chunk 到达**,不能用逐字符直接分发,否则会把 `[A`
  等字节当普通字符插进行缓冲(乱码)。
- 解法:`escBuf` 累积 + `resolveEscape()` 前缀匹配(完整命中→返回键名;是某已知序列
  前缀→等更多字节;否则丢弃)+ 80ms 超时兜底(孤立 ESC)。
- 键位表:`↑/↓` 翻历史、`←/→` 移光标、`Home/End` 与 `Ctrl-A/E` 行首行尾、`Delete`
  删右侧字符、`Ctrl-L` 清屏。
- 历史:`history[]` 只存当前会话内存(去重、不含 exit/quit/空),`histIdx` 从 -1(当前
  行)往上翻时先把未提交输入暂存进 `histDraft`,翻到底再恢复。
- 坑:历史/方向键只在 `isTTY` 分支生效;管道模式(`runLineMode`)不处理 ESC,与 Tab
  补全一致,不影响 `echo ... | ./cli.sh` 这类管道用法。