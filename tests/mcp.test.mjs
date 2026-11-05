import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { OPERATIONS } from "../client/operations.mjs";
import { createApplication } from "../server/index.mjs";
import { createStore } from "../server/store.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = fileURLToPath(
  new URL("../scripts/mcp-server.mjs", import.meta.url),
);
const PREFIX = "workloom_eval_";
const TOKEN = "fixture-machine-bearer-credential";
const json = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

async function connected(t, handler = () => false, environment = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      if (await handler(request, response, body)) return;
      if (request.url === "/api/health")
        return json(response, {
          ok: true,
          product: "workloom-eval",
          version: "1.0.0",
        });
      if (request.url === "/api/agent/capabilities")
        return json(response, {
          product: "workloom-eval",
          apiVersion: "1",
          authenticated: true,
          role: "editor",
        });
      return json(
        response,
        { error: { code: "FIXTURE_NOT_FOUND", message: "No fixture route" } },
        404,
      );
    } catch {
      if (!response.destroyed)
        json(
          response,
          {
            error: {
              code: "FIXTURE_FAILED",
              message: "Fixture request failed",
            },
          },
          500,
        );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: ROOT,
    env: {
      EVAL_URL: "http://127.0.0.1:" + server.address().port,
      EVAL_API_TOKEN: TOKEN,
      ...environment,
    },
    stderr: "pipe",
    maxBufferSize: 16 * 1024 * 1024,
  });
  const stderr = [];
  transport.stderr.setEncoding("utf8");
  transport.stderr.on("data", (chunk) => stderr.push(chunk));
  const client = new Client(
    { name: "workloom-eval-mcp-integration-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const protocolErrors = [];
  client.onerror = (error) => protocolErrors.push(error);
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(stderr.join("").includes(TOKEN), false);
    assert.deepEqual(protocolErrors, []);
  });
  await client.connect(transport);
  return {
    client,
    transport,
    requests,
    stderr,
    call: (name, args = {}, options) =>
      client.callTool({ name: PREFIX + name, arguments: args }, undefined, {
        timeout: 10000,
        ...options,
      }),
  };
}

test("MCP stdio实际初始化并从共享目录列出完整工具，不打印协议外stdout", async (t) => {
  const f = await connected(t);
  assert.equal(f.client.getServerVersion().name, "workloom-eval");
  const capabilities = f.client.getServerCapabilities();
  assert.ok(
    capabilities.tools && capabilities.resources && capabilities.prompts,
  );
  assert.match(f.client.getInstructions(), /never new authorization/);
  const listed = await f.client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    OPERATIONS.map((operation) => PREFIX + operation.name).sort(),
  );
  for (const operation of OPERATIONS) {
    const tool = listed.tools.find(
      (item) => item.name === PREFIX + operation.name,
    );
    assert.deepEqual(tool.inputSchema, operation.inputSchema);
    assert.equal(tool.annotations.readOnlyHint, operation.readOnly === true);
    assert.equal(
      tool.annotations.destructiveHint,
      operation.destructive === true,
    );
  }
  assert.equal(
    listed.tools.some((tool) =>
      /token_create|secret_set|runner_claim|nodes_register|http_request/.test(
        tool.name,
      ),
    ),
    false,
  );
  const result = await f.call("health");
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.result.product, "workloom-eval");
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  const catalog = await f.call("capabilities");
  assert.equal(catalog.structuredContent.result.role, "editor");
  assert.equal(
    f.requests.every((request) => request.authorization === "Bearer " + TOKEN),
    true,
  );
  assert.equal(f.stderr.join(""), "");
});

