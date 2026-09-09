# node-term — 交互式节点操作入口(通道 B)

可移植单目录脚本包:整目录拷贝到任意位置即可运行,无需改任何路径。

## 文件
- `cli.sh`             主入口:列节点 → 序号选择 → 进节点 shell(`--gateway` 进网关 PTY)
- `node-term.mjs`      节点选择器(选完把 stdin 交给子进程)
- `node-shell.mjs`     节点 shell(逐条经 system.run 执行,cd 持久化,exit 退出)
- `gateway-term.mjs`   网关 PTY 客户端(连接 Gateway terminal.* RPC)
- `gw-sysrun.mjs`      节点命令底层(经 node.invoke system.run)
- `node-exec`          单条转发命令到已选节点
- `gw-pass`            (可选)网关密码,权限 600;不提交版本库

## 前置
1. 网关宿主机已装 openclaw CLI 且 `openclaw nodes status --connected --json` 有输出
2. Node v24+(内置 WebSocket;网关宿主机默认就有)
3. 网关密码:三选一 —— 环境变量 `GW_PASSWORD` / 本目录 `gw-pass` 文件 / 环境变量 `API_KEY`

## 用法
```bash
# 节点 shell(默认):列出节点 → 输序号 → 逐条执行节点命令,cd 会记住
./cli.sh

# 网关宿主机完整终端(bash TTY,方向键/Tab/颜色正常)
./cli.sh --gateway

# 单条转发命令到已选节点
./node-exec ls -la
./node-exec 'svn info'
./node-exec 'docker ps'
./node-exec 'echo hello && hostname'
```

## 说明
- **节点 shell** 逐条经 `node.invoke(system.run)` 执行,`cd` 会持久化;`vim`/`htop`
  等全屏程序不可用,`svn`/`npm`/`docker`/`ls` 等构建运维命令均可用,`exit` 退出。
  Windows 节点自动用 `cmd /d /c` 执行(无 cwd 持久化/Tab 补全)。
- **Tab 补全**(仅 TTY 下,即真实终端里):按 Tab 补全目录/文件路径。唯一候选直接补
  全(目录自动加 `/`);多候选列出来并补到公共前缀。管道/非 TTY 下无补全(退回按行)。
- **历史与行编辑**(仅 TTY 下):支持终端常用快捷键 ——
  - `↑` / `↓`:切换历史命令(去重,仅存当前会话内存)
  - `←` / `→`:左右移动光标
  - `Home` / `End` 或 `Ctrl-A` / `Ctrl-E`:行首 / 行尾
  - `Ctrl-L`:清屏;
- **网关 PTY** 是网关宿主机完整终端,`build200.sh` 等跑在网关本机的场景用这个。
- 操作节点命令实际走 Gateway 底层 `node.invoke(system.run)`,需节点 exec 审批为 full;
  CLI 层 `system.run` 封禁不作用于底层 RPC。