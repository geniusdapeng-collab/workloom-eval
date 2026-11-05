import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = resolve(root, "scripts/cli.mjs");
async function fixture(t, handler = () => ({ ok: true })) {
  const requests = [],
    events = new EventEmitter();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const request = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    requests.push(request);
    events.emit("request", request);
    try {
      const result = await handler(request, res, requests);
      if (!res.writableEnded && result !== undefined) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      }
    } catch {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end("fixture failed");
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, events };
}
function launch(args, { url, input = "", env = {} } = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, ...(url ? { EVAL_URL: url } : {}), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const completion = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI fixture exceeded its 5-second process deadline"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
  return { child, completion };
}
async function run(args, options) {
  return launch(args, options).completion;
}
const output = (result) => {
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
};

test("CLI help and capabilities are JSON-only, complete and available without a running service", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.equal(
    output(help).product,
    "丰臣秀吉数字员工评测与迭代平台（秀吉系统）CLI",
  );
  assert.equal(output(help).usage[0], "workloom-eval --help");
  assert.ok(output(help).usage.some((line) => line.includes("call OP")));
  const capabilities = await run(["capabilities"]);
  assert.equal(capabilities.code, 0);
  const catalog = output(capabilities);
  assert.equal(catalog.schemaVersion, "workloom.agent-operations/v1");
  assert.ok(
    catalog.operations.some(
      (item) =>
        item.name === "job_submit" && item.inputSchema.oneOf.length === 14,
    ),
  );
  assert.ok(catalog.operations.some((item) => item.name === "doctor"));
  assert.ok(catalog.operations.every((item) => !item.request && !item.local));
});

test("CLI call preserves JSON special characters and idempotency while keeping auth only in environment/headers", async (t) => {
  const f = await fixture(t, (request) => ({
    id: "new",
    status: "queued",
    requestBody: request.body,
  }));
  const token = "fixture-cli-token-value";
  const args = {
    type: "create_employee",
    payload: { requirements: '售后员工\n引用"、空格和🙂' },
    budgetTokens: 1000,
    idempotencyKey: "cli-req-1",
  };
  const result = await run(
    ["call", "job_submit", "--json", JSON.stringify(args)],
    { url: f.url, env: { EVAL_API_TOKEN: token } },
  );
  assert.equal(result.code, 0);
  assert.equal(output(result).status, "queued");
  assert.deepEqual(f.requests[0].body, {
    type: args.type,
    payload: args.payload,
    budgetTokens: 1000,
  });
  assert.equal(f.requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(f.requests[0].headers["idempotency-key"], args.idempotencyKey);
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
});

test("CLI reads --input files, explicit stdin and piped stdin as exactly one JSON object", async (t) => {
  const f = await fixture(t, (request) => ({ observed: request.url }));
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, "cli-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "输入 data.json");
  const json = JSON.stringify({ kind: "employees", id: "特殊 /?字符" });
  await writeFile(file, json);
  for (const args of [
    ["call", "resource_get", "--input", file],
    ["call", "resource_get", "--input", "-"],
    ["call", "resource_get"],
  ]) {
    const result = await run(args, { url: f.url, input: json });
    assert.equal(result.code, 0);
    assert.equal(
      output(result).observed,
      `/api/resources/employees/${encodeURIComponent("特殊 /?字符")}`,
    );
  }
});

test("CLI stdin and file errors fail without echoing malformed input or opening a request", async (t) => {
  const f = await fixture(t);
  const malformed = "private user material { invalid JSON";
  const invalid = await run(["call", "status", "--json", malformed], {
    url: f.url,
  });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /INVALID_JSON/);
  assert.ok(!invalid.stderr.includes(malformed));
  const absent = await run(
    ["call", "status", "--input", "work/does-not-exist-cli-fixture.json"],
    { url: f.url },
  );
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /INPUT_READ_FAILED/);
  assert.equal(absent.stdout, "");
  const array = await run(["call", "status", "--json", "[]"], { url: f.url });
  assert.equal(array.code, 1);
  assert.match(array.stderr, /INVALID_ARGUMENTS/);
  assert.equal(f.requests.length, 0);
});

test("CLI bounds JSON file input before dispatch rather than reading an unlimited artifact", async (t) => {
  const f = await fixture(t);
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const directory = await mkdtemp(join(work, "cli-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "large.json");
  await writeFile(file, '"' + "x".repeat(16 * 1024 * 1024) + '"');
  const result = await run(["call", "status", "--input", file], { url: f.url });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^CLI_USAGE:.*16 MiB/);
  assert.equal(result.stdout, "");
  assert.equal(f.requests.length, 0);
});

test("CLI rejects ambiguous/unknown options, credential flags, missing CAS and remote HTTP before network access", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["call", "status", "--token", "never-argv"],
    ["call", "status", "--json", "{}", "--input", "-"],
    ["call", "status", "extra"],
    ["jobs", "wait"],
    ["doctor", "unexpected"],
    ["call", "status", "--timeout-ms", "NaN"],
    ["call", "status", "--url", "http://example.invalid"],
    [
      "call",
      "resource_update",
      "--json",
      '{"kind":"knowledge","id":"kb","data":{"content":"x"}}',
    ],
  ]) {
    const result = await run(args, { url: f.url });
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length > 0);
  }
  assert.equal(f.requests.length, 0);
});

test("CLI reports API permission/revision codes on stderr with nonzero exit and no echoed credential", async (t) => {
  const token = "fixture-cli-error-token";
  const f = await fixture(t, (_request, response) => {
    response.statusCode = 403;
    return {
      error: {
        code: "PERMISSION_DENIED",
        message: `Denied ${token}`,
        details: { token },
      },
    };
  });
  const result = await run(
    ["call", "resource_list", "--json", '{"kind":"employees"}'],
    { url: f.url, env: { EVAL_API_TOKEN: token } },
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^PERMISSION_DENIED:/);
  assert.ok(!result.stderr.includes(token));
});