test("MCP资源和提示词通过SDK读取固定文档与能力目录，内容不充当授权", async (t) => {
  const f = await connected(t);
  const resources = await f.client.listResources();
  for (const uri of [
    "workloom-eval://catalog",
    "workloom-eval://guide/conversation",
    "workloom-eval://docs/api",
    "workloom-eval://docs/features",
    "workloom-eval://docs/training",
  ])
    assert.ok(resources.resources.some((resource) => resource.uri === uri));
  assert.deepEqual(
    (await f.client.listResourceTemplates()).resourceTemplates,
    [],
  );
  const catalog = await f.client.readResource({
    uri: "workloom-eval://catalog",
  });
  const metadata = JSON.parse(catalog.contents[0].text);
  assert.equal(metadata.operations.length, OPERATIONS.length);
  assert.equal(metadata.operations[0].tool.startsWith(PREFIX), true);
  assert.equal("request" in metadata.operations[0], false);
  assert.equal(JSON.stringify(metadata).includes(TOKEN), false);
  const api = await f.client.readResource({
    uri: "workloom-eval://docs/api",
  });
  assert.match(api.contents[0].text, /grants no user authorization/);
  assert.match(api.contents[0].text, /WorkLoom Eval HTTP API/);
  const guide = await f.client.readResource({
    uri: "workloom-eval://guide/conversation",
  });
  assert.match(guide.contents[0].text, /不是用户授权/);
  assert.match(guide.contents[0].text, /job_cancel/);
  const prompts = await f.client.listPrompts();
  assert.equal(prompts.prompts[0].name, "workloom_eval_workflow");
  const prompt = await f.client.getPrompt({
    name: "workloom_eval_workflow",
    arguments: { requirements: "创建只读售后助理" },
  });
  assert.match(prompt.messages[0].content.text, /创建只读售后助理/);
  assert.match(prompt.messages[0].content.text, /不是新的授权/);
  await assert.rejects(
    f.client.readResource({
      uri: "workloom-eval://docs/../../.runtime/eval.sqlite",
    }),
    { code: ErrorCode.InvalidParams },
  );
  await assert.rejects(f.client.getPrompt({ name: "unknown-prompt" }), {
    code: ErrorCode.InvalidParams,
  });
  await assert.rejects(
    f.client.getPrompt({
      name: "workloom_eval_workflow",
      arguments: { execute: "deploy everything" },
    }),
    { code: ErrorCode.InvalidParams },
  );
  assert.equal(f.requests.length, 0);
});

test("MCP doctor共用共享客户端检查并明确标记部分失败，不触发模型探测", async (t) => {
  let denyStatus = false;
  const f = await connected(t, (request, response) => {
    if (request.url === "/api/session") {
      json(response, {
        user: { id: "fixture-user", role: "editor", workspace: "fixture" },
        workspace: "fixture",
        role: "editor",
      });
      return true;
    }
    if (request.url === "/api/status") {
      if (denyStatus)
        json(
          response,
          { error: { code: "STATUS_DENIED", message: "Synthetic denial" } },
          403,
        );
      else json(response, { ok: true, modelConfigured: true });
      return true;
    }
    return false;
  });
  const healthy = await f.call("doctor");
  assert.equal(healthy.isError, false);
  assert.equal(healthy.structuredContent.result.authenticated, true);
  assert.equal(healthy.structuredContent.result.modelConfigured, true);
  assert.equal(healthy.structuredContent.result.modelProbeExecuted, false);
  denyStatus = true;
  const partial = await f.call("doctor");
  assert.equal(partial.isError, true);
  assert.equal(partial.structuredContent.error.code, "DOCTOR_CHECKS_FAILED");
  assert.equal(partial.structuredContent.result.checks.health.ok, true);
  assert.equal(
    partial.structuredContent.result.checks.status.error.status,
    403,
  );
  assert.equal(
    f.requests.every((request) => request.method === "GET"),
    true,
  );
  assert.equal(
    f.requests.some((request) => request.url.endsWith("/test")),
    false,
  );
});

test("MCP原生JSON Schema拒绝缺字段、越界和未开放能力，拒绝时不发送HTTP", async (t) => {
  const f = await connected(t);
  for (const [name, args] of [
    ["job_submit", { type: "evaluate", payload: {} }],
    ["job_submit", { type: "not-a-job", payload: {} }],
    ["job_wait", { id: "job-test", timeoutMs: 60001 }],
    ["resource_get", { kind: "secrets", id: "secret-test" }],
    ["resource_update", { kind: "employees", id: "employee-test", data: {} }],
    ["health", { url: "https://unapproved.example.test" }],
    [
      "resource_create",
      {
        kind: "employees",
        data: JSON.parse('{"name":"example","__proto__":{"polluted":true}}'),
      },
    ],
  ]) {
    const result = await f.call(name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error.code, "INVALID_ARGUMENTS");
  }
  await assert.rejects(
    f.client.callTool({
      name: PREFIX + "http_request",
      arguments: { method: "GET", url: "https://unapproved.example.test" },
    }),
    { code: ErrorCode.InvalidParams },
  );
  assert.equal(f.requests.length, 0);
  assert.equal({}.polluted, undefined);
});

