import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  safeRequest,
  validateTarget,
  assertSchema,
  getPath,
  problem,
} from "../server/safe-http.mjs";

function substitute(value, args) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, key) => {
    const found = getPath(args, key);
    if (
      found === undefined ||
      (typeof found !== "string" &&
        typeof found !== "number" &&
        typeof found !== "boolean")
    )
      throw problem("RUNNER_ARGUMENT_MISSING", `注册任务缺少参数 ${key}`);
    return String(found);
  });
}

export async function runScriptTask(
  definition,
  args,
  { signal, timeoutMs = 10000 } = {},
) {
  const worker = fileURLToPath(
    new URL("./runner-script-worker.mjs", import.meta.url),
  );
  const serialized = JSON.stringify({ input: args, steps: definition.steps });
  if (Buffer.byteLength(serialized) > 1048576)
    throw problem("SCRIPT_INPUT_TOO_LARGE", "脚本输入超过1MB");
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--permission", "--max-old-space-size=64", worker, "--worker"],
      { stdio: ["pipe", "pipe", "pipe"], env: {}, signal },
    );
    let output = "",
      error = "",
      settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(problem("SCRIPT_TIMEOUT", "声明式脚本执行超时", 504));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 1048576) {
        child.kill("SIGKILL");
        finish(problem("SCRIPT_OUTPUT_TOO_LARGE", "脚本输出超过1MB", 502));
      }
    });
    child.stderr.on("data", (chunk) => {
      error = `${error}${chunk}`.slice(-8000);
    });
    child.on("error", (err) => finish(err));
    child.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") finish(err);
    });
    child.on("exit", (code) => {
      if (code !== 0)
        return finish(
          problem("SCRIPT_FAILED", error || `声明式脚本退出码 ${code}`, 502),
        );
      try {
        finish(null, {
          result: JSON.parse(output).result,
          runtime: "declarative-node-permission-process",
          exitCode: code,
        });
      } catch {
        finish(
          problem("SCRIPT_INVALID_RESULT", "声明式脚本未返回有效JSON", 502),
        );
      }
    });
    child.stdin.end(serialized);
  });
}

