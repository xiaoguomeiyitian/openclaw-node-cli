// gw-sysrun.mjs — 经 Gateway 底层 RPC node.invoke(system.run) 在节点执行命令
// 与 node-exec / gateway-term 同目录。零第三方依赖(Node v24 内置 WebSocket)。
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

export function runOnNode({ nodeId, command, cwd = "", timeoutMs = 900000 }) {
  const url = process.env.GW_WS_URL || "ws://127.0.0.1:20000";
  const password = readGatewayPassword();
  if (!password) return Promise.reject(new Error("缺网关密码(设 GW_PASSWORD 或放 gw-pass)"));

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const send = (method, params) => new Promise((r, j) => {
      const id = String(nextId++);
      pending.set(id, { r, j });
      try { ws.send(JSON.stringify({ type: "req", id, method, params })); } catch (e) { pending.delete(id); j(e); }
    });

    const timer = setTimeout(() => { finishError(new Error("执行超时")); }, timeoutMs + 30000);

    let done = false;
    function finishError(e) {
      if (done) return; done = true;
      try { ws.close(); } catch {}
      clearTimeout(timer);
      reject(e);
    }
    function finish(res) {
      if (done) return; done = true;
      try { ws.close(); } catch {}
      clearTimeout(timer);
      resolve(res);
    }

    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "res") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.ok ? p.r(m.payload) : p.j(new Error(m.error?.message || m.error?.code || "RPC error"));
      }
    };
    ws.onclose = () => { if (!done) finishError(new Error("网关连接断开")); };
    ws.onerror = () => {};

    ws.onopen = async () => {
      try {
        await send("connect", {
          minProtocol: 4, maxProtocol: 4,
          client: { id: "cli", version: "1.0.0", platform: "linux", mode: "cli" },
          role: "operator", scopes: ["operator.admin"],
          auth: { password }, caps: [], commands: []
        });
        // system.run 走底层 node.invoke;command 需为 argv 数组,复合命令用 bash -c
        const argv = ["bash", "-lc", command];
        const invokeParams = {
          command: argv,
          ...(cwd ? { cwd } : {}),
          timeoutMs
        };
        const payload = await send("node.invoke", {
          nodeId, command: "system.run", params: invokeParams,
          idempotencyKey: (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : (String(Date.now()) + Math.random().toString(16).slice(2))
        });
        // 结果信封:payload 内含 stdout/stderr/exitCode 或嵌套结构,做宽松解析
        const p = payload?.payload ?? payload ?? {};
        const out = p.stdout ?? p.output ?? p.stdoutText ?? "";
        const err = p.stderr ?? p.error ?? p.stderrText ?? "";
        const code = p.exitCode ?? p.code ?? p.status ?? 0;
        finish({ ok: true, stdout: String(out), stderr: String(err), exitCode: Number(code) });
      } catch (err) {
        finishError(err);
      }
    };
  });
}

// 直接运行时:argv[2]=nodeId argv[3]=command
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , nodeId, ...rest] = process.argv;
  if (!nodeId || rest.length === 0) { console.error("用法: gw-sysrun.mjs <nodeId> <command...>"); process.exit(2); }
  runOnNode({ nodeId, command: rest.join(" ") })
    .then((r) => { if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); process.exit(r.exitCode ?? 0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
