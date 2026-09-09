// gw-client.mjs — Gateway WS 连接复用 + 断线重连(单例连接池)
// 零第三方依赖。一条 WS 连接服务本进程内所有 node.invoke(nodeId 无关,连接对象是网关)。
// 相比旧的「每次命令新建 WS + connect 握手」,复用连接省掉重复握手,显著降延迟。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

export function readGatewayPassword() {
  return process.env.GW_PASSWORD
    || (() => { try { return readFileSync(join(DIR, "gw-pass"), "utf8").trim(); } catch { return ""; } })()
    || (() => { try { return readFileSync(join(homedir(), ".openclaw-gw-pass"), "utf8").trim(); } catch { return ""; } })()
    || process.env.API_KEY
    || "";
}

export const GW_URL = () => process.env.GW_WS_URL || "ws://127.0.0.1:20000";

// 单例:整个进程共享一条网关连接
let _client = null;

export class GwClient {
  constructor(url, password) {
    this.url = url;
    this.password = password;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();          // id -> { resolve, reject }
    this.connected = false;            // 是否已完成 connect 握手
    this._connectPromise = null;       // 进行中的连接(去重并发 connect)
    this._closed = false;              // 显式关闭标记(不再重连)
  }

  // 确保已连接(已连则秒回;未连则 connect 一次;并发调用共享同一次 connect)
  async ensureConnected() {
    if (this.connected && this.ws && this.ws.readyState === 1) return;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;

      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "res") {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          m.ok ? p.resolve(m.payload) : p.reject(new Error(m.error?.message || m.error?.code || "RPC error"));
        }
        // 其他 event(如超时/心跳)暂不处理
      };

      ws.onerror = () => {}; // 由 onclose 兜底

      ws.onclose = () => {
        // 连接断开:失败所有 pending 请求;清除 connected 标记以便下次重连
        this.connected = false;
        this.ws = null;
        if (!settled) { settled = true; reject(new Error("网关连接失败")); return; }
        const err = new Error("网关连接断开");
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        // 未显式关闭时,下次 ensureConnected 会自动重建
      };

      ws.onopen = async () => {
        try {
          await this._send(ws, "connect", {
            minProtocol: 4, maxProtocol: 4,
            client: { id: "cli", version: "1.0.0", platform: "linux", mode: "cli" },
            role: "operator", scopes: ["operator.admin"],
            auth: { password: this.password }, caps: [], commands: []
          });
          this.connected = true;
          if (!settled) { settled = true; resolve(); }
        } catch (err) {
          if (!settled) { settled = true; reject(err); }
          try { ws.close(); } catch {}
        }
      };
    });
  }

  // 发请求(带重连:连接断则重连后重试一次)
  async request(method, params, { retry = true } = {}) {
    await this.ensureConnected();
    try {
      return await this._send(this.ws, method, params);
    } catch (e) {
      // 连接在请求中途断开:重连一次并重试(幂等性靠上层 idempotencyKey 保证)
      if (retry && !this.connected) {
        await this.ensureConnected();
        return await this._send(this.ws, method, params);
      }
      throw e;
    }
  }

  _send(ws, method, params) {
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++);
      this.pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    this._closed = true;
    if (this.ws) { try { this.ws.close(); } catch {} }
  }
}

// 获取进程级单例连接(懒创建;密码在首次 connect 时读取)
export function getClient() {
  if (!_client) {
    const password = readGatewayPassword();
    if (!password) throw new Error("缺网关密码(设 GW_PASSWORD 或放 gw-pass)");
    _client = new GwClient(GW_URL(), password);
  }
  return _client;
}