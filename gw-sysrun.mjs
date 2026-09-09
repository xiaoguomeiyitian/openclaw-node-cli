// gw-sysrun.mjs — 经 Gateway 底层 RPC node.invoke(system.run) 在节点执行命令
// 与 node-exec / gateway-term 同目录。零第三方依赖(Node v24 内置 WebSocket)。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getClient } from "./gw-client.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));

export function readGatewayPassword() {
  return process.env.GW_PASSWORD
    || (() => { try { return readFileSync(join(DIR, "gw-pass"), "utf8").trim(); } catch { return ""; } })()
    || (() => { try { return readFileSync(join(homedir(), ".openclaw-gw-pass"), "utf8").trim(); } catch { return ""; } })()
    || process.env.API_KEY
    || "";
}

export async function runOnNode({ nodeId, command, cwd = "", timeoutMs = 900000, platform = "linux" }) {
  // 复用进程级单例连接(第一次调用时自动 connect,后续 node.invoke 复用同一 WS)
  const client = getClient();

  // system.run 走底层 node.invoke;command 需为 argv 数组,复合命令用 shell 包装:
  // linux/mac: bash -lc(登录 shell,环境变量齐全)
  // windows: powershell -NoProfile -NonInteractive -Command
  const argv = (platform || "").toLowerCase() === "windows"
    ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
    : ["bash", "-lc", command];
  const invokeParams = {
    command: argv,
    ...(cwd ? { cwd } : {}),
    timeoutMs
  };

  const payload = await client.request("node.invoke", {
    nodeId, command: "system.run", params: invokeParams,
    idempotencyKey: (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : (String(Date.now()) + Math.random().toString(16).slice(2))
  });

  // 结果信封:payload 内含 stdout/stderr/exitCode 或嵌套结构,做宽松解析
  const p = payload?.payload ?? payload ?? {};
  const out = p.stdout ?? p.output ?? p.stdoutText ?? "";
  const err = p.stderr ?? p.error ?? p.stderrText ?? "";
  const code = p.exitCode ?? p.code ?? p.status ?? 0;
  return { ok: true, stdout: String(out), stderr: String(err), exitCode: Number(code) };
}

// 直接运行时:argv[2]=nodeId argv[3]=command [argv[4]=platform]
// 注意用 pathToFileURL 比较:直接写 file://+path 会在相对路径调用(node ./gw-sysrun.mjs)时
// 不相等(缺绝对路径解析),导致直连模式静默失效。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , nodeId, maybePlatform, ...rest] = process.argv;
  // 兼容旧形态:node gw-sysrun.mjs <nodeId> <command...>(platform 缺省 linux)
  let platform = "linux";
  if (rest.length > 0 && (maybePlatform === "linux" || maybePlatform === "windows")) platform = maybePlatform;
  else rest.unshift(maybePlatform);
  if (!nodeId || rest.length === 0) { console.error("用法: gw-sysrun.mjs <nodeId> <command...> [platform]"); process.exit(2); }
  runOnNode({ nodeId, command: rest.join(" "), platform })
    .then((r) => { if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); process.exit(r.exitCode ?? 0); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
