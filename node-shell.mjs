#!/usr/bin/env node
// node-shell.mjs — 节点交互 shell(逐条经 system.run 执行,cwd 持久化)
// 非 PTY:vim/htop 等全屏交互程序不可用;svn/npm/docker/ls 等构建运维命令均可用。
// TTY 下启用逐键读取 + Tab 补全(目录/文件);管道下退回按行读取。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnNode } from "./gw-sysrun.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(DIR, ".node-term-profile.json");

let node = null;
const wantReuse = process.argv.includes("--reuse");
const preSelectedId = process.env.NODE_TERM_SELECTED_NODE_ID;
if (wantReuse) { try { node = JSON.parse(readFileSync(PROFILE, "utf8")); } catch {} }

function listNodes() {
  return new Promise((resolve, reject) => {
    const p = spawn("openclaw", ["nodes", "status", "--connected", "--json"], { shell: false });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", () => {});
    p.on("error", reject);
    p.on("close", () => {
      let nodes = [];
      try {
        const parsed = JSON.parse(out || "{}");
        nodes = (Array.isArray(parsed?.nodes) ? parsed.nodes : (Array.isArray(parsed) ? parsed : []))
          .filter((n) => n?.connected !== false && n?.nodeId);
      } catch {}
      resolve(nodes);
    });
  });
}

// ---- 行读取器(管道模式用,永不 close stdin) ----
const lineQ = [];
const lineWaiters = [];
function ensureStdinReader() {
  if (ensureStdinReader._done) return;
  ensureStdinReader._done = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    String(chunk).split(/\r?\n/).forEach((ln) => {
      const line = ln;
      if (!line.length) return;
      if (lineWaiters.length) lineWaiters.shift()(line);
      else lineQ.push(line);
    });
  });
  process.stdin.on("end", () => { while (lineWaiters.length) lineWaiters.shift()(null); });
}
const ask = (prompt) => new Promise((r) => {
  ensureStdinReader();
  if (lineQ.length) { if (prompt) process.stdout.write(prompt); return r(lineQ.shift()); }
  if (prompt) process.stdout.write(prompt);
  lineWaiters.push(r);
});

if (!node) {
  if (preSelectedId) {
    try { node = JSON.parse(readFileSync(PROFILE, "utf8")); } catch {}
    if (!node || node.nodeId !== preSelectedId) node = { nodeId: preSelectedId, displayName: preSelectedId, platform: "linux" };
  } else {
    const nodes = await listNodes();
    if (nodes.length === 0) { console.log("无在线节点"); process.exit(1); }
    console.log("在线节点:");
    nodes.forEach((n, i) => console.log(`  ${i + 1}) ${n.displayName || n.nodeId}  (${n.platform || "?"})`));
    const sel = (await ask(`选择序号 [1-${nodes.length}]: `)).trim();
    if (!/^\d+$/.test(sel) || Number(sel) < 1 || Number(sel) > nodes.length) { console.error("无效序号"); process.exit(2); }
    node = nodes[Number(sel) - 1];
    const { writeFileSync } = await import("node:fs");
    writeFileSync(PROFILE, JSON.stringify(node, null, 2));
  }
}

const nodeId = node.nodeId;
const isWindows = (node.platform || "").toLowerCase() === "windows";

console.log(`节点 shell:${node.displayName || nodeId} (${node.platform || "?"})`);
if (isWindows) {
  console.log("注意:Windows 节点无 cwd 持久化,每条命令独立执行。\n");
} else {
  console.log("说明:逐条执行,cd 记住;Tab 补全目录/文件;vim/htop 等全屏程序不可用;exit 退出。\n");
}

let cwd = "";

function promptNow() { return `\n${node.displayName || "node"}${cwd ? ":" + cwd : ""}$ `; }

// shell 单引号转义:内含 ' $ ` " ; ( ) 一律字面安全。
// ⚠ 不能用 JSON.stringify(双引号):bash 双引号里 $(...) 和 `...` 会被执行,存在命令注入!
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function buildCommand(line) {
  if (isWindows) return line;
  const prefix = cwd
    ? `cd ${shq(cwd)} 2>/dev/null || { printf '[目录不存在,已回退到家目录]\n' >&2; cd "$HOME" || true; }; `
    : "";
  return `${prefix}${line}\n_rc=$?\nprintf '\\n__RC=%s__\\n' "$_rc"\npwd`;
}

