import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createEvalClient, EvalClientError } from "../client/client.mjs";
import {
  OPERATIONS,
  JOB_TYPES,
  OPERATION_MAP,
  operationMetadata,
} from "../client/operations.mjs";
import { createApplication } from "../server/index.mjs";
import { createStore } from "../server/store.mjs";

async function fixture(t, handler = () => ({ ok: true })) {
  const requests = [];
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
    try {
      const value = await handler(request, res, requests);
      if (!res.writableEnded && value !== undefined) {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(value));
      }
    } catch {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end("fixture handler failure");
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    server,
    requests,
    client: createEvalClient({ url, token: "" }),
  };
}
async function actualApplication(t, { password = false } = {}) {
  const store = createStore();
  const instance = createApplication({
    store,
    disableWorker: true,
    env: password
      ? {
          EVAL_AUTH_MODE: "password",
          EVAL_ADMIN_PASSWORD: "fixture-only-admin-pass",
        }
      : { EVAL_AUTH_MODE: "local" },
  });
  const server = serve({
    fetch: instance.app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  if (!server.listening) await once(server, "listening");
  t.after(async () => {
    instance.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    store.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { store, instance, url, client: createEvalClient({ url, token: "" }) };
}
const jobInputs = {
  create_employee: { requirements: "创建一名售后员工" },
  evaluate: { versionId: "v", datasetId: "d" },
  optimize: { versionId: "v", datasetId: "d" },
  team_evaluate: { teamId: "team", input: "核查任务" },
  memory_evaluate: { versionId: "v", inputs: ["记住代号"] },
  long_horizon: {
    versionId: "v",
    inputs: [{ input: "检索记忆", at: "2026-11-05T00:00:00Z" }],
  },
  shadow_evaluate: { versionId: "v", recordedInputs: ["已审核的合成输入"] },
  knowledge_regression: { knowledgeId: "kb" },
  skill_repair: { versionId: "v", skillId: "skill", datasetId: "d" },
  benchmark_portfolio: { employeeId: "employee", datasetId: "d" },
  browser_evaluate: {
    toolId: "registered-browser",
    args: { url: "http://127.0.0.1" },
  },
  fine_tune: {
    employeeId: "employee",
    datasetId: "train",
    providerModelId: "training-provider",
  },
  poll_training: { trainingId: "training-record" },
  reconcile_deployment: { deploymentId: "deployment-record" },
};

test("catalogue provides immutable complete schemas, all 14 job types and no credential or arbitrary-request operations", () => {
  assert.equal(
    new Set(OPERATIONS.map((item) => item.name)).size,
    OPERATIONS.length,
  );
  assert.equal(JOB_TYPES.length, 14);
  assert.deepEqual([...JOB_TYPES].sort(), Object.keys(jobInputs).sort());
  for (const item of OPERATIONS) {
    assert.match(item.name, /^[a-z][a-z0-9_]+$/);
    assert.equal(item.inputSchema.type, "object");
    assert.equal(item.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(item.inputSchema.required));
    for (const key of ["readOnly", "destructive", "admin"])
      assert.equal(typeof item[key], "boolean");
    assert.ok(item.description.length > 30);
  }
  assert.throws(() => {
    OPERATION_MAP.job_submit.inputSchema.required.push("secret");
  }, TypeError);
  assert.ok(operationMetadata().every((item) => !item.request && !item.local));
  assert.ok(
    !OPERATIONS.some((item) =>
      /^(auth|user|secret|token|node_|runner_|request)/.test(item.name),
    ),
  );
});

test("service URLs reject remote HTTP, credentials, protocol tricks, paths, queries and fragments before dispatch", () => {
  for (const url of [
    "http://example.test",
    "ftp://127.0.0.1",
    "https://user:password@example.test",
    "http://localhost/path",
    "http://127.0.0.1/?key=value",
    "https://example.test/#token",
    "not a URL",
  ])
    assert.throws(() => createEvalClient({ url, token: "" }), EvalClientError);
  for (const url of [
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "http://[::1]:4317",
    "https://example.test",
  ])
    assert.doesNotThrow(() => createEvalClient({ url, token: "" }));
  for (const token of [
    "unsafe\nheader",
    "space is not a bearer credential",
    "nul\u0000value",
  ])
    assert.throws(() => createEvalClient({ token }), {
      code: "INVALID_ARGUMENTS",
    });
  assert.throws(
    () => createEvalClient({ sessionCookie: "eval_session=one; other=two" }),
    { code: "INVALID_ARGUMENTS" },
  );
});

test("HTTP path/query components preserve Unicode, slash, quotes and special characters without path injection", async (t) => {
  const f = await fixture(t, (request) => ({ observed: request.url }));
  const id = '客户 /?%#" &..';
  const result = await f.client.call("resource_get", { kind: "employees", id });
  assert.equal(
    result.observed,
    `/api/resources/employees/${encodeURIComponent(id)}`,
  );
  await f.client.call("events_list", { subjectId: id });
  assert.equal(
    f.requests[1].url,
    `/api/events?subjectId=${encodeURIComponent(id)}`,
  );
  for (const bad of [".", ".."])
    await assert.rejects(f.client.call("job_get", { id: bad }), {
      code: "INVALID_ARGUMENTS",
    });
  await assert.rejects(
    f.client.call("request", { url: "https://elsewhere.test" }),
    { code: "UNKNOWN_OPERATION" },
  );
  assert.equal(f.requests.length, 2);
});

test("client transmits only the selected in-memory auth header and redacts echoed credentials and sensitive response keys", async (t) => {
  const token = "fixture-access-value-only";
  const cookie = "eval_session=fixture-session-value-only";
  const f = await fixture(t, (request) => ({
    authorization: request.headers.authorization,
    token: "fixture-node-value",
    secretRef: "a-reference-is-not-a-key",
    message: `${token} ${cookie}`,
    nested: { password: "not-for-output", value: "safe" },
  }));
  const client = createEvalClient({ url: f.url, token, sessionCookie: cookie });
  const result = await client.call("status");
  assert.equal(f.requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(f.requests[0].headers.cookie, undefined);
  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result.nested.password, "[REDACTED]");
  assert.equal(result.secretRef, "a-reference-is-not-a-key");
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes("fixture-session-value-only"));
  const sessionClient = createEvalClient({
    url: f.url,
    token: "",
    sessionCookie: cookie,
  });
  await sessionClient.call("session");
  assert.equal(f.requests[1].headers.cookie, cookie);
  assert.equal(f.requests[1].headers.authorization, undefined);
});

test("CAS is mandatory, variant-specific fields are validated and caller headers/path overrides never reach HTTP", async (t) => {
  const f = await fixture(t, (request) => request.body);
  await assert.rejects(
    f.client.call("resource_update", {
      kind: "knowledge",
      id: "kb",
      data: { content: "x" },
    }),
    { code: "INVALID_ARGUMENTS" },
  );
  await assert.rejects(
    f.client.call("resource_update", {
      kind: "knowledge",
      id: "kb",
      expectedRevision: 1,
      data: { expectedRevision: 99 },
    }),
    { code: "INVALID_ARGUMENTS" },
  );
  await assert.rejects(
    f.client.call("resource_create", {
      kind: "models",
      data: { name: "missing configuration" },
    }),
    { code: "INVALID_ARGUMENTS" },
  );
  await assert.rejects(f.client.call("status", { path: "/api/secrets" }), {
    code: "INVALID_ARGUMENTS",
  });
  await assert.rejects(
    f.client.call("resource_create", {
      kind: "employees",
      data: { name: "x", apiKey: "forbidden" },
    }),
    { code: "INVALID_ARGUMENTS" },
  );
  assert.equal(f.requests.length, 0);
  const result = await f.client.call("resource_update", {
    kind: "knowledge",
    id: "kb",
    expectedRevision: 7,
    data: { content: '引号"与换行\n' },
    idempotencyKey: "kb-edit-7",
  });
  assert.deepEqual(result, { content: '引号"与换行\n', expectedRevision: 7 });
  assert.equal(f.requests[0].headers["idempotency-key"], "kb-edit-7");
  assert.equal(f.requests[0].headers.origin, f.url);
});

test("all 14 job variants map to POST /api/jobs with explicit payloads, budgets and stable idempotency headers", async (t) => {
  const f = await fixture(t, (request) => ({
    id: `job-${request.body.type}`,
    status: "queued",
  }));
  for (const [type, payload] of Object.entries(jobInputs)) {
    const job = await f.client.call("job_submit", {
      type,
      payload,
      budgetTokens: 12345,
      idempotencyKey: `fixture-${type}`,
    });
    assert.equal(job.status, "queued");
    assert.equal(f.requests.at(-1).url, "/api/jobs");
    assert.equal(f.requests.at(-1).method, "POST");
    assert.deepEqual(f.requests.at(-1).body, {
      type,
      payload,
      budgetTokens: 12345,
    });
    assert.equal(
      f.requests.at(-1).headers["idempotency-key"],
      `fixture-${type}`,
    );
  }
  const before = f.requests.length;
  for (const args of [
    { type: "evaluate", payload: { employeeId: "wrong" } },
    { type: "unknown", payload: {} },
    { type: "evaluate", payload: jobInputs.evaluate, budgetTokens: 0 },
    {
      type: "evaluate",
      payload: { ...jobInputs.evaluate, mode: "production" },
    },
  ])
    await assert.rejects(f.client.call("job_submit", args), {
      code: "INVALID_ARGUMENTS",
    });
  assert.equal(f.requests.length, before);
});

test("API error code/status survives while credential echoes in message and details are removed", async (t) => {
  const token = "fixture-error-token-value";
  const f = await fixture(t, (_request, response) => {
    response.statusCode = 403;
    return {
      error: {
        code: "PERMISSION_DENIED",
        message: `denied ${token}`,
        details: {
          authorization: `Bearer ${token}`,
          explanation: `value=${token}`,
        },
      },
    };
  });
  const client = createEvalClient({ url: f.url, token });
  await assert.rejects(
    client.call("resource_list", { kind: "employees" }),
    (error) => {
      assert.equal(error.code, "PERMISSION_DENIED");
      assert.equal(error.status, 403);
      assert.ok(
        !JSON.stringify({ message: error.message, ...error }).includes(token),
      );
      assert.equal(error.details.authorization, "[REDACTED]");
      return true;
    },
  );
});

test("redirects are not followed and credentials are never forwarded to a second origin", async (t) => {
  const destination = await fixture(t);
  const source = await fixture(t, (_request, response) => {
    response.writeHead(307, { location: `${destination.url}/api/status` });
    response.end();
  });
  const client = createEvalClient({
    url: source.url,
    token: "fixture-redirect-token",
  });
  await assert.rejects(client.call("status"), { code: "REDIRECT_DENIED" });
  assert.equal(source.requests.length, 1);
  assert.equal(destination.requests.length, 0);
});

test("declared and chunked response size limits are enforced without logging response contents", async (t) => {
  const declared = await fixture(t, (_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": "100000",
    });
    response.end("{}");
  });
  await assert.rejects(
    createEvalClient({
      url: declared.url,
      token: "",
      maxResponseBytes: 64,
    }).call("status"),
    { code: "RESPONSE_TOO_LARGE" },
  );
  const chunked = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('"');
    response.write("x".repeat(200));
    response.end('"');
  });
  await assert.rejects(
    createEvalClient({
      url: chunked.url,
      token: "",
      maxResponseBytes: 64,
    }).call("status"),
    { code: "RESPONSE_TOO_LARGE" },
  );
});