export async function runBrowserTask(
  definition,
  args,
  { signal, mode = "readonly", toolMode = "readonly", timeoutMs = 60000 } = {},
) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw problem(
      "BROWSER_RUNTIME_UNAVAILABLE",
      "未安装 Playwright 浏览器运行时，请在执行器安装后重试",
      503,
    );
  }
  const policy = {
    allowedHosts: definition.allowedHosts || [],
    allowPrivateHosts: definition.allowPrivateHosts || [],
    allowInsecure: definition.allowInsecure === true,
  };
  if (!policy.allowedHosts.length)
    throw problem(
      "BROWSER_HOSTS_REQUIRED",
      "注册浏览器任务必须指定主机允许列表",
      403,
    );
  const viewport =
    definition.viewport === undefined
      ? { width: 1440, height: 1000 }
      : definition.viewport;
  if (
    !viewport ||
    typeof viewport !== "object" ||
    Array.isArray(viewport) ||
    !Number.isInteger(viewport.width) ||
    !Number.isInteger(viewport.height) ||
    viewport.width < 320 ||
    viewport.width > 3840 ||
    viewport.height < 240 ||
    viewport.height > 2160
  )
    throw problem(
      "BROWSER_VIEWPORT_INVALID",
      "注册视口宽度需320至3840、高度需240至2160的整数",
    );
  if (signal?.aborted)
    throw signal.reason || problem("ABORTED", "浏览器任务已取消", 499);
  const channel =
    definition.browserChannel === "bundled" || !definition.browserChannel
      ? undefined
      : definition.browserChannel;
  const browser = await chromium.launch({
    headless: true,
    ...(channel ? { channel } : {}),
    timeout: Math.min(timeoutMs, 30000),
  });
  let context;
  try {
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: viewport.width, height: viewport.height },
    });
  } catch (error) {
    await browser.close();
    throw error;
  }
  const abort = () => {
    void context.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  const networkErrors = [];
  try {
    await context.route("**/*", async (route) => {
      const req = route.request();
      try {
        if (
          !["GET", "HEAD", "OPTIONS"].includes(req.method()) &&
          (mode !== "test" || toolMode !== "test" || !definition.allowMutations)
        )
          throw problem(
            "BROWSER_WRITE_DENIED",
            "浏览器写请求仅允许评测模式与工具环境均为test且注册表明确批准",
            403,
          );
        const response = await safeRequest({
          url: req.url(),
          method: req.method(),
          body: req.postData() ?? undefined,
          headers: { ...req.headers(), "accept-encoding": "identity" },
          ...policy,
          signal,
          timeoutMs: Math.min(timeoutMs, 20000),
          maxBytes: 4194304,
        });
        const headers = Object.fromEntries(
          Object.entries(response.headers)
            .filter(
              ([key, value]) =>
                value !== undefined &&
                !["transfer-encoding", "connection", "content-length"].includes(
                  key,
                ),
            )
            .map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(", ") : String(value),
            ]),
        );
        await route.fulfill({
          status: response.status,
          headers,
          body: response.buffer,
        });
      } catch (error) {
        networkErrors.push({
          url: req.url(),
          code: error.code || "NETWORK_ERROR",
          message: error.message,
        });
        await route.abort("blockedbyclient");
      }
    });
    if (context.routeWebSocket)
      await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(timeoutMs, 30000));
    const results = [];
    if (definition.startUrl) {
      const url = substitute(definition.startUrl, args);
      await validateTarget(url, policy);
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    if (!Array.isArray(definition.steps) || definition.steps.length > 100)
      throw problem(
        "BROWSER_STEPS_INVALID",
        "浏览器任务需要不超过100个注册步骤",
      );
    for (const step of definition.steps) {
      if (signal?.aborted)
        throw signal.reason || problem("ABORTED", "浏览器任务已取消", 499);
      const value = substitute(step.value, args);
      if (step.action === "goto") {
        const url = substitute(step.url, args);
        await validateTarget(url, policy);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        results.push({ action: "goto", url });
      } else if (step.action === "fill") {
        await page.locator(step.selector).fill(String(value ?? ""));
        results.push({ action: "fill", selector: step.selector });
      } else if (step.action === "click") {
        await page.locator(step.selector).click();
        results.push({ action: "click", selector: step.selector });
      } else if (step.action === "text") {
        const text = await page.locator(step.selector).innerText();
        results.push({
          action: "text",
          selector: step.selector,
          text: text.slice(0, 50000),
        });
      } else if (step.action === "assert_text") {
        const deadline = Date.now() + Math.min(timeoutMs, 30000);
        let matched = false;
        do {
          const text = await page.locator(step.selector).innerText();
          if (text.includes(String(value))) {
            matched = true;
            break;
          }
          await delay(50, undefined, { signal });
        } while (Date.now() < deadline);
        if (!matched)
          throw problem(
            "BROWSER_ASSERTION_FAILED",
            `元素 ${step.selector} 不包含预期文字`,
            409,
          );
        results.push({
          action: "assert_text",
          selector: step.selector,
          passed: true,
        });
      } else if (step.action === "screenshot") {
        const png = await page.screenshot({ fullPage: false, type: "png" });
        results.push({
          action: "screenshot",
          mimeType: "image/png",
          base64: png.toString("base64"),
        });
      } else
        throw problem(
          "BROWSER_ACTION_UNREGISTERED",
          `浏览器动作未注册：${step.action}`,
        );
      if (Buffer.byteLength(JSON.stringify(results)) > 1572864)
        throw problem(
          "BROWSER_OUTPUT_TOO_LARGE",
          "浏览器结果超过1.5MB，请减少截图或提取范围",
          413,
        );
    }
    if (
      networkErrors.some((e) =>
        [
          "PRIVATE_NETWORK_DENIED",
          "HOST_NOT_ALLOWED",
          "BROWSER_WRITE_DENIED",
        ].includes(e.code),
      )
    )
      throw problem(
        "BROWSER_NETWORK_POLICY",
        "浏览器任务尝试了未授权网络操作",
        403,
        { networkErrors },
      );
    return {
      url: page.url(),
      title: await page.title(),
      viewport: { width: viewport.width, height: viewport.height },
      results,
      networkErrors,
      runtime: "playwright-isolated-context",
      browserChannel: channel || "bundled",
    };
  } catch (error) {
    if (timedOut)
      throw problem("BROWSER_TIMEOUT", "浏览器任务达到执行时限", 504);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    try {
      await context.close();
    } finally {
      await browser.close();
    }
  }
}