function parseOut(raw) {
  const text = raw ?? "";
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length >= 2) {
    const pwdLine = lines[lines.length - 1];
    const rcLine = lines[lines.length - 2];
    const m = rcLine.match(/^__RC=(-?\d+)__$/);
    if (m && pwdLine.startsWith("/")) {
      let body = lines.slice(0, -2);
      // printf 前导 \n 造成的人为空行:去掉一个(真实输出末尾的空行保留一个)
      if (body.length && body[body.length - 1] === "") body.pop();
      const display = body.length ? body.join("\n") + "\n" : "";
      return { rc: Number(m[1]), cwd: pwdLine, display };
    }
  }
  return { rc: null, cwd: null, display: text };
}

// ---- Tab 补全:发去节点跑 ls -d,取候选 ----
async function completeToken(token) {
  if (isWindows) return null;
  // 绝对路径不拼 cwd;~ 开头交给 bash 展开,不拼;其余相对路径才拼 cwd
  const isTilde = token.startsWith("~");
  const full = token.startsWith("/") || isTilde ? token : (cwd ? `${cwd}/${token}` : token);
  let dirPart, base;
  if (full.includes("/")) {
    dirPart = full.slice(0, full.lastIndexOf("/")) || "/";
    base = full.slice(full.lastIndexOf("/") + 1);
  } else {
    dirPart = cwd || ".";
    base = token;
  }
  // 目录部分整段单引号包裹(shq);base 用 shq 后跟裸 *(引号紧贴 * 时 bash 仍会展开 glob,
  // 但 $/` 等在引号内不再被执行 —— 防恶意文件名注入)。
  // 注:glob 的 * 本身不能被引号包住,即引号须包 base 主体、* 留在引号外:bash 把
  // 'fo'* 视为引号内字面 fo 接通配展开,行为与裸写 fo* 等价。
  const dirQuoted = dirPart === "/" ? "/" : `${shq(dirPart)}/`;
  const cmd = `ls -d1 ${dirQuoted}${shq(base)}* 2>/dev/null || true`;
  const res = await runOnNode({ nodeId, command: cmd, timeoutMs: 10000 });
  const entries = (res.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return null;
  const names = entries.map((e) => (e.includes("/") ? e.slice(e.lastIndexOf("/") + 1) : e));
  let common = names[0];
  for (const n of names) {
    let i = 0;
    while (i < common.length && i < n.length && common[i] === n[i]) i++;
    common = common.slice(0, i);
  }
  return { names, common, base };
}

// ================= 主循环 =================
// TTY:逐键读取(Tab 补全);非 TTY:按行读取
const isTTY = !!process.stdin.isTTY;

if (isTTY && !isWindows) {
  await runRawMode();
} else {
  await runLineMode();
}

async function runLineMode() {
  process.stdout.write(promptNow());
  while (true) {
    const raw = await ask();
    if (raw === null) break;
    const line = raw.trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    await execLine(line);
    process.stdout.write(promptNow());
  }
  console.log("\n已退出节点 shell。");
}

async function execLine(line) {
  try {
    const res = await runOnNode({ nodeId, command: buildCommand(line), timeoutMs: 600000 });
    if (!isWindows) {
      const p = parseOut(res.stdout);
      if (p.cwd && p.cwd !== cwd) {
        if (cwd && line.trim().startsWith("cd")) process.stdout.write(`(已切换到 ${p.cwd})\n`);
        cwd = p.cwd;
      }
      if (p.display) process.stdout.write(p.display);
      if (res.stderr) process.stderr.write(res.stderr);
      if (p.rc !== null && p.rc !== 0) process.stdout.write(`[退出码 ${p.rc}]\n`);
    } else {
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
    }
  } catch (e) {
    console.error(`[执行失败] ${e.message}`);
  }
}

// ---- 原始模式逐键读取 ----
async function runRawMode() {
  const stdin = process.stdin;
  try { stdin.setRawMode && stdin.setRawMode(true); } catch {}
  stdin.setEncoding("utf8");
  stdin.resume();

  let lineBuf = "";   // 当前行已输入内容
  let cursor = 0;     // 光标位置(相对 lineBuf)

  // ---- 历史命令 ----
  const history = [];          // 已提交的命令(去重,不含 exit/quit/空)
  let histIdx = -1;            // -1=当前行;0..len-1=浏览历史
  let histDraft = "";          // 上翻前暂存的未提交输入

  const pushHistory = (line) => {
    const t = line.trim();
    if (!t) return;
    if (history[history.length - 1] === t) return; // 连续相同去重
    history.push(t);
  };

  const redraw = () => {
    // 清行 + 重绘:\r 回行首 → prompt+lineBuf → \x1b[K 清到行尾(旧行比新行长时必须清残留)→ 光标定位
    process.stdout.write(`\r${promptNow().replace(/^\n/, "")}${lineBuf}\x1b[K`);
    // 光标定位
    const move = lineBuf.length - cursor;
    if (move > 0) process.stdout.write(`\x1b[${move}D`);
  };

  process.stdout.write(promptNow());

  // ---- 方向键/编辑键:替换当前行内容并重绘 ----
  const setLine = (text) => {
    lineBuf = text;
    cursor = text.length;
    redraw();
  };

  const handleKey = (key) => {
    if (key === "up") {
      if (history.length === 0) return;
      if (histIdx === -1) { histDraft = lineBuf; histIdx = history.length - 1; }
      else if (histIdx > 0) histIdx--;
      setLine(history[histIdx]);
    } else if (key === "down") {
      if (histIdx === -1) return;
      if (histIdx >= history.length - 1) {
        histIdx = -1;
        setLine(histDraft);
      } else {
        histIdx++;
        setLine(history[histIdx]);
      }
    } else if (key === "left") {
      if (cursor > 0) { cursor--; redraw(); }
    } else if (key === "right") {
      if (cursor < lineBuf.length) { cursor++; redraw(); }
    } else if (key === "home") {
      cursor = 0; redraw();
    } else if (key === "end") {
      cursor = lineBuf.length; redraw();
    } else if (key === "delete") {
      if (cursor < lineBuf.length) { lineBuf = lineBuf.slice(0, cursor) + lineBuf.slice(cursor + 1); redraw(); }
    }
  };

  let busy = false;            // 正在执行远端命令时缓冲输入,防并发执行
  const backlog = [];          // 执行期间收到的按键

  const handleChar = async (ch) => {
    if (ch === "\r" || ch === "\n") {
      // 提交
      process.stdout.write("\n");
      const line = lineBuf;
      lineBuf = ""; cursor = 0;
      histIdx = -1; histDraft = "";
      if (line.trim() === "exit" || line.trim() === "quit") { shutdown(); return; }
      if (line.trim()) {
      pushHistory(line);
      busy = true;
      try { await execLine(line); } finally { busy = false; drainBacklog(); }
        process.stdout.write(promptNow());
      } else {
        process.stdout.write(promptNow());
      }
      return;
    } else if (ch === "\x03") { // Ctrl-C
      process.stdout.write("^C\n");
      lineBuf = ""; cursor = 0;
      histIdx = -1; histDraft = "";
      process.stdout.write(promptNow());
      return;
    } else if (ch === "\x04") { // Ctrl-D 空行退出
      if (!lineBuf) { process.stdout.write("\n已退出节点 shell。\n"); shutdown(); return; }
      // 非空行:当作删除
      if (cursor < lineBuf.length) { lineBuf = lineBuf.slice(0, cursor) + lineBuf.slice(cursor + 1); }
      redraw();
      return;
    } else if (ch === "\t") { // Tab 补全
      await doTabComplete();
      return;
    } else if (ch === "\x7f" || ch === "\b") { // 退格
      if (cursor > 0) { lineBuf = lineBuf.slice(0, cursor - 1) + lineBuf.slice(cursor); cursor--; }
      redraw();
      return;
    } else if (ch === "\x01") { // Ctrl-A 行首
      cursor = 0; redraw(); return;
    } else if (ch === "\x05") { // Ctrl-E 行尾
      cursor = lineBuf.length; redraw(); return;
    } else if (ch === "\x0c") { // Ctrl-L 清屏
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(promptNow());
      redraw();
      return;
    } else if (ch >= " " && ch !== "\x7f") { // 可打印字符
      lineBuf = lineBuf.slice(0, cursor) + ch + lineBuf.slice(cursor);
      cursor++;
      redraw(); // 光标中间插入时,终端覆盖式写字符会吃掉后一个字符,必须重绘
    }
  };

  // ---- ESC 序列解析(方向键/Home/End/Delete 等) ----
  // 方向键是 ANSI 转义序列(如上键 \x1b[A),可能跨多个 data chunk 到达,
  // 因此用 escBuf 累积 + 超时兜底,而不是逐字符直接分发。
  let escBuf = "";
  let escTimer = null;
  const ESC_SEQS = {
    "\x1b[A": "up", "\x1b[B": "down",
    "\x1b[C": "right", "\x1b[D": "left",
    "\x1bOA": "up", "\x1bOB": "down",   // SS3 变体(application cursor mode 下部分终端发送)
    "\x1bOC": "right", "\x1bOD": "left",
    "\x1b[H": "home", "\x1b[F": "end",
    "\x1b[1~": "home", "\x1b[4~": "end", "\x1b[3~": "delete"
  };
  const resolveEscape = (buf) => {
    // 完整匹配返回键名;若是某个已知序列的前缀返回 null(等更多字节);否则返回 undefined(丢弃)
    let isPrefix = false;
    for (const seq of Object.keys(ESC_SEQS)) {
      if (seq === buf) return ESC_SEQS[seq];
      if (seq.startsWith(buf)) isPrefix = true;
    }
    return isPrefix ? null : undefined;
  };

  const dispatch = (chunk) => {
    if (busy) { backlog.push(chunk); return; } // 命令执行期间只缓冲不消费(顺序执行,防并发)
    for (const ch of chunk) {
      if (escBuf) {
        escBuf += ch;
        const key = resolveEscape(escBuf);
        if (key) { clearTimeout(escTimer); escBuf = ""; handleKey(key); }
        else if (key === undefined) { clearTimeout(escTimer); escBuf = ""; }
        continue;
      }
      if (ch === "\x1b") {
        escBuf = "\x1b";
        clearTimeout(escTimer);
        escTimer = setTimeout(() => { escBuf = ""; }, 80); // 孤立 ESC 超时丢弃
        continue;
      }
      handleChar(ch);
    }
  };

  const drainBacklog = () => {
    while (backlog.length) {
      const chunk = backlog.shift();
      for (const ch of chunk) handleChar(ch);
    }
  };

  async function doTabComplete() {
    try {
    const before = lineBuf.slice(0, cursor);
    const m = before.match(/([^\s]*)$/);
    const token = m ? m[1] : "";
    if (!token) return;
    const result = await completeToken(token);
    if (!result) return;
    if (result.names.length === 1) {
      // 唯一候选:直接补全
      const completion = result.names[0];
      const ins = completion.slice(result.base.length);
      // 判断目录则加 /
      const isDir = await isDirectory(completion);
      const suffix = isDir ? "/" : "";
      const fullIns = ins + suffix;
      lineBuf = lineBuf.slice(0, cursor) + fullIns + lineBuf.slice(cursor);
      cursor += fullIns.length;
      redraw();
    } else {
      // 多候选:补到公共前缀,再换行列候选
      const ins = result.common.slice(result.base.length);
      if (ins) {
        lineBuf = lineBuf.slice(0, cursor) + ins + lineBuf.slice(cursor);
        cursor += ins.length;
      }
      process.stdout.write("\n" + result.names.map((n) => "  " + n).join("\n") + "\n");
      redraw();
    }
    } catch (e) { process.stderr.write(`[TAB ERR ${e.message}]`); }
  }

  function isDirectory(name) {
    // name 可能是补全出的相对名字;判断时同样区分绝对/相对路径
    const p = name.startsWith("/") || name.startsWith("~") ? name : (cwd ? cwd + "/" + name : name);
    return runOnNode({ nodeId, command: `[ -d ${shq(p)} ] && echo yes || echo no`, timeoutMs: 5000 })
      .then((r) => (r.stdout || "").trim() === "yes");
  }

  function shutdown() {
    try { stdin.setRawMode && stdin.setRawMode(false); } catch {}
    process.exit(0);
  }

  stdin.on("data", (chunk) => dispatch(chunk));
  stdin.on("end", shutdown);
}