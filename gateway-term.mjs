#!/usr/bin/env node
// gateway-term.mjs — 经 Gateway terminal.* RPC 起一个完整 PTY(网关侧)
// 可移植:与本目录其他文件放在一起。认证优先读同目录 gw-pass 文件,其次环境变量。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

// 网关地址与密码:环境变量 > 同目录配置文件 > 默认
const GW_URL = process.env.GW_WS_URL || "ws://127.0.0.1:20000";
const GW_PASSWORD = process.env.GW_PASSWORD
  || (() => { try { return readFileSync(join(DIR, "gw-pass"), "utf8").trim(); } catch { return ""; } })()
  || (() => { try { return readFileSync(join(homedir(), ".openclaw-gw-pass"), "utf8").trim(); } catch { return ""; } })()
  || process.env.API_KEY
  || "";

if (!GW_PASSWORD) {
  console.error("缺网关密码:设 GW_PASSWORD 环境变量,或在本目录放 gw-pass 文件(600),或设 API_KEY");
  process.exit(1);
}

const ws = new WebSocket(GW_URL);
let nextId = 1;
const pending = new Map();
let ready = false;
const buffered = [];
let sessionId = null;

const send = (method, params) => {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ type: "req", id, method, params })); }
    catch (e) { pending.delete(id); reject(e); }
  });
};

const flush = () => {
  for (const d of buffered) process.stdout.write(d);
  buffered.length = 0;
};

const cleanup = async () => {
  if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
  if (sessionId && ws.readyState === 1) {
    try { await send("terminal.close", { sessionId }); } catch {}
  }
  try { ws.close(); } catch {}
  process.exit(0);
};

ws.onmessage = (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === "res") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m.payload) : p.reject(new Error(m.error?.message || m.error?.code || "RPC error"));
  } else if (m.type === "event") {
    if (m.event === "terminal.data") {
      const d = m.payload?.data || "";
      ready ? process.stdout.write(d) : buffered.push(d);
    } else if (m.event === "terminal.exit") {
      console.error(`\n[终端已结束: ${m.payload?.reason || "closed"}]`);
      cleanup();
    }
  }
};
ws.onclose = () => { console.error("\n[网关连接已断开]"); process.exit(1); };
ws.onerror = () => {}; // 连接失败由 onclose 兜底

ws.onopen = async () => {
  try {
    await send("connect", {
      minProtocol: 4, maxProtocol: 4,
      client: { id: "cli", version: "1.0.0", platform: "linux", mode: "cli" },
      role: "operator", scopes: ["operator.admin"],
      auth: { password: GW_PASSWORD },
      caps: [], commands: []
    });
    const cols = (process.stdout.isTTY && process.stdout.columns) || 80;
    const rows = (process.stdout.isTTY && process.stdout.rows) || 24;
    const openPayload = await send("terminal.open", { cols, rows });
    sessionId = openPayload.sessionId;
    ready = true; flush();
    console.error(`[终端已启动: ${openPayload.shell} @ ${openPayload.cwd}]`);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (d) => {
        try { ws.send(JSON.stringify({ type: "req", id: String(nextId++), method: "terminal.input", params: { sessionId, data: d.toString("utf8") } })); } catch {}
      });
    }
    const doResize = () => {
      const c = process.stdout.columns, r = process.stdout.rows;
      try { ws.send(JSON.stringify({ type: "req", id: String(nextId++), method: "terminal.resize", params: { sessionId, cols: c || 80, rows: r || 24 } })); } catch {}
    };
    process.stdout.on("resize", doResize);
    process.on("SIGINT", () => {
      try { ws.send(JSON.stringify({ type: "req", id: String(nextId++), method: "terminal.input", params: { sessionId, data: "\x03" } })); } catch {}
    });
    process.on("SIGTERM", cleanup);
  } catch (e) {
    console.error("终端启动失败:", e.message);
    process.exit(1);
  }
};
