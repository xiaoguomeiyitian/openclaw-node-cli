#!/usr/bin/env node
// node-term.mjs — 交互式节点选择器
// 默认:选节点后进入 node-shell(逐条经 system.run 执行,cd 持久化)。
// --gateway:进入网关宿主机完整 PTY(gateway-term.mjs)。
// 可移植:整目录拷到任意位置即可运行。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(DIR, ".node-term-profile.json");
const GATEWAY_TERM = join(DIR, "gateway-term.mjs");
const NODE_SHELL = join(DIR, "node-shell.mjs");
const useGateway = process.argv.includes("--gateway");

// ---- 嵌套防护:已在网关持久终端(OPENCLAW_TERMINAL=1)里时,--gateway 会造成
// 「持久终端套持久终端」——关浏览器 tab 不会断链,残留进程会一直活着。
// 这种场景下直接拒绝并引导用户用节点 shell(默认模式)。
if (useGateway && process.env.OPENCLAW_TERMINAL === "1") {
  console.log("当前已在网关持久终端里(OPENCLAW_TERMINAL=1)。");
  console.log("再开 --gateway 会嵌套持久终端,关闭页面后进程会残留,已阻止。");
  console.log("操作节点请直接用默认节点 shell: ./cli.sh");
  console.log("(如确实需要新开一个网关终端,请在 Control UI 新开终端窗口)");
  process.exit(1);
}

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


const nodes = await listNodes();
if (nodes.length === 0) {
  console.log("无在线节点(请确认 openclaw nodes status --connected 有输出)");
  process.exit(1);
}
console.log("在线节点:");
nodes.forEach((n, i) => console.log(`  ${i + 1}) ${n.displayName || n.nodeId}  (${n.platform || "?"})`));

// 统一行读取器(管道/TTY 都可靠);注意不 close stdin,后续子进程要继承
const lineQ = [];
const lineWaiters = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  String(chunk).split(/\r?\n/).forEach((ln) => {
    const line = ln.trim();
    if (!line) return;
    if (lineWaiters.length) lineWaiters.shift()(line);
    else lineQ.push(line);
  });
});
process.stdin.on("end", () => { while (lineWaiters.length) lineWaiters.shift()(null); });
const ask = (prompt) => new Promise((r) => {
  if (lineQ.length) { process.stdout.write(prompt || ""); return r(lineQ.shift()); }
  process.stdout.write(prompt || "");
  lineWaiters.push(r);
});

const sel = (await ask(`选择序号 [1-${nodes.length}]: `)) ?? "";
if (!/^\d+$/.test(sel) || Number(sel) < 1 || Number(sel) > nodes.length) {
  console.error("无效序号");
  process.exit(2);
}
const node = nodes[Number(sel) - 1];
writeFileSync(PROFILE, JSON.stringify(node, null, 2));
console.log(`→ 节点已选: ${node.displayName || node.nodeId}`);
if (useGateway) {
  console.log("  正在进入网关宿主机完整终端(交互式 bash;full TTY)...");
} else {
  console.log("  正在进入节点 shell(逐条执行,cd 持久化;exit 退出)");
  console.log("  如需网关本机完整终端,运行: ./cli.sh --gateway");
}

// 把剩余 stdin 传给子进程;并把已选节点通过 env 直接传下去(不靠 profile 中转)
process.stdin.pause();
const parentIsTTY = !!process.stdin.isTTY;
const child = spawn(process.execPath, [useGateway ? GATEWAY_TERM : NODE_SHELL], {
  stdio: parentIsTTY ? "inherit" : ["pipe", "inherit", "inherit"],
  env: { ...process.env, NODE_TERM_SELECTED_NODE_ID: node.nodeId },
});
if (parentIsTTY) {
  // TTY:直接继承,node-shell 能用 raw mode 做 Tab 补全
} else {
  // 非 TTY(管道):把已缓冲的行写进 child stdin
  const buffered = lineQ.splice(0, lineQ.length).map((s) => s + "\n").join("");
  child.stdin.write(buffered + "\n");
  process.stdin.pipe(child.stdin);
}
child.on("close", (code) => {
  console.log(`\n[已退出,退出码 ${code ?? 0}]`);
  process.exit(code ?? 0);
});
