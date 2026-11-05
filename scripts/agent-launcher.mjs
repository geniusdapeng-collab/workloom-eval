#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, writeFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failure = (code, message) => Object.assign(new Error(message), { code });
export async function ensureService({
  url = process.env.EVAL_URL || "http://127.0.0.1:4317",
  root = ROOT,
  env = process.env,
  timeoutMs = 20000,
  signal,
} = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw failure("INVALID_SERVICE_URL", "EVAL_URL不是有效地址");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/" ||
    !(target.protocol === "https:" || (local && target.protocol === "http:"))
  )
    throw failure(
      "UNSAFE_SERVICE_URL",
      "服务地址须为HTTPS或本机回环HTTP根地址，不能含凭据或查询参数",
    );
  async function health() {
    try {
      const response = await fetch(new URL("/api/health", target), {
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
          : AbortSignal.timeout(3000),
      });
      if (!response.ok)
        throw failure("SERVICE_HEALTH_FAILED", "平台健康检查未通过");
      const reader = response.body.getReader(),
        chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4096) {
            await reader.cancel();
            throw failure(
              "SERVICE_HEALTH_TOO_LARGE",
              "平台健康响应超过4KiB上限",
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw failure(
          "SERVICE_IDENTITY_MISMATCH",
          "地址未返回平台JSON健康信息",
        );
      }
      if (data.product !== "workloom-eval" || data.ok !== true)
        throw failure("SERVICE_IDENTITY_MISMATCH", "端口已被其他服务占用");
      const parts = String(data.version).split(".").map(Number);
      if (
        !/^\d+\.\d+\.\d+$/.test(String(data.version)) ||
        !parts.every(Number.isSafeInteger) ||
        parts[0] < 1 ||
        (parts[0] === 1 && parts[1] < 1)
      )
        throw failure(
          "SERVICE_UPGRADE_REQUIRED",
          "已运行的WorkLoom Eval需更新至支持Agent接口的版本后重启；不会停止未知进程",
        );
      return data;
    } catch (error) {
      if (error.cause?.code === "ECONNREFUSED") return null;
      throw error;
    }
  }
  const existing = await health();
  if (existing) return { url: target.origin, reused: true, health: existing };
  if (!local || target.protocol !== "http:")
    throw failure(
      "SERVICE_UNAVAILABLE",
      "远端平台不可达；请检查已部署服务，连接器不会启动远端服务",
    );
  const port = Number(target.port || 80);
  if (port < 1024)
    throw failure("UNSAFE_SERVICE_PORT", "自动启动需要1024以上的本机端口");
  const runtime = resolve(root, ".runtime"),
    lock = resolve(runtime, `agent-service-${port}.lock`),
    state = resolve(runtime, `agent-service-${port}.json`);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let locked = false;
  while (!locked && Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      await mkdir(lock, { mode: 0o700 });
      locked = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const live = await health();
      if (live) return { url: target.origin, reused: true, health: live };
      const info = await stat(lock).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (info && Date.now() - info.mtimeMs > 60000) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      await delay(150, undefined, { signal });
    }
  }
  if (!locked)
    throw failure("SERVICE_START_BUSY", "另一个连接器正在启动服务，请稍后重试");
  let child,
    exited = false,
    log;
  try {
    const live = await health();
    if (live) return { url: target.origin, reused: true, health: live };
    log = await open(resolve(runtime, "agent-service.log"), "a", 0o600);
    await log.chmod(0o600);
    const childEnv = {
      ...env,
      HOST: target.hostname.replace(/^\[|\]$/g, ""),
      PORT: String(port),
      EVAL_AUTH_MODE: env.EVAL_AUTH_MODE || "local",
      EVAL_DB_PATH: env.EVAL_DB_PATH || resolve(runtime, "eval.sqlite"),
    };
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "EVAL_API_TOKEN",
      "EVAL_SESSION_TOKEN",
      "EVAL_SESSION_COOKIE",
    ])
      delete childEnv[key];
    child = spawn(process.execPath, [resolve(ROOT, "server/index.mjs")], {
      cwd: ROOT,
      env: childEnv,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    let spawnError;
    child.once("error", (e) => {
      spawnError = e;
      exited = true;
    });
    child.once("exit", () => {
      exited = true;
    });
    child.unref();
    await writeFile(
      state,
      JSON.stringify({
        pid: child.pid,
        url: target.origin,
        startedAt: new Date().toISOString(),
      }) + "\n",
      { mode: 0o600 },
    );
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      const data = await health();
      if (data)
        return {
          url: target.origin,
          reused: false,
          pid: child.pid,
          health: data,
        };
      if (exited)
        throw failure(
          "SERVICE_START_FAILED",
          "服务启动失败，查看本机.runtime/agent-service.log",
        );
      await delay(200, undefined, { signal });
    }
    throw failure(
      "SERVICE_START_TIMEOUT",
      "服务未在时限内启动，查看本机.runtime/agent-service.log",
    );
  } catch (error) {
    if (child?.pid && !exited) child.kill("SIGTERM");
    throw error;
  } finally {
    await log?.close();
    await rm(lock, { recursive: true, force: true });
  }
}
export async function launchAgent() {
  await ensureService();
  const { startMcpServer } = await import("./mcp-server.mjs");
  return startMcpServer();
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  launchAgent().catch((error) => {
    process.stderr.write(
      `${error.code || "AGENT_START_FAILED"}: ${error.code ? error.message : "连接器启动失败，请检查运行环境"}\n`,
    );
    process.exitCode = 1;
  });
}