test("MCP长任务提交返回跟踪动作，有界等待明确区分完成、超时与失败", async (t) => {
  let polls = 0;
  const f = await connected(t, (request, response, body) => {
    if (request.url === "/api/jobs" && request.method === "POST") {
      assert.equal(body.type, "create_employee");
      json(
        response,
        { id: "job-created", type: body.type, status: "queued", progress: 0 },
        202,
      );
      return true;
    }
    if (request.url === "/api/jobs/job-created") {
      polls++;
      json(
        response,
        polls >= 3
          ? {
              id: "job-created",
              status: "completed",
              result: {
                employeeId: "employee-created",
                versionId: "version-created",
                datasetId: "dataset-created",
                reportId: "report-created",
                gaps: ["合成依赖缺口"],
              },
            }
          : {
              id: "job-created",
              status: polls === 1 ? "queued" : "running",
              progress: 25,
            },
      );
      return true;
    }
    if (request.url === "/api/jobs/job-waiting") {
      json(response, { id: "job-waiting", status: "running", progress: 25 });
      return true;
    }
    if (request.url === "/api/jobs/job-failed") {
      json(response, {
        id: "job-failed",
        status: "failed",
        error: { code: "MODEL_NOT_CONFIGURED", message: "合成模型未配置" },
      });
      return true;
    }
    if (request.url === "/api/reports/report-created/export?format=markdown") {
      response.writeHead(200, { "content-type": "text/markdown" });
      response.end("# 合成报告\n结果与限制均保留。\n");
      return true;
    }
    return false;
  });
  const submitted = await f.call("job_submit", {
    type: "create_employee",
    payload: { requirements: "创建一个只读售后政策说明助理。" },
    budgetTokens: 100000,
    idempotencyKey: "mcp-submit-example",
  });
  assert.equal(submitted.isError, false);
  assert.equal(submitted.structuredContent.jobId, "job-created");
  assert.equal(submitted.structuredContent.completed, false);
  assert.equal(
    submitted.structuredContent.nextActions[0].tool,
    PREFIX + "job_wait",
  );
  const waited = await f.call("job_wait", {
    id: "job-created",
    timeoutMs: 1500,
    pollIntervalMs: 100,
  });
  assert.equal(waited.structuredContent.terminal, true);
  assert.equal(waited.structuredContent.completed, true);
  assert.equal(waited.structuredContent.timedOut, false);
  assert.ok(
    waited.structuredContent.nextActions.some(
      (action) => action.tool === PREFIX + "report_export",
    ),
  );
  const report = await f.call("report_export", {
    id: "report-created",
    format: "markdown",
  });
  assert.match(report.structuredContent.result.content, /合成报告/);
  const pending = await f.call("job_wait", {
    id: "job-waiting",
    timeoutMs: 150,
    pollIntervalMs: 100,
  });
  assert.equal(pending.isError, false);
  assert.equal(pending.structuredContent.terminal, false);
  assert.equal(pending.structuredContent.completed, false);
  assert.equal(pending.structuredContent.timedOut, true);
  assert.equal(pending.structuredContent.jobStatus, "running");
  const failed = await f.call("job_wait", {
    id: "job-failed",
    timeoutMs: 150,
    pollIntervalMs: 100,
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.terminal, true);
  assert.equal(failed.structuredContent.completed, false);
  assert.equal(failed.structuredContent.error.code, "MODEL_NOT_CONFIGURED");
});

test("MCP把HTTP权限与业务错误作为isError返回且不回显连接凭据或嵌套秘密", async (t) => {
  const f = await connected(t, (request, response) => {
    if (request.url === "/api/bootstrap") {
      json(
        response,
        {
          error: {
            code: "ROLE_FORBIDDEN",
            message: "Denied credential " + TOKEN,
            details: {
              token: "opaque-private-node-credential",
              nested: { password: "opaque-private-password" },
            },
          },
        },
        403,
      );
      return true;
    }
    if (request.url === "/api/status") {
      json(response, {
        configured: true,
        token: "opaque-private-node-credential",
        nested: {
          authorization: "opaque-private-auth",
          message: TOKEN,
          tokens: 1234,
        },
      });
      return true;
    }
    return false;
  });
  const denied = await f.call("bootstrap");
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, "ROLE_FORBIDDEN");
  assert.equal(denied.structuredContent.error.status, 403);
  assert.equal(JSON.stringify(denied).includes(TOKEN), false);
  assert.equal(
    JSON.stringify(denied).includes("opaque-private-password"),
    false,
  );
  const result = await f.call("status");
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.result.nested.tokens, 1234);
  for (const secret of [
    TOKEN,
    "opaque-private-node-credential",
    "opaque-private-auth",
  ])
    assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.stderr.join(""), "");
});