test("a timed-out write is attempted once and a body that stalls after headers remains bounded", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"pending":');
  });
  const client = createEvalClient({ url: f.url, token: "", timeoutMs: 40 });
  await assert.rejects(
    client.call("job_submit", {
      type: "evaluate",
      payload: jobInputs.evaluate,
      idempotencyKey: "single-attempt",
    }),
    { code: "REQUEST_TIMEOUT" },
  );
  assert.equal(f.requests.length, 1);
});

test("explicit cancellation aborts a request, and already-cancelled signals send nothing", async (t) => {
  const f = await fixture(t, () => undefined);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.client.call("status", {}, { signal: aborted.signal }),
    { code: "CANCELLED" },
  );
  assert.equal(f.requests.length, 0);
  const controller = new AbortController();
  const pending = f.client.call("status", {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(f.requests.length, 1);
});

test("wait returns every documented terminal status explicitly without reporting failure as completed", async (t) => {
  const f = await fixture(t, (request) => ({
    id: "job",
    status: decodeURIComponent(request.url.split("/").at(-1)),
  }));
  for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
    const result = await f.client.call("job_wait", {
      id: status,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    assert.equal(result.terminal, true);
    assert.equal(result.timeout, false);
    assert.equal(result.job.status, status);
  }
  assert.ok(f.requests.every((request) => request.method === "GET"));
});

test("wait deadline and cancellation preserve the last nonterminal state and never cancel/resubmit the job", async (t) => {
  const f = await fixture(t, () => ({
    id: "waiting",
    status: "running",
    progress: 25,
  }));
  const result = await f.client.call("job_wait", {
    id: "waiting",
    timeoutMs: 160,
    pollIntervalMs: 100,
  });
  assert.equal(result.terminal, false);
  assert.equal(result.timeout, true);
  assert.equal(result.lastStatus, "running");
  assert.equal(result.job.progress, 25);
  const controller = new AbortController();
  const waiting = f.client.call(
    "job_wait",
    { id: "waiting", timeoutMs: 1000, pollIntervalMs: 100 },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(waiting, { code: "CANCELLED" });
  assert.ok(f.requests.every((request) => request.method === "GET"));
  const before = f.requests.length;
  await assert.rejects(
    f.client.call("job_wait", { id: "waiting", timeoutMs: 60001 }),
    { code: "INVALID_ARGUMENTS" },
  );
  assert.equal(f.requests.length, before);
});

test("wait never guesses an unknown/malformed status and slow reads become an explicit wait timeout", async (t) => {
  const bad = await fixture(t, () => ({ status: "provider-maybe-finished" }));
  await assert.rejects(
    bad.client.call("job_wait", { id: "bad", timeoutMs: 300 }),
    { code: "UNKNOWN_JOB_STATUS" },
  );
  const malformed = await fixture(t, () => ({ progress: 100 }));
  await assert.rejects(
    malformed.client.call("job_wait", { id: "bad", timeoutMs: 300 }),
    { code: "INVALID_JOB_RESPONSE" },
  );
  const slow = await fixture(t, () => undefined);
  const result = await slow.client.call("job_wait", {
    id: "slow",
    timeoutMs: 35,
  });
  assert.equal(result.timeout, true);
  assert.equal(result.terminal, false);
  assert.equal(result.job, null);
});

test("text exports preserve JSONL/newlines/Unicode and JSON exports remain JSON objects", async (t) => {
  const jsonl = '{"messages":[{"content":"你好\\n第二行"}]}\n';
  const f = await fixture(t, (request, response) => {
    if (request.url.startsWith("/api/training/export/")) {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(jsonl);
      return;
    }
    if (request.url.includes("format=markdown")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("# 报告\n\n已验证边界。\n");
      return;
    }
    if (request.url.includes("format=html")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>报告</h1>");
      return;
    }
    return { id: "exported", immutable: true };
  });
  assert.equal(
    (await f.client.call("training_export", { datasetId: "训练集" })).content,
    jsonl,
  );
  assert.equal(
    (await f.client.call("report_export", { id: "report", format: "markdown" }))
      .format,
    "markdown",
  );
  assert.equal(
    (await f.client.call("report_export", { id: "report", format: "html" }))
      .content,
    "<h1>报告</h1>",
  );
  assert.deepEqual(await f.client.call("version_export", { id: "version" }), {
    id: "exported",
    immutable: true,
  });
  assert.deepEqual(await f.client.call("report_export", { id: "report" }), {
    id: "exported",
    immutable: true,
  });
});

test("remaining public workflow mappings use dedicated endpoints with no credential-management requests", async (t) => {
  const f = await fixture(t, (request) => ({
    method: request.method,
    url: request.url,
    body: request.body ?? null,
  }));
  const samples = [
    ["capabilities", {}, "GET", "/api/agent/capabilities"],
    ["job_checkpoints", { id: "j" }, "GET", "/api/jobs/j/checkpoints"],
    [
      "job_resume",
      { id: "j", idempotencyKey: "resume-1" },
      "POST",
      "/api/jobs/j/resume",
    ],
    ["job_cancel", { id: "j" }, "POST", "/api/jobs/j/cancel"],
    [
      "training_adopt",
      { id: "training" },
      "POST",
      "/api/training/training/create-version",
    ],
    [
      "portfolio_get",
      { employeeId: "employee" },
      "GET",
      "/api/portfolio/employee",
    ],
    ["model_test", { id: "model" }, "POST", "/api/models/model/test"],
    [
      "tool_test",
      { id: "tool", args: { id: "A" }, state: {} },
      "POST",
      "/api/tools/tool/test",
    ],
    [
      "deployment_submit",
      { employeeId: "e", versionId: "v", target: "local", mode: "simulated" },
      "POST",
      "/api/deployments",
    ],
    ["deployment_rollback", { id: "d" }, "POST", "/api/deployments/d/rollback"],
    [
      "deployment_reconcile",
      { id: "d" },
      "POST",
      "/api/deployments/d/reconcile",
    ],
    [
      "review_submit",
      { runId: "r", decision: "uncertain", reason: "还需业务核对" },
      "POST",
      "/api/reviews",
    ],
    ["experience_import", { id: "e" }, "POST", "/api/experiences/e/import"],
    ["model_attempts_list", {}, "GET", "/api/model-attempts"],
    [
      "model_attempt_reconcile",
      { id: "attempt", outcome: "not_executed", source: "fixture receipt" },
      "POST",
      "/api/model-attempts/attempt/reconcile",
    ],
  ];
  for (const [name, args, method, url] of samples) {
    const result = await f.client.call(name, args);
    assert.equal(result.method, method, name);
    assert.equal(result.url, url, name);
  }
  await f.client.call("tool_test", { id: "tool" });
  assert.deepEqual(
    f.requests.at(-1).body,
    {},
    "omission preserves the registered probe arguments/state defaults",
  );
  await assert.rejects(
    f.client.call("model_attempt_reconcile", {
      id: "a",
      outcome: "completed",
      source: "missing real receipt",
    }),
    { code: "INVALID_ARGUMENTS" },
  );
});

test("malformed/empty JSON operations fail explicitly and caller JSON/header errors cannot trigger a request", async (t) => {
  const malformed = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>not API JSON</html>");
  });
  await assert.rejects(malformed.client.call("status"), {
    code: "INVALID_RESPONSE",
    status: 502,
  });
  const empty = await fixture(t, (_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await assert.rejects(empty.client.call("status"), {
    code: "INVALID_RESPONSE",
  });
  const f = await fixture(t);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const args of [
    cyclic,
    { unexpected: Infinity },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ])
    await assert.rejects(f.client.call("status", args), {
      code: "INVALID_ARGUMENTS",
    });
  await assert.rejects(
    f.client.call("job_submit", {
      type: "evaluate",
      payload: jobInputs.evaluate,
      idempotencyKey: "bad\r\nheader",
    }),
    { code: "INVALID_ARGUMENTS" },
  );
  await assert.rejects(
    f.client.call("status", {}, { signal: "not-a-signal" }),
    { code: "INVALID_ARGUMENTS" },
  );
  assert.equal(f.requests.length, 0);
});

test("shared doctor rejects a different product while preserving successful partial checks", async (t) => {
  const f = await fixture(t, (request) => {
    if (request.url === "/api/session") return { user: { id: "fixture" } };
    if (request.url === "/api/status")
      return { ok: true, modelConfigured: false };
    return { ok: true, product: "another-product" };
  });
  const result = await f.client.call("doctor");
  assert.equal(result.ok, false);
  assert.equal(result.checks.health.error.code, "PRODUCT_MISMATCH");
  assert.equal(result.checks.capabilities.error.code, "PRODUCT_MISMATCH");
  assert.equal(result.checks.session.ok, true);
  assert.equal(result.modelProbeExecuted, false);
  assert.equal(f.requests.length, 4);
  const incompatible = await fixture(t, (request) => {
    if (request.url === "/api/session") return { user: { id: "fixture" } };
    if (request.url === "/api/status") return { ok: true };
    return { ok: true, product: "workloom-eval", apiVersion: "unsupported" };
  });
  const wrongVersion = await incompatible.client.call("doctor");
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.checks.health.ok, true);
  assert.equal(
    wrongVersion.checks.capabilities.error.code,
    "API_VERSION_MISMATCH",
  );
});

test("actual HTTP API supports resource CAS, imports, immutable version exports and queued job idempotency/cancellation through the client", async (t) => {
  const { client } = await actualApplication(t);
  assert.equal((await client.call("health")).product, "workloom-eval");
  assert.equal((await client.call("session")).role, "admin");
  assert.ok(Array.isArray((await client.call("bootstrap")).employees));
  const employee = await client.call("resource_create", {
    kind: "employees",
    data: { name: "CLI 合成售后", role: "客服" },
  });
  const updated = await client.call("resource_update", {
    kind: "employees",
    id: employee.id,
    expectedRevision: employee.revision,
    data: { description: "已更新\n含特殊字符‘’" },
  });
  assert.equal(updated.revision, employee.revision + 1);
  await assert.rejects(
    client.call("resource_update", {
      kind: "employees",
      id: employee.id,
      expectedRevision: employee.revision,
      data: { description: "过期修订" },
    }),
    { code: "REVISION_CONFLICT" },
  );
  const knowledge = await client.call("knowledge_import", {
    name: "测试知识",
    content: '合成政策\n引号"',
    source: "fixture",
  });
  assert.equal(knowledge.published, false);
  assert.equal(knowledge.allowedModelEgress, false);
  const dataset = await client.call("dataset_import", {
    name: "CLI开发集",
    purpose: "dev",
    cases: [{ name: "查询", input: "你好", expected: "澄清", assertions: [] }],
  });
  assert.equal(dataset.caseIds.length, 1);
  const version = await client.call("version_create", {
    employeeId: employee.id,
    modelId: "model-deepseek",
    prompt: "按授权资料回答",
    knowledgeIds: [],
    toolIds: [],
    skillIds: [],
  });
  assert.equal(
    (await client.call("version_export", { id: version.id })).manifestHash,
    version.manifestHash,
  );
  const args = {
    type: "evaluate",
    payload: { versionId: version.id, datasetId: dataset.id },
    budgetTokens: 1000,
    idempotencyKey: "client-http-fixture-queue",
  };
  const first = await client.call("job_submit", args);
  const second = await client.call("job_submit", args);
  assert.equal(first.id, second.id);
  assert.equal(first.status, "queued");
  assert.deepEqual(await client.call("job_checkpoints", { id: first.id }), []);
  assert.equal(
    (await client.call("job_cancel", { id: first.id })).status,
    "cancelled",
  );
  assert.equal(
    (await client.call("job_wait", { id: first.id, timeoutMs: 500 })).job
      .status,
    "cancelled",
  );
  assert.ok(
    (await client.call("events_list", { subjectId: employee.id })).length >= 2,
  );
  const spare = await client.call("resource_create", {
    kind: "employees",
    data: { name: "可删除的合成员工" },
  });
  assert.equal(
    (await client.call("resource_delete", { kind: "employees", id: spare.id }))
      .deleted,
    true,
  );
  const external = await client.call("resource_create", {
    kind: "employees",
    data: {
      name: "外部员工仅配置不执行",
      role: "合成客服",
      accessMode: "http",
      endpoint: "https://employee.example.invalid/run",
      secretRef: "already-provisioned-reference",
    },
  });
  const externalVersion = await client.call("version_create", {
    employeeId: external.id,
    modelId: "model-deepseek",
    prompt: "遵守授权边界",
    memoryPolicy: "isolated",
  });
  assert.equal(
    externalVersion.manifest.employeeAccess.secretRef,
    "already-provisioned-reference",
  );
  assert.equal(externalVersion.memoryPolicy, "isolated");
});

test("actual password HTTP API preserves viewer authorization and workspace isolation through session-cookie client", async (t) => {
  const { store, url } = await actualApplication(t, { password: true });
  store.createUser({
    email: "client-viewer@example.invalid",
    password: "fixture-viewer-pass",
    workspace: "viewer-space",
    role: "viewer",
  });
  const login = store.login(
    "client-viewer@example.invalid",
    "fixture-viewer-pass",
  );
  const client = createEvalClient({
    url,
    token: "",
    sessionCookie: `eval_session=${login.token}`,
  });
  assert.equal((await client.call("session")).role, "viewer");
  assert.deepEqual(
    await client.call("resource_list", { kind: "employees" }),
    [],
  );
  await assert.rejects(
    client.call("resource_create", {
      kind: "employees",
      data: { name: "not allowed" },
    }),
    { code: "PERMISSION_DENIED", status: 403 },
  );
  await assert.rejects(
    client.call("resource_get", {
      kind: "employees",
      id: "employee-aftersale",
    }),
    { code: "NOT_FOUND", status: 404 },
  );
  await assert.rejects(createEvalClient({ url, token: "" }).call("status"), {
    code: "LOGIN_REQUIRED",
    status: 401,
  });
});