test("CLI doctor uses all shared read checks, identifies missing login and never executes a model probe", async (t) => {
  const f = await fixture(t, (request) => {
    if (request.url === "/api/session")
      return { user: { id: "fixture", role: "viewer" }, role: "viewer" };
    if (request.url === "/api/status")
      return { ok: true, modelConfigured: false };
    if (request.url === "/api/agent/capabilities")
      return {
        product: "workloom-eval",
        apiVersion: "1",
        jobTypes: ["evaluate"],
      };
    return { ok: true, product: "workloom-eval" };
  });
  const result = await run(["doctor"], { url: f.url });
  assert.equal(result.code, 0);
  const diagnostics = output(result);
  assert.equal(diagnostics.authenticated, true);
  assert.equal(diagnostics.modelConfigured, false);
  assert.equal(diagnostics.modelProbeExecuted, false);
  assert.equal(Object.keys(diagnostics.checks).length, 4);
  assert.ok(
    f.requests.every(
      (request) => request.method === "GET" && !request.url.endsWith("/test"),
    ),
  );
  const missing = await fixture(t, (request, response) => {
    if (request.url === "/api/session") return { user: null };
    if (request.url === "/api/status") {
      response.statusCode = 401;
      return { error: { code: "LOGIN_REQUIRED", message: "login required" } };
    }
    return { ok: true, product: "workloom-eval" };
  });
  const failed = await run(["doctor"], { url: missing.url });
  assert.equal(failed.code, 1);
  const failure = output(failed);
  assert.equal(failure.ok, false);
  assert.equal(failure.authenticated, false);
  assert.equal(failure.checks.status.error.code, "LOGIN_REQUIRED");
  assert.equal(failure.checks.health.ok, true);
});

test("CLI jobs wait distinguishes completed, failed, cancelled and interrupted terminal results with explicit exit codes", async (t) => {
  const f = await fixture(t, (request) => ({
    id: "fixture-job",
    status: request.url.split("/").at(-1),
    result: { runId: "fixture-run" },
  }));
  for (const [status, code] of [
    ["completed", 0],
    ["failed", 2],
    ["cancelled", 2],
    ["interrupted", 2],
  ]) {
    const result = await run(["jobs", "wait", status, "--timeout-ms", "500"], {
      url: f.url,
    });
    assert.equal(result.code, code);
    assert.equal(output(result).terminal, true);
    assert.equal(JSON.parse(result.stdout).job.status, status);
  }
});

test("CLI jobs wait and call job_wait return bounded timeout without claiming completion or resubmitting", async (t) => {
  const f = await fixture(t, () => ({
    id: "waiting",
    status: "running",
    progress: 25,
  }));
  const direct = await run(
    [
      "jobs",
      "wait",
      "waiting",
      "--timeout-ms",
      "120",
      "--poll-interval-ms",
      "100",
    ],
    { url: f.url },
  );
  assert.equal(direct.code, 3);
  assert.equal(output(direct).timeout, true);
  assert.equal(JSON.parse(direct.stdout).terminal, false);
  const generic = await run(
    [
      "call",
      "job_wait",
      "--json",
      '{"id":"waiting","timeoutMs":120,"pollIntervalMs":100}',
    ],
    { url: f.url },
  );
  assert.equal(generic.code, 3);
  assert.equal(output(generic).lastStatus, "running");
  assert.ok(f.requests.every((request) => request.method === "GET"));
});

test("CLI SIGINT cancels an in-flight wait locally and emits no implicit server job cancellation", async (t) => {
  const f = await fixture(t, () => undefined);
  const requested = once(f.events, "request");
  const running = launch(["jobs", "wait", "waiting", "--timeout-ms", "3000"], {
    url: f.url,
  });
  await requested;
  running.child.kill("SIGINT");
  const result = await running.completion;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^CANCELLED:/);
  assert.equal(result.stdout, "");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "GET");
});

test("CLI request timeout makes one attempt and does not retry a billable or mutating operation", async (t) => {
  const f = await fixture(t, () => undefined);
  const result = await run(
    [
      "call",
      "job_submit",
      "--json",
      '{"type":"evaluate","payload":{"versionId":"v","datasetId":"d"},"idempotencyKey":"one-write"}',
      "--timeout-ms",
      "50",
    ],
    { url: f.url },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^REQUEST_TIMEOUT:/);
  assert.equal(result.stdout, "");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "POST");
});

test("CLI uses EVAL_SESSION_TOKEN only as an in-memory cookie and --url overrides EVAL_URL", async (t) => {
  const wrong = await fixture(t);
  const correct = await fixture(t, (request) => ({
    user: { id: "fixture-user" },
    cookie: request.headers.cookie,
  }));
  const result = await run(["call", "session", "--url", correct.url], {
    url: wrong.url,
    env: { EVAL_SESSION_TOKEN: "fixture-cli-session-value" },
  });
  assert.equal(result.code, 0);
  assert.equal(
    correct.requests[0].headers.cookie,
    "eval_session=fixture-cli-session-value",
  );
  assert.equal(wrong.requests.length, 0);
  assert.ok(!result.stdout.includes("fixture-cli-session-value"));
});

test("CLI exports stay one valid JSON document while preserving multiline report content", async (t) => {
  const report = "# 合成报告\n\n状态与限制\n";
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(report);
  });
  const result = await run(
    ["call", "report_export", "--json", '{"id":"report","format":"markdown"}'],
    { url: f.url },
  );
  assert.equal(result.code, 0);
  assert.equal(output(result).content, report);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});