test("MCP显式取消与恢复保持各自语义，错误任务标识不被当成成功", async (t) => {
  const f = await connected(t, (request, response) => {
    if (request.url === "/api/jobs/job-cancel/cancel") {
      json(response, {
        id: "job-cancel",
        status: "cancelled",
        cancelRequested: true,
      });
      return true;
    }
    if (request.url === "/api/jobs/job-interrupted/resume") {
      json(
        response,
        {
          id: "job-resumed",
          status: "queued",
          payload: { resumeFromJobId: "job-interrupted" },
        },
        202,
      );
      return true;
    }
    if (request.url === "/api/jobs/job-interrupted") {
      json(response, { id: "job-interrupted", status: "interrupted" });
      return true;
    }
    if (request.url === "/api/jobs/job-mismatched") {
      json(response, { id: "different-job", status: "completed" });
      return true;
    }
    if (request.url === "/api/jobs/job-unknown-status") {
      json(response, { id: "job-unknown-status", status: "provider-happy" });
      return true;
    }
    return false;
  });
  const cancelled = await f.call("job_cancel", { id: "job-cancel" });
  assert.equal(cancelled.isError, false);
  assert.equal(cancelled.structuredContent.jobStatus, "cancelled");
  assert.equal(cancelled.structuredContent.completed, false);
  assert.equal(cancelled.structuredContent.terminal, true);
  const interrupted = await f.call("job_get", { id: "job-interrupted" });
  assert.equal(interrupted.isError, true);
  assert.equal(interrupted.structuredContent.completed, false);
  assert.equal(
    interrupted.structuredContent.nextActions[0].tool,
    PREFIX + "job_checkpoints",
  );
  const resumed = await f.call("job_resume", { id: "job-interrupted" });
  assert.equal(resumed.isError, false);
  assert.equal(resumed.structuredContent.jobId, "job-resumed");
  assert.equal(resumed.structuredContent.completed, false);
  for (const id of ["job-mismatched", "job-unknown-status"]) {
    const result = await f.call("job_get", { id });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "INVALID_JOB_RESPONSE");
    assert.equal(result.structuredContent.completed, false);
  }
});

test("MCP响应超过序列化边界时明确报错，不发截断协议或伪造部分成功", async (t) => {
  const f = await connected(t, (request, response) => {
    if (request.url === "/api/status") {
      json(response, { largeValue: "x".repeat(4.2 * 1024 * 1024) });
      return true;
    }
    return false;
  });
  const result = await f.call("status");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "MCP_RESULT_TOO_LARGE");
  assert.equal(result.structuredContent.error.status, 413);
  assert.equal((await f.call("health")).isError, false);
});

test("MCP启动拒绝非HTTPS远端地址且诊断stderr不回显凭据", async (t) => {
  await assert.rejects(
    connected(t, () => false, { EVAL_URL: "http://remote.example.test" }),
    /Connection closed|connection closed/i,
  );
});