export async function runRegisteredTask(task, registry, options = {}) {
  const name = task.payload?.taskName;
  const definition = registry[name];
  if (!definition || definition.capability !== task.requiredCapability)
    throw problem(
      "RUNNER_TASK_UNREGISTERED",
      "任务名称或能力未在本执行器注册",
      403,
    );
  assertSchema(
    task.payload?.args || {},
    definition.inputSchema || { type: "object" },
  );
  const settings = {
    ...options,
    mode: task.payload.mode || "readonly",
    toolMode: task.payload.toolMode || "readonly",
    timeoutMs: Math.min(
      Number(definition.timeoutMs) ||
        (definition.capability === "browser" ? 60000 : 10000),
      300000,
    ),
  };
  const result =
    definition.capability === "script"
      ? await runScriptTask(definition, task.payload.args || {}, settings)
      : definition.capability === "browser"
        ? await runBrowserTask(definition, task.payload.args || {}, settings)
        : (() => {
            throw problem("RUNNER_CAPABILITY_UNKNOWN", "执行器能力未知");
          })();
  assertSchema(result, definition.outputSchema || {});
  return result;
}

export async function runWorker({
  url,
  token,
  registry,
  once = false,
  signal,
}) {
  if (!url || !token)
    throw problem(
      "RUNNER_AUTH_REQUIRED",
      "需要 EVAL_URL 和 EVAL_RUNNER_TOKEN",
      401,
    );
  const api = new URL(url);
  const policy = {
    allowedHosts: [api.origin],
    allowPrivateHosts: [api.origin],
    allowInsecure:
      api.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname),
  };
  if (
    api.username ||
    api.password ||
    (api.protocol !== "https:" && !policy.allowInsecure)
  )
    throw problem(
      "RUNNER_ENDPOINT_UNSAFE",
      "执行器服务地址必须HTTPS或本地回环HTTP",
      403,
    );
  const send = async (path, body) =>
    (
      await safeRequest({
        url: new URL(path, api).href,
        method: "POST",
        body,
        headers: { authorization: `Bearer ${token}` },
        ...policy,
        signal,
      })
    ).data;
  do {
    if (signal?.aborted) break;
    const claimed = await send("/api/runner/claim", {});
    if (!claimed?.task) {
      if (once) return { claimed: false };
      await delay(2000, undefined, { signal });
      continue;
    }
    const task = claimed.task;
    const taskController = new AbortController();
    const abort = () => taskController.abort(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let heartbeatError;
    const heartbeat = setInterval(() => {
      send("/api/runner/heartbeat", {
        taskId: task.id,
        leaseId: task.leaseId,
      }).catch((error) => {
        heartbeatError = error;
        taskController.abort(error);
      });
    }, 10000);
    let result, error;
    try {
      result = await runRegisteredTask(task, registry, {
        signal: taskController.signal,
      });
    } catch (err) {
      error = { code: err.code || "RUNNER_TASK_FAILED", message: err.message };
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
    }
    if (heartbeatError) throw heartbeatError;
    await send("/api/runner/result", {
      taskId: task.id,
      leaseId: task.leaseId,
      result,
      error,
    });
    if (once) return { claimed: true, taskId: task.id, result, error };
  } while (!signal?.aborted);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort(new Error("执行器已停止")));
  process.on("SIGTERM", () => controller.abort(new Error("执行器已停止")));
  try {
    if (!process.env.EVAL_RUNNER_TASKS)
      throw problem(
        "RUNNER_REGISTRY_REQUIRED",
        "EVAL_RUNNER_TASKS 必须指向管理员批准的任务注册JSON",
      );
    const registry = JSON.parse(
      await readFile(process.env.EVAL_RUNNER_TASKS, "utf8"),
    );
    await runWorker({
      url: process.env.EVAL_URL,
      token: process.env.EVAL_RUNNER_TOKEN,
      registry,
      once: process.argv.includes("--once"),
      signal: controller.signal,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      process.stderr.write(
        `${error.code || "RUNNER_FAILED"}: ${error.message}\n`,
      );
      process.exitCode = 1;
    }
  }
}