test("MCP取消通知透传AbortSignal中止HTTP等待，不擅自取消后台作业且服务继续响应", async (t) => {
  let started, disconnected;
  const requestStarted = new Promise((resolve) => (started = resolve));
  const requestDisconnected = new Promise(
    (resolve) => (disconnected = resolve),
  );
  let polls = 0;
  const f = await connected(t, (request, response) => {
    if (request.url === "/api/jobs/job-slow") {
      polls++;
      response.once("close", () => {
        if (!response.writableEnded) disconnected();
      });
      started();
      return true;
    }
    return false;
  });
  const controller = new AbortController();
  const waiting = f.call(
    "job_wait",
    { id: "job-slow", timeoutMs: 5000, pollIntervalMs: 100 },
    { signal: controller.signal },
  );
  await requestStarted;
  controller.abort(new Error("Synthetic MCP cancellation"));
  await assert.rejects(waiting, /cancel|abort/i);
  await Promise.race([
    requestDisconnected,
    delay(1500).then(() => assert.fail("HTTP request was not aborted")),
  ]);
  await delay(100);
  assert.equal(polls, 1);
  assert.equal(
    f.requests.some((request) => request.url.endsWith("/cancel")),
    false,
  );
  assert.equal((await f.call("health")).isError, false);
});

test("MCP客户端关闭stdio会结束已启动的子进程与连接生命周期", async (t) => {
  const f = await connected(t);
  assert.ok(Number.isInteger(f.transport.pid));
  await f.client.listTools();
  await f.client.close();
  assert.equal(f.transport.pid, null);
  assert.equal(f.stderr.join(""), "");
});

test("MCP实际连接平台API与SQLite，使用机器角色维护资源、提交/取消任务并即时拒绝撤销凭据", async (t) => {
  const store = createStore();
  const platform = createApplication({
    store,
    disableWorker: true,
    env: { HOST: "127.0.0.1", EVAL_AUTH_MODE: "local" },
  });
  const issuedResponse = await platform.app.request(
    "http://localhost/api/agent/tokens",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "MCP platform integration",
        role: "editor",
      }),
    },
  );
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  const f = await connected(
    t,
    async (request, response, body) => {
      const forwarded = await platform.app.request(
        "http://" + request.headers.host + request.url,
        {
          method: request.method,
          headers: request.headers,
          ...(body === null ? {} : { body: JSON.stringify(body) }),
        },
      );
      response.writeHead(
        forwarded.status,
        Object.fromEntries(forwarded.headers.entries()),
      );
      response.end(Buffer.from(await forwarded.arrayBuffer()));
      return true;
    },
    { EVAL_API_TOKEN: issued.token },
  );
  t.after(() => {
    platform.close();
    store.close();
  });
  const doctor = await f.call("doctor");
  assert.equal(doctor.isError, false);
  assert.equal(doctor.structuredContent.result.authenticated, true);
  assert.equal(doctor.structuredContent.result.modelConfigured, false);
  const created = await f.call("resource_create", {
    kind: "employees",
    data: { name: "MCP隔离员工", role: "只读说明" },
  });
  assert.equal(created.isError, false);
  assert.equal(
    store.get("employees", created.structuredContent.result.id).name,
    "MCP隔离员工",
  );
  const prohibited = await f.call("resource_create", {
    kind: "models",
    data: {
      name: "应拒绝的管理员操作",
      model: "fixture-model",
      baseUrl: "https://unused.example.test",
      secretRef: "fixture-reference",
    },
  });
  assert.equal(prohibited.isError, true);
  assert.equal(prohibited.structuredContent.error.status, 403);
  const submitted = await f.call("job_submit", {
    type: "create_employee",
    payload: { requirements: "本测试仅提交并取消，不触发任何模型。" },
    budgetTokens: 100000,
    idempotencyKey: "isolated-mcp-api-submission",
  });
  const jobId = submitted.structuredContent.jobId;
  assert.equal(store.get("jobs", jobId).status, "queued");
  const waiting = await f.call("job_wait", {
    id: jobId,
    timeoutMs: 100,
    pollIntervalMs: 100,
  });
  assert.equal(waiting.structuredContent.terminal, false);
  assert.equal(waiting.structuredContent.timedOut, true);
  const cancelled = await f.call("job_cancel", { id: jobId });
  assert.equal(cancelled.isError, false);
  assert.equal(store.get("jobs", jobId).status, "cancelled");
  assert.equal(store.get("jobs", jobId).usedTokens, 0);
  const revoked = await platform.app.request(
    "http://localhost/api/agent/tokens/" + issued.credential.id,
    { method: "DELETE" },
  );
  assert.equal(revoked.status, 200);
  const denied = await f.call("status");
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.status, 401);
  assert.equal(f.stderr.join("").includes(issued.token), false);
});
