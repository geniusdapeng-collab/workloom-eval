import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { createToolService } from "../server/tools.mjs";
import { createAdvanced } from "../server/advanced.mjs";
import {
  safeRequest,
  validateTarget,
  assertSchema,
  isPrivateAddress,
} from "../server/safe-http.mjs";
import { createStore } from "../server/store.mjs";
import { createEngine } from "../server/engine.mjs";
import {
  runScriptTask,
  runBrowserTask,
  runRegisteredTask,
  runWorker,
} from "../scripts/runner.mjs";

function memoryStore() {
  const data = new Map(),
    events = [];
  const key = (kind, id, workspace) => `${workspace}:${kind}:${id}`;
  return {
    list(kind, workspace = "default") {
      return [...data.entries()]
        .filter(([k]) => k.startsWith(`${workspace}:${kind}:`))
        .map(([, v]) => structuredClone(v));
    },
    get(kind, id, workspace = "default") {
      const value = data.get(key(kind, id, workspace));
      if (!value) throw Object.assign(new Error("资源不存在"), { status: 404 });
      return structuredClone(value);
    },
    create(kind, value, workspace = "default") {
      const record = {
        ...structuredClone(value),
        id: value.id || randomUUID(),
        workspace,
        revision: 1,
        createdAt: new Date().toISOString(),
      };
      data.set(key(kind, record.id, workspace), record);
      return structuredClone(record);
    },
    put(kind, value, workspace = "default", options = {}) {
      const old = this.get(kind, value.id, workspace);
      if (options.expectedRevision && old.revision !== options.expectedRevision)
        throw Object.assign(new Error("版本冲突"), { status: 409 });
      const record = {
        ...structuredClone(value),
        revision: old.revision + 1,
        workspace,
      };
      data.set(key(kind, value.id, workspace), record);
      return structuredClone(record);
    },
    transaction(fn) {
      return fn();
    },
    event(workspace, kind, subjectId, value) {
      events.push({ workspace, kind, subjectId, ...value });
    },
    events() {
      return events;
    },
  };
}

function fixture(extraModel = {}) {
  const store = memoryStore();
  const model = {
    complete: async () => ({
      value: { answer: "完成", memoryCandidates: [] },
      usage: { totalTokens: 12 },
      receipt: { id: "real-adapter-test" },
    }),
    ...extraModel,
  };
  const employee = store.create("employees", {
    name: "退款专员",
    role: "客服",
  });
  const tool = store.create("tools", {
    name: "refund_order",
    adapter: "simulation",
    operation: "refund",
    mode: "simulated",
    config: { resource: "orders" },
    inputSchema: {
      type: "object",
      required: ["id", "amount"],
      properties: {
        id: { type: "string" },
        amount: { type: "number", minimum: 0.01 },
        idempotencyKey: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["status"] },
  });
  const skill = store.create("skills", {
    name: "退款流程",
    content: "先核对再退款",
    version: 1,
    steps: [{ toolId: tool.id, argsTemplate: {} }],
  });
  const version = store.create("versions", {
    employeeId: employee.id,
    label: "V1",
    prompt: "处理客服任务",
    toolIds: [tool.id],
    skillIds: [skill.id],
    modelId: "model-1",
  });
  store.put("employees", { ...employee, currentVersionId: version.id });
  const dataset = store.create("datasets", {
    name: "训练集",
    purpose: "train",
    caseIds: [],
  });
  const c = store.create("cases", {
    datasetId: dataset.id,
    input: "退款\n订单“42”",
    expected: "已核验退款条件",
    assertions: [],
    hidden: false,
  });
  store.put("datasets", { ...dataset, caseIds: [c.id] });
  const engine = {
    validateVersion(versionId, workspace) {
      const checked = store.get("versions", versionId, workspace);
      for (const toolId of checked.toolIds || []) {
        const current = store.get("tools", toolId, workspace);
        if (current.revoked)
          throw Object.assign(new Error("工具撤销"), {
            code: "ASSET_REVOKED",
            status: 403,
          });
      }
      return checked;
    },
    buildReport(run, workspace) {
      return store.create(
        "reports",
        { runId: run.id, versionId: run.versionId, metrics: run.metrics },
        workspace,
      );
    },
    createVersion(id, config, workspace) {
      return store.create(
        "versions",
        { ...config, id: undefined, employeeId: id },
        workspace,
      );
    },
    async executeJob(job, ctx) {
      const run = store.create(
        "runs",
        {
          versionId: job.payload.versionId,
          datasetId: job.payload.datasetId,
          status: "completed",
          metrics: {
            score: 90,
            total: 1,
            valid: 1,
            incomplete: 0,
            violations: 0,
            tokens: 100,
            latencyMs: 30,
          },
          manifest: { evaluatorHash: "e1", datasetHash: "d1" },
          caseResults: [],
        },
        ctx.workspace,
      );
      return { runId: run.id, metrics: run.metrics };
    },
  };
  const tools = createToolService({ store, model });
  return {
    store,
    model,
    tools,
    engine,
    employee,
    tool,
    skill,
    version,
    dataset,
    c,
    advanced: createAdvanced({ store, model, tools, engine }),
  };
}

async function serverFixture(t, handler) {
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      await handler(req, res, raw ? JSON.parse(raw) : null);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const policy = {
    allowedHosts: [url],
    allowPrivateHosts: [url],
    allowInsecure: true,
  };
  const request = (args) => safeRequest({ ...args, ...policy });
  return { server, url, policy, request };
}
const state = () => ({ orders: [{ id: "42", amount: 100, status: "paid" }] });
const ctx = () => ({
  workspace: "default",
  jobId: "advanced-test",
  onProgress() {},
});
function acceptanceFixture(f, versionId, n = 40) {
  const dataset = f.store.create("datasets", {
    purpose: "holdout",
    generated: false,
    caseIds: [],
  });
  const cases = Array.from({ length: n }, (_, i) =>
    f.store.create("cases", {
      datasetId: dataset.id,
      name: `独立验收${i + 1}`,
      input: `场景${i + 1}`,
      expected: `结果${i + 1}`,
      hidden: true,
    }),
  );
  const frozen = f.store.put("datasets", {
    ...dataset,
    caseIds: cases.map((c) => c.id),
  });
  return f.store.create("runs", {
    versionId,
    datasetId: dataset.id,
    status: "completed",
    modelMode: "real",
    toolMode: "test",
    metrics: {
      score: 99,
      total: n,
      valid: n,
      passed: n,
      passRate: 1,
      incomplete: 0,
      violations: 0,
      uniqueCases: n,
      stableCases: n,
    },
    caseResults: cases.map((c) => ({
      caseId: c.id,
      status: "completed",
      passed: true,
      score: 99,
    })),
    manifest: {
      datasetPurpose: "holdout",
      generatedDataset: false,
      datasetRevision: frozen.revision,
      caseHashes: cases.map((c) => ({
        id: c.id,
        revision: c.revision,
        hash: createHash("sha256").update(JSON.stringify(c)).digest("hex"),
      })),
    },
  });
}

function frozenFixture(t) {
  const store = createStore();
  t.after(() => store.close());
  let modelCalls = 0;
  const model = {
    complete: async (request) => {
      modelCalls++;
      if (request.scene === "evaluation.judge")
        return {
          value: {
            score: 95,
            passed: true,
            reason: "合成裁判测试",
            confidence: "high",
            issues: [],
          },
          usage: { totalTokens: 20 },
          receipt: { id: "test-judge" },
        };
      const newPolicy = request.messages[0].content.includes("新政策上限200元");
      return {
        content: newPolicy ? "新政策上限200元" : "旧政策上限100元",
        toolCalls: [],
        usage: { totalTokens: 20 },
        receipt: { id: "test-worker" },
      };
    },
  };
  const tools = createToolService({ store, model }),
    engine = createEngine({ store, model, tools });
  const defaultModel = store.create("models", {
    name: "合成默认模型",
    provider: "test-compatible",
    model: "base-worker",
    baseUrl: "https://baseline.example.test",
    secretRef: "baseline-session",
    contextTokens: 100000,
    maxOutputTokens: 20000,
    default: true,
  });
  const employee = store.create("employees", {
    name: "合成员工",
    accessMode: "managed",
  });
  const knowledge = store.create("knowledge", {
    name: "额度政策",
    content: "旧政策上限100元",
    published: true,
    status: "published",
    allowedModelEgress: true,
  });
  const tool = store.create("tools", {
    name: "query",
    adapter: "simulation",
    operation: "query",
    mode: "simulated",
    permissions: ["read"],
  });
  const skill = store.create("skills", {
    name: "额度核验",
    content: "先核对额度",
    steps: [],
    toolIds: [tool.id],
  });
  const version = engine.createVersion(employee.id, {
    prompt: "按已授权政策说明额度",
    modelId: defaultModel.id,
    knowledgeIds: [knowledge.id],
    toolIds: [tool.id],
    skillIds: [skill.id],
  });
  store.put("employees", { ...employee, currentVersionId: version.id });
  const advanced = createAdvanced({ store, model, tools, engine });
  function dataset(purpose = "dev") {
    const d = store.create("datasets", {
      name: "政策回归集",
      purpose,
      caseIds: [],
    });
    const scenario = store.create("cases", {
      datasetId: d.id,
      name: "新额度事实",
      input: "当前额度多少？",
      expected: "新政策上限200元",
      initialState: {},
      assertions: [{ type: "contains", value: "200" }],
      hidden: false,
    });
    return store.put("datasets", { ...d, caseIds: [scenario.id] });
  }
  return {
    store,
    model,
    tools,
    engine,
    advanced,
    employee,
    defaultModel,
    knowledge,
    tool,
    skill,
    version,
    dataset,
    get modelCalls() {
      return modelCalls;
    },
  };
}

test("仿真退款改变独立用例状态并产出可追溯回执", async () => {
  const f = fixture(),
    initial = state();
  const result = await f.tools.execute({
    toolId: f.tool.id,
    args: { id: "42", amount: 80, idempotencyKey: "a" },
    state: initial,
  });
  assert.equal(result.state.orders[0].status, "refunded");
  assert.equal(initial.orders[0].status, "paid");
  assert.equal(result.receipt.mode, "simulated");
  assert.equal(result.receipt.toolRevision, 1);
  assert.ok(result.receipt.argsHash && result.receipt.resultHash);
});

test("同参数幂等重放不重复退款，不同参数复用key被拒绝", async () => {
  const f = fixture(),
    args = { id: "42", amount: 80, idempotencyKey: "repeat" };
  const first = await f.tools.execute({
    toolId: f.tool.id,
    args,
    state: state(),
  });
  const again = await f.tools.execute({
    toolId: f.tool.id,
    args,
    state: first.state,
  });
  assert.equal(again.receipt.replayed, true);
  assert.equal(again.state.orders[0].refundedAmount, 80);
  await assert.rejects(
    f.tools.execute({
      toolId: f.tool.id,
      args: { ...args, amount: 50 },
      state: first.state,
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("写后超时保留状态及幂等记录，相同key可恢复真实结果", async () => {
  const f = fixture(),
    initial = {
      ...state(),
      __fault: { type: "after-write-timeout", once: true },
    },
    args = { id: "42", amount: 100, idempotencyKey: "lost-receipt" };
  let recovered;
  try {
    await f.tools.execute({ toolId: f.tool.id, args, state: initial });
  } catch (error) {
    assert.equal(error.code, "SIMULATED_TIMEOUT_AFTER_WRITE");
    recovered = error.details.state;
  }
  assert.equal(recovered.orders[0].status, "refunded");
  const retry = await f.tools.execute({
    toolId: f.tool.id,
    args,
    state: recovered,
  });
  assert.equal(retry.receipt.replayed, true);
});

test("一次性故障状态随错误传回，重试不会永久超时", async () => {
  const f = fixture();
  let next;
  try {
    await f.tools.execute({
      toolId: f.tool.id,
      args: { id: "42", amount: 10 },
      state: { ...state(), __fault: { type: "timeout", once: true } },
    });
  } catch (error) {
    assert.equal(error.code, "SIMULATED_TIMEOUT");
    next = error.details.state;
  }
  const result = await f.tools.execute({
    toolId: f.tool.id,
    args: { id: "42", amount: 10 },
    state: next,
  });
  assert.equal(result.result.status, "refunded");
});

test("只读权限、超额退款、未知schema字段与其他工作区都被拒绝", async () => {
  const f = fixture();
  await assert.rejects(
    f.tools.execute({
      toolId: f.tool.id,
      args: { id: "42", amount: 10 },
      state: state(),
      mode: "readonly",
    }),
    { code: "READONLY_TOOL" },
  );
  await assert.rejects(
    f.tools.execute({
      toolId: f.tool.id,
      args: { id: "42", amount: 101 },
      state: state(),
    }),
    { code: "REFUND_EXCEEDS_AMOUNT" },
  );
  await assert.rejects(
    f.tools.execute({
      toolId: f.tool.id,
      args: { id: "42", amount: 1, secret: "x" },
      state: state(),
    }),
    { code: "TOOL_SCHEMA" },
  );
  await assert.rejects(
    f.tools.execute({ workspace: "other", toolId: f.tool.id, args: {} }),
    { status: 404 },
  );
});

test("冻结工具快照在实时工具更新后仍使用原操作，并拒绝跨区快照", async () => {
  const f = fixture();
  f.store.put("tools", { ...f.tool, operation: "delete" });
  const result = await f.tools.execute({
    toolId: f.tool.id,
    toolSnapshot: f.tool,
    args: { id: "42", amount: 20 },
    state: state(),
  });
  assert.equal(result.result.status, "refunded");
  await assert.rejects(
    f.tools.execute({
      workspace: "other",
      toolId: f.tool.id,
      toolSnapshot: f.tool,
    }),
    { code: "TOOL_SCOPE_MISMATCH" },
  );
});

test("网络策略阻止私网、未许可host、userinfo、协议及IPv6映射绕过", async () => {
  assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  await assert.rejects(
    validateTarget("http://127.0.0.1/", {
      allowedHosts: ["127.0.0.1"],
      allowInsecure: true,
    }),
    { code: "PRIVATE_NETWORK_DENIED" },
  );
  await assert.rejects(validateTarget("https://unapproved.example/", {}), {
    code: "HOST_NOT_ALLOWED",
  });
  await assert.rejects(
    validateTarget("https://user:pass@example.com/", {
      allowedHosts: ["example.com"],
    }),
    { code: "UNSAFE_URL" },
  );
  await assert.rejects(validateTarget("file:///etc/passwd", {}), {
    code: "UNSAFE_URL",
  });
});

test("实际HTTP请求支持固定允许地址，拒绝重定向、超大响应与非2xx", async (t) => {
  const s = await serverFixture(t, (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
    } else if (req.url === "/large") res.end("x".repeat(2000));
    else if (req.url === "/error") {
      res.writeHead(429);
      res.end("{}");
    } else {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    }
  });
  assert.equal((await s.request({ url: s.url })).data.ok, true);
  await assert.rejects(s.request({ url: `${s.url}/redirect` }), {
    code: "REDIRECT_DENIED",
  });
  await assert.rejects(s.request({ url: `${s.url}/large`, maxBytes: 100 }), {
    code: "RESPONSE_TOO_LARGE",
  });
  await assert.rejects(s.request({ url: `${s.url}/error` }), { status: 429 });
});

test("工具用户配置不能扩大管理员host列表，真实业务工具不能偷偷进入仿真", async () => {
  const f = fixture({
    request: async () => {
      throw new Error("不应发送");
    },
  });
  const tool = f.store.create("tools", {
    adapter: "http",
    operation: "read",
    mode: "readonly",
    config: { url: "http://127.0.0.1/", allowedHosts: ["127.0.0.1"] },
  });
  const service = createToolService({
    store: f.store,
    model: f.model,
    networkPolicy: { allowedHosts: [], allowInsecure: true },
  });
  await assert.rejects(service.execute({ toolId: tool.id, mode: "readonly" }), {
    code: "HOST_NOT_ALLOWED",
  });
  await assert.rejects(
    service.execute({ toolId: tool.id, mode: "simulated" }),
    { code: "SIMULATION_ADAPTER_REQUIRED" },
  );
});

test("MCP握手与SSE结果实际走HTTP，session和协议头被传回", async (t) => {
  const messages = [];
  const s = await serverFixture(t, (req, res, body) => {
    messages.push({ body, headers: req.headers });
    if (body.method === "initialize") {
      res.setHeader("mcp-session-id", "session-test");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "test", version: "1" },
          },
        }),
      );
    } else if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
    } else {
      res.setHeader("content-type", "text/event-stream");
      res.end(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "真实HTTP工具结果" }] } })}\n\n`,
      );
    }
  });
  const f = fixture({ request: s.request });
  const tool = f.store.create("tools", {
    name: "lookup",
    adapter: "mcp",
    operation: "read",
    mode: "readonly",
    config: { url: `${s.url}/mcp` },
  });
  const tools = createToolService({
    store: f.store,
    model: f.model,
    networkPolicy: s.policy,
  });
  const result = await tools.execute({
    toolId: tool.id,
    args: { query: "42" },
    mode: "readonly",
  });
  assert.equal(result.result.content[0].text, "真实HTTP工具结果");
  assert.equal(messages[2].headers["mcp-session-id"], "session-test");
  assert.equal(messages[2].headers["mcp-protocol-version"], "2025-11-25");
});

test("生产写操作默认失败，没有审批不能发送外部请求", async () => {
  const f = fixture({
    request: async () => {
      assert.fail("不应调用");
    },
  });
  const tool = f.store.create("tools", {
    adapter: "http",
    operation: "refund",
    mode: "production",
    config: { url: "https://example.com" },
  });
  await assert.rejects(
    f.tools.execute({
      toolId: tool.id,
      args: { amount: 10 },
      mode: "production",
    }),
    { code: "PRODUCTION_APPROVAL_REQUIRED" },
  );
});

test("生产browser即使以test评测模式调用也不能跳过审批进入节点队列", async () => {
  const f = fixture();
  const tool = f.store.create("tools", {
    adapter: "browser",
    operation: "browse",
    mode: "production",
    permissions: ["read"],
    config: { taskName: "registered-production-page" },
  });
  await assert.rejects(
    f.tools.execute({ toolId: tool.id, args: {}, mode: "test" }),
    { code: "PRODUCTION_APPROVAL_REQUIRED" },
  );
  assert.equal(f.store.list("executions").length, 0);
});

test("生产审批绑定参数且一次消费，已完成的幂等重放不重复发送", async (t) => {
  let calls = 0;
  const s = await serverFixture(t, (_req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.end('{"status":"accepted"}');
  });
  const f = fixture({ request: s.request });
  const tool = f.store.create("tools", {
    name: "approved_write",
    adapter: "http",
    operation: "update",
    mode: "production",
    config: { url: s.url, writes: true },
  });
  const tools = createToolService({
    store: f.store,
    model: f.model,
    networkPolicy: s.policy,
  });
  const args = { id: "42", value: "approved", idempotencyKey: "prod-1" };
  const approval = f.store.create("approvals", {
    status: "approved",
    toolId: tool.id,
    operation: "update",
    argsHash: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  });
  await assert.rejects(
    tools.execute({
      toolId: tool.id,
      args: { ...args, value: "changed" },
      approvalId: approval.id,
      mode: "production",
    }),
    { code: "APPROVAL_MISMATCH" },
  );
  const result = await tools.execute({
    toolId: tool.id,
    args,
    approvalId: approval.id,
    mode: "production",
  });
  assert.equal(f.store.get("approvals", approval.id).status, "consumed");
  const replay = await tools.execute({
    toolId: tool.id,
    args,
    state: result.state,
    mode: "production",
  });
  assert.equal(replay.receipt.replayed, true);
  assert.equal(calls, 1);
  await assert.rejects(
    tools.execute({
      toolId: tool.id,
      args,
      approvalId: approval.id,
      mode: "production",
    }),
    { code: "APPROVAL_MISMATCH" },
  );
});

test("私有执行器队列等到真实完成回执后才返回，取消撤销排队任务", async () => {
  const f = fixture(),
    tool = f.store.create("tools", {
      adapter: "script",
      operation: "calculate",
      mode: "readonly",
      config: { taskName: "approved-sum", timeoutMs: 1000 },
    });
  const timer = setTimeout(() => {
    const task = f.store.list("executions")[0];
    f.store.put("executions", {
      ...task,
      status: "completed",
      nodeId: "node-1",
      result: { value: 6 },
    });
  }, 30);
  const output = await f.tools.execute({
    toolId: tool.id,
    args: { values: [1, 2, 3] },
    mode: "readonly",
  });
  clearTimeout(timer);
  assert.equal(output.result.value, 6);
  assert.equal(output.receipt.nodeId, "node-1");
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("取消")), 20);
  await assert.rejects(
    f.tools.execute({
      toolId: tool.id,
      mode: "readonly",
      signal: controller.signal,
    }),
  );
  assert.equal(f.store.list("executions").at(-1).status, "cancelled");
});

test("声明式脚本在实际权限子进程处理数据，不执行未注册主机代码", async () => {
  const result = await runScriptTask(
    {
      steps: [
        { action: "select", path: "rows" },
        { action: "filter", path: "active", equals: true },
        { action: "sum", path: "amount" },
      ],
    },
    {
      rows: [
        { active: true, amount: 3 },
        { active: false, amount: 99 },
        { active: true, amount: 4 },
      ],
    },
  );
  assert.equal(result.result, 7);
  assert.equal(result.exitCode, 0);
  await assert.rejects(
    runScriptTask(
      { steps: [{ action: "exec", command: "touch /tmp/unsafe" }] },
      {},
    ),
    { code: "SCRIPT_FAILED" },
  );
  await assert.rejects(
    runRegisteredTask(
      { requiredCapability: "script", payload: { taskName: "not-approved" } },
      {},
    ),
    { code: "RUNNER_TASK_UNREGISTERED" },
  );
});

test("runner通过真实claim/result端点履行lease，任务结果来自权限子进程", async (t) => {
  let delivered = false,
    observed;
  const task = {
    id: "execution-1",
    leaseId: "lease-1",
    requiredCapability: "script",
    payload: { taskName: "sum", args: { values: [2, 3] } },
  };
  const s = await serverFixture(t, (req, res, body) => {
    assert.equal(req.headers.authorization, "Bearer runner-test");
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/claim")) {
      delivered = true;
      res.end(JSON.stringify({ task }));
    } else {
      observed = body;
      res.end('{"ok":true}');
    }
  });
  const output = await runWorker({
    url: s.url,
    token: "runner-test",
    once: true,
    registry: {
      sum: {
        capability: "script",
        steps: [{ action: "select", path: "values" }, { action: "sum" }],
      },
    },
  });
  assert.equal(delivered, true);
  assert.equal(output.result.result, 5);
  assert.equal(observed.leaseId, "lease-1");
  assert.equal(observed.taskId, "execution-1");
});

test("真实隔离浏览器执行注册步骤，填写点击断言截图并禁止只读POST", async (t) => {
  let writes = 0;
  const s = await serverFixture(t, (req, res) => {
    if (req.method === "POST") writes++;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><html lang=\"zh\"><title>执行器真机测试</title><input id=\"name\"><button id=\"echo\" onclick=\"document.querySelector('#result').textContent='你好 '+document.querySelector('#name').value\">回显</button><button id=\"write\" onclick=\"fetch('/write',{method:'POST'}).then(()=>{document.querySelector('#result').textContent='written'}).catch(()=>{document.querySelector('#result').textContent='blocked'})\">写入</button><p id=\"result\">等待</p></html>",
    );
  });
  const definition = {
    capability: "browser",
    browserChannel: "bundled",
    startUrl: s.url,
    ...s.policy,
    steps: [
      { action: "fill", selector: "#name", value: "{{name}}" },
      { action: "click", selector: "#echo" },
      { action: "assert_text", selector: "#result", value: "你好 数字员工" },
      { action: "text", selector: "#result" },
      { action: "screenshot" },
    ],
  };
  const result = await runBrowserTask(definition, { name: "数字员工" });
  assert.equal(result.title, "执行器真机测试");
  assert.equal(result.results[3].text, "你好 数字员工");
  assert.ok(result.results[4].base64.startsWith("iVBOR"));
  await assert.rejects(
    runBrowserTask(
      {
        ...definition,
        steps: [
          { action: "click", selector: "#write" },
          { action: "assert_text", selector: "#result", value: "blocked" },
        ],
      },
      {},
    ),
    { code: "BROWSER_NETWORK_POLICY" },
  );
  assert.equal(writes, 0);
  const mutationDefinition = {
    ...definition,
    allowMutations: true,
    steps: [
      { action: "click", selector: "#write" },
      { action: "assert_text", selector: "#result", value: "blocked" },
    ],
  };
  await assert.rejects(
    runBrowserTask(
      mutationDefinition,
      {},
      { mode: "test", toolMode: "production" },
    ),
    { code: "BROWSER_NETWORK_POLICY" },
  );
  assert.equal(writes, 0);
  const permitted = await runBrowserTask(
    {
      ...mutationDefinition,
      steps: [
        { action: "click", selector: "#write" },
        { action: "assert_text", selector: "#result", value: "written" },
      ],
    },
    {},
    { mode: "test", toolMode: "test" },
  );
  assert.equal(permitted.results[1].passed, true);
  assert.equal(writes, 1);
});

test("注册浏览器视口实际覆盖320/390/1440，输入参数不能越过管理员固定尺寸", async (t) => {
  const s = await serverFixture(t, (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>响应式执行器</title><p id="width"></p><script>document.querySelector("#width").textContent=String(window.innerWidth)</script>',
    );
  });
  for (const width of [320, 390, 1440]) {
    const result = await runRegisteredTask(
      {
        requiredCapability: "browser",
        payload: {
          taskName: "responsive",
          args: { viewport: { width: 9999, height: 9999 } },
          mode: "readonly",
          toolMode: "readonly",
        },
      },
      {
        responsive: {
          capability: "browser",
          ...s.policy,
          startUrl: s.url,
          viewport: { width, height: 800 },
          steps: [
            { action: "assert_text", selector: "#width", value: String(width) },
            { action: "text", selector: "#width" },
          ],
        },
      },
    );
    assert.equal(result.results[1].text, String(width));
    assert.deepEqual(result.viewport, { width, height: 800 });
  }
  await assert.rejects(
    runBrowserTask(
      { ...s.policy, viewport: { width: 9999, height: 800 }, steps: [] },
      {},
    ),
    { code: "BROWSER_VIEWPORT_INVALID" },
  );
});

test("训练JSONL保留Unicode换行并阻止holdout与无参考答案数据导出", () => {
  const f = fixture(),
    jsonl = f.advanced.exportTraining(f.dataset.id);
  const row = JSON.parse(jsonl.trim());
  assert.equal(row.messages[0].content, "退款\n订单“42”");
  assert.equal(jsonl.trim().split("\n").length, 1);
  const holdout = f.store.create("datasets", {
    purpose: "holdout",
    caseIds: [f.c.id],
  });
  assert.throws(() => f.advanced.exportTraining(holdout.id), {
    code: "DATASET_PURPOSE_DENIED",
  });
  f.store.put("cases", { ...f.c, expected: "" });
  assert.throws(() => f.advanced.exportTraining(f.dataset.id), {
    code: "TRAINING_REFERENCE_REQUIRED",
  });
});

test("DeepSeek微调明确返回capability错误，不生成虚构训练任务", async () => {
  const f = fixture();
  const provider = f.store.create("models", {
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
  });
  await assert.rejects(
    f.advanced.executeJob(
      {
        type: "fine_tune",
        payload: {
          providerModelId: provider.id,
          employeeId: f.employee.id,
          datasetId: f.dataset.id,
        },
      },
      ctx(),
    ),
    { code: "FINE_TUNING_UNSUPPORTED" },
  );
  assert.equal(f.store.list("training").length, 0);
});

test("通用异步微调实际HTTP提交并轮询，任务ID和模型来自服务回执", async (t) => {
  let accepted;
  const s = await serverFixture(t, (req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      accepted = body;
      res.end('{"id":"provider-job-actual","status":"running"}');
    } else {
      assert.equal(req.url, "/training/provider-job-actual");
      res.end(
        '{"id":"provider-job-actual","status":"succeeded","resultModel":"trained-model-actual","metrics":{"loss":0.2}}',
      );
    }
  });
  const f = fixture({ request: s.request });
  const provider = f.store.create("models", {
    provider: "http-training",
    model: "base",
    training: { endpoint: `${s.url}/training`, protocol: "workloom-async-v1" },
  });
  const submitted = await f.advanced.executeJob(
    {
      type: "fine_tune",
      payload: {
        providerModelId: provider.id,
        employeeId: f.employee.id,
        datasetId: f.dataset.id,
        hyperparameters: { epochs: 1 },
      },
    },
    ctx(),
  );
  assert.equal(submitted.externalJobId, "provider-job-actual");
  assert.equal(accepted.configuration.epochs, 1);
  const result = await f.advanced.executeJob(
    { type: "poll_training", payload: { trainingId: submitted.trainingId } },
    ctx(),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.resultModel, "trained-model-actual");
});

test("训练提交在提供方权限denied或enabled=false时不发送数据且不创建任务", async () => {
  for (const permissions of [{ denied: true }, { enabled: false }]) {
    let requests = 0;
    const f = fixture({
      request: async () => {
        requests++;
        return { id: "should-not-be-submitted", status: "running" };
      },
    });
    const provider = f.store.create("models", {
      provider: "http-training",
      model: "base",
      permissions,
      training: {
        endpoint: "https://training.example.test/jobs",
        protocol: "workloom-async-v1",
      },
    });
    await assert.rejects(
      f.advanced.executeJob(
        {
          type: "fine_tune",
          payload: {
            providerModelId: provider.id,
            employeeId: f.employee.id,
            datasetId: f.dataset.id,
          },
        },
        ctx(),
      ),
      { code: "TRAINING_PROVIDER_REVOKED", status: 403 },
    );
    assert.equal(requests, 0);
    assert.equal(f.store.list("training").length, 0);
  }
});

test("训练轮询复检当前提供方denied或enabled=false并保留原提交状态", async () => {
  for (const permissions of [{ denied: true }, { enabled: false }]) {
    let requests = 0;
    const f = fixture({
      request: async ({ method }) => {
        requests++;
        return method === "POST"
          ? { id: "existing-provider-job", status: "running" }
          : {
              id: "existing-provider-job",
              status: "succeeded",
              resultModel: "should-not-be-observed",
            };
      },
    });
    const provider = f.store.create("models", {
      provider: "http-training",
      model: "base",
      training: {
        endpoint: "https://training.example.test/jobs",
        protocol: "workloom-async-v1",
      },
    });
    const submitted = await f.advanced.executeJob(
      {
        type: "fine_tune",
        payload: {
          providerModelId: provider.id,
          employeeId: f.employee.id,
          datasetId: f.dataset.id,
        },
      },
      ctx(),
    );
    const before = f.store.get("training", submitted.trainingId);
    f.store.put("models", { ...provider, permissions });
    await assert.rejects(
      f.advanced.executeJob(
        {
          type: "poll_training",
          payload: { trainingId: submitted.trainingId },
        },
        ctx(),
      ),
      { code: "TRAINING_PROVIDER_REVOKED", status: 403 },
    );
    assert.equal(requests, 1);
    assert.deepEqual(f.store.get("training", submitted.trainingId), before);
  }
});

test("本地部署变更实际版本指针且明确simulation，回退恢复原版本", async () => {
  const f = fixture();
  const v2 = f.store.create("versions", {
    ...f.version,
    id: undefined,
    label: "V2",
  });
  acceptanceFixture(f, v2.id, 1);
  const deployment = await f.advanced.deploy({
    employeeId: f.employee.id,
    versionId: v2.id,
    target: "local",
    mode: "simulated",
  });
  assert.equal(deployment.receipt.mode, "simulated");
  assert.equal(f.store.get("employees", f.employee.id).currentVersionId, v2.id);
  const rolled = await f.advanced.rollback(deployment.id);
  assert.equal(rolled.status, "rolled_back");
  assert.equal(
    f.store.get("employees", f.employee.id).currentVersionId,
    f.version.id,
  );
});

test("真实部署与回退通过目标HTTP回执和独立GET回读验证", async (t) => {
  let active,
    receipt,
    count = 0;
  const s = await serverFixture(t, (req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      active = body.versionId;
      receipt = `actual-receipt-${++count}`;
      res.end(JSON.stringify({ receiptId: receipt }));
    } else res.end(JSON.stringify({ receiptId: receipt, versionId: active }));
  });
  const f = fixture({ request: s.request }),
    v2 = f.store.create("versions", {
      ...f.version,
      id: undefined,
      label: "V2-real",
    });
  acceptanceFixture(f, v2.id, 40);
  const deployment = await f.advanced.deploy({
    employeeId: f.employee.id,
    versionId: v2.id,
    target: `${s.url}/deployment`,
    mode: "real",
  });
  assert.equal(deployment.receipt.synced, true);
  assert.equal(deployment.receipt.receiptId, "actual-receipt-1");
  assert.equal(active, v2.id);
  const reverted = await f.advanced.rollback(deployment.id);
  assert.equal(reverted.rollbackReceipt.receiptId, "actual-receipt-2");
  assert.equal(active, f.version.id);
  assert.equal(
    f.store.get("employees", f.employee.id).currentVersionId,
    f.version.id,
  );
  await assert.rejects(
    f.advanced.deploy({
      employeeId: f.employee.id,
      versionId: v2.id,
      target: "local",
      mode: "real",
    }),
    { code: "REAL_DEPLOYMENT_TARGET_REQUIRED" },
  );
});

test("开发集高分无法获得发布资格，真实部署读回版本不一致不能成功", async (t) => {
  const f = fixture();
  f.store.create("runs", {
    versionId: f.version.id,
    datasetId: f.dataset.id,
    status: "completed",
    metrics: { score: 100, total: 1, valid: 1, passRate: 1 },
  });
  await assert.rejects(
    f.advanced.deploy({
      employeeId: f.employee.id,
      versionId: f.version.id,
      target: "local",
    }),
    { code: "INDEPENDENT_ACCEPTANCE_REQUIRED" },
  );
  const s = await serverFixture(t, (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        receiptId: "receipt-1",
        ...(req.method === "GET" ? { versionId: "wrong" } : {}),
      }),
    );
  });
  acceptanceFixture(f, f.version.id, 40);
  f.model.request = s.request;
  await assert.rejects(
    f.advanced.deploy({
      employeeId: f.employee.id,
      versionId: f.version.id,
      target: `${s.url}/deploy`,
      mode: "real",
    }),
    { code: "DEPLOYMENT_READBACK_MISMATCH" },
  );
  assert.equal(f.store.list("deployments").at(-1).status, "uncertain");
});

test("真实发布拒绝少样本与可变用途洗白，门槛来自冻结验收快照", async () => {
  const f = fixture();
  const one = acceptanceFixture(f, f.version.id, 1);
  await assert.rejects(
    f.advanced.deploy({
      employeeId: f.employee.id,
      versionId: f.version.id,
      target: "https://example.com/deploy",
      mode: "real",
    }),
    { code: "PRODUCTION_EVIDENCE_INSUFFICIENT" },
  );
  const d = f.store.get("datasets", f.dataset.id);
  f.store.put("datasets", { ...d, purpose: "holdout" });
  const nonIndependent = f.store.create("runs", {
    ...one,
    id: undefined,
    datasetId: d.id,
    manifest: {
      ...one.manifest,
      datasetPurpose: "dev",
      generatedDataset: true,
    },
  });
  await assert.rejects(
    f.advanced.deploy({
      employeeId: f.employee.id,
      versionId: f.version.id,
      target: "local",
      mode: "simulated",
      policy: { runId: nonIndependent.id },
    }),
    { code: "INDEPENDENT_ACCEPTANCE_REQUIRED" },
  );
});

test("外部写入成功但回读失败保留持久uncertain锁，核对只GET且不重发POST", async (t) => {
  let active,
    receipt,
    requestId,
    posts = 0,
    failedReadback = true;
  const s = await serverFixture(t, (req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      posts++;
      active = body.versionId;
      receipt = "observed-receipt";
      requestId = body.requestId;
      res.end(JSON.stringify({ receiptId: receipt }));
    } else if (failedReadback) {
      res.writeHead(503);
      res.end("{}");
    } else
      res.end(
        JSON.stringify({ versionId: active, receiptId: receipt, requestId }),
      );
  });
  const f = fixture({ request: s.request }),
    candidate = f.store.create("versions", { ...f.version, id: undefined });
  acceptanceFixture(f, candidate.id, 40);
  let deploymentId;
  try {
    await f.advanced.deploy({
      employeeId: f.employee.id,
      versionId: candidate.id,
      target: `${s.url}/deploy`,
      mode: "real",
    });
  } catch (error) {
    deploymentId = error.details.deploymentId;
    assert.equal(error.details.status, "uncertain");
  }
  assert.equal(posts, 1);
  assert.equal(
    f.store.get("employees", f.employee.id).currentVersionId,
    f.version.id,
  );
  await assert.rejects(
    f.advanced.deploy({
      employeeId: f.employee.id,
      versionId: candidate.id,
      target: `${s.url}/deploy`,
      mode: "real",
    }),
    { code: "DEPLOYMENT_BUSY" },
  );
  assert.equal(posts, 1);
  failedReadback = false;
  const recovered = await f.advanced.reconcile(deploymentId);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.receipt.reconciled, true);
  assert.equal(
    f.store.get("employees", f.employee.id).currentVersionId,
    candidate.id,
  );
  assert.equal(posts, 1);
});

test("实时工具权限和只读模式收紧会阻止历史可写快照", async () => {
  const f = fixture();
  f.store.put("tools", { ...f.tool, permissions: ["read"] });
  await assert.rejects(
    f.tools.execute({
      toolId: f.tool.id,
      toolSnapshot: f.tool,
      args: { id: "42", amount: 1 },
      state: state(),
    }),
    { code: "TOOL_PERMISSION_DENIED" },
  );
  f.store.put("tools", {
    ...f.tool,
    mode: "readonly",
    permissions: ["read", "write"],
  });
  await assert.rejects(
    f.tools.execute({
      toolId: f.tool.id,
      toolSnapshot: f.tool,
      args: { id: "42", amount: 1 },
      state: state(),
    }),
    { code: "READONLY_TOOL" },
  );
});

test("Pareto组合保留权衡且剔除被支配候选，不把tokens伪称费用", () => {
  const f = fixture();
  for (const [quality, tokens, latency] of [
    [90, 200, 50],
    [90, 300, 60],
    [85, 100, 30],
  ]) {
    const version = f.store.create("versions", { ...f.version, id: undefined });
    f.store.create("runs", {
      versionId: version.id,
      datasetId: f.dataset.id,
      status: "completed",
      metrics: {
        score: quality,
        tokens,
        latencyMs: latency,
        valid: 1,
        incomplete: 0,
        violations: 0,
      },
      manifest: { evaluatorHash: "e1", datasetHash: "d1" },
    });
  }
  const result = f.advanced.recommendPortfolio(f.employee.id);
  assert.equal(result.frontier.length, 2);
  assert.equal(result.candidates.filter((c) => c.dominatedBy.length).length, 1);
  assert.equal(result.costBasis, "tokens");
  assert.ok(result.recommendation);
});

test("经验复用只迁移白名单字段，需源审核和目标审批，原始轨迹不迁移", () => {
  const f = fixture();
  const original = f.store.create("experiences", {
    name: "经验",
    summary: "退款前查询订单状态",
    tags: ["refund"],
    approved: true,
    visibility: "shared",
    rawTrace: "客户秘密",
    sourceRunId: "sensitive-id",
  });
  assert.throws(
    () => f.advanced.importExperience(original.id, "target", null),
    { code: "EXPERIENCE_TRANSFER_APPROVAL" },
  );
  const imported = f.advanced.importExperience(original.id, "target", {
    approved: true,
    sourceWorkspace: "default",
    targetWorkspace: "target",
  });
  assert.equal(imported.approved, false);
  assert.equal(imported.rawTrace, undefined);
  assert.equal(imported.sourceRunId, undefined);
  assert.equal(imported.summary, original.summary);
  const knowledge = f.store.get("knowledge", imported.knowledgeId, "target");
  assert.equal(knowledge.content, original.summary);
  assert.equal(knowledge.allowedModelEgress, false);
  assert.equal(knowledge.status, "draft");
});

test("长期记忆按员工scope与时间过期隔离，候选不进入生产记忆", async () => {
  const seen = [];
  const f = fixture({
    complete: async (input) => {
      if (input.scene === "evaluation.memory_judge")
        return {
          value: {
            score: 90,
            passed: true,
            reason: "未使用过期或其他scope记忆",
          },
          usage: { totalTokens: 10 },
          receipt: { id: "judge" },
        };
      seen.push(JSON.parse(input.messages[1].content));
      return {
        value: {
          answer: "完成",
          memoryCandidates:
            seen.length === 1 ? [{ content: "临时偏好", ttlSeconds: 1 }] : [],
        },
        usage: { totalTokens: 10 },
        receipt: { id: `step-${seen.length}` },
      };
    },
  });
  f.store.create("memories", {
    employeeId: f.employee.id,
    scope: "other",
    content: "不能泄漏",
    approved: true,
  });
  f.store.create("memories", {
    employeeId: f.employee.id,
    scope: "scenario",
    content: "过期事实",
    approved: true,
    expiresAt: "2025-01-01T00:00:00Z",
  });
  const result = await f.advanced.executeJob(
    {
      type: "long_horizon",
      payload: {
        versionId: f.version.id,
        scope: "scenario",
        inputs: [
          { input: "记住偏好", at: "2026-11-04T00:00:00Z" },
          { input: "查询", at: "2026-11-04T00:00:03Z" },
        ],
      },
    },
    ctx(),
  );
  assert.deepEqual(seen[0].memories, []);
  assert.deepEqual(seen[1].memories, []);
  assert.equal(result.productionMemoryUpdated, false);
  assert.ok(result.runId && result.reportId);
  assert.equal(
    f.store.get("memories", result.candidateMemoryIds[0]).approved,
    false,
  );
});

test("长期记忆模型异常保留不完整run和report，缺失用例不计成功", async () => {
  const f = fixture({
    complete: async () => {
      throw Object.assign(new Error("提供方异常"), { code: "PROVIDER_FAILED" });
    },
  });
  const result = await f.advanced.executeJob(
    {
      type: "long_horizon",
      payload: { versionId: f.version.id, inputs: ["第一步", "第二步"] },
    },
    ctx(),
  );
  assert.equal(result.incomplete, true);
  assert.equal(result.metrics.total, 2);
  assert.equal(result.metrics.valid, 0);
  assert.equal(result.metrics.passRate, 0);
  assert.equal(f.store.get("runs", result.runId).status, "incomplete");
  assert.ok(result.reportId);
});

test("长期记忆worker与judge共享冻结岗位知识技能，默认预算继承根任务而非32k截断", async () => {
  const requests = [];
  const f = fixture({
    complete: async (input) => {
      requests.push(input);
      if (input.scene === "evaluation.memory_judge")
        return {
          value: {
            score: 95,
            passed: true,
            reason: "500元规则来自同一授权岗位知识，不是编造",
          },
          usage: { totalTokens: 5000 },
          receipt: { id: "judge-same-context" },
        };
      return {
        value: { answer: "超过500元需要主管审批", memoryCandidates: [] },
        usage: { totalTokens: 20000 },
        receipt: { id: "worker-same-context" },
      };
    },
  });
  const version = f.store.create("versions", {
    ...f.version,
    id: undefined,
    prompt: "你是售后专员，500元以上需主管审批。",
    policy: { approvalLimit: 500 },
    manifest: {
      snapshots: {
        model: { id: "model-1" },
        knowledge: [
          {
            id: "policy-kb",
            name: "已授权政策",
            content: "退款超过500元须主管批准",
            source: "approved-policy",
            revision: 2,
          },
        ],
        skills: [
          {
            id: "frozen-skill",
            name: "核验流程",
            content: "先查询状态再处理",
            steps: [],
            revision: 3,
          },
        ],
      },
    },
  });
  const result = await f.advanced.executeJob(
    {
      type: "long_horizon",
      budgetTokens: 60000,
      payload: {
        versionId: version.id,
        inputs: ["600元退款如何处理？", "请再次说明规则。"],
      },
    },
    ctx(),
  );
  assert.equal(result.incomplete, false);
  assert.equal(result.totalTokens, 50000);
  assert.deepEqual(
    requests.map((r) => r.budgetTokens),
    [60000, 40000, 35000, 15000],
  );
  const workerContext = JSON.parse(
    requests[0].messages[1].content,
  ).authorizedContext;
  const judgeContext = JSON.parse(
    requests[1].messages[1].content,
  ).authorizedContext;
  assert.deepEqual(judgeContext, workerContext);
  assert.equal(judgeContext.prompt, version.prompt);
  assert.equal(judgeContext.knowledge[0].content, "退款超过500元须主管批准");
  assert.equal(judgeContext.skills[0].content, "先查询状态再处理");
});

test("技能修复不能借开发集参数读取holdout失败反馈", async () => {
  const f = fixture({
    complete: async () => {
      assert.fail("不应向模型泄漏holdout");
    },
  });
  const holdout = f.store.create("datasets", { purpose: "holdout" });
  const source = f.store.create("runs", {
    versionId: f.version.id,
    datasetId: holdout.id,
    caseResults: [{ input: "封存题", output: "封存结果" }],
  });
  await assert.rejects(
    f.advanced.executeJob(
      {
        type: "skill_repair",
        payload: {
          versionId: f.version.id,
          skillId: f.skill.id,
          datasetId: f.dataset.id,
          runId: source.id,
        },
      },
      ctx(),
    ),
    { code: "DATASET_PURPOSE_DENIED" },
  );
});

test("技能修复生成实质声明式候选并评测，越权工具ID被拒绝", async () => {
  const f = fixture();
  f.model.complete = async () => ({
    value: {
      content: "先核对身份与金额，再退款并核验回执",
      reason: "补充退款验证",
      steps: [
        {
          toolId: f.tool.id,
          argsTemplate: { id: "{{order.id}}", amount: "{{order.amount}}" },
          onError: "stop",
        },
      ],
    },
    usage: { totalTokens: 20 },
    receipt: { id: "skill-patch" },
  });
  const result = await f.advanced.executeJob(
    {
      type: "skill_repair",
      payload: {
        versionId: f.version.id,
        skillId: f.skill.id,
        datasetId: f.dataset.id,
      },
    },
    ctx(),
  );
  assert.notEqual(result.candidateVersionId, f.version.id);
  assert.ok(result.runId);
  assert.equal(result.promoted, false);
  assert.equal(f.store.get("skills", f.skill.id).version, 1);
  f.model.complete = async () => ({
    value: {
      content: "越权",
      reason: "bad",
      steps: [{ toolId: "unbound-tool", argsTemplate: {} }],
    },
  });
  await assert.rejects(
    f.advanced.executeJob(
      {
        type: "skill_repair",
        payload: {
          versionId: f.version.id,
          skillId: f.skill.id,
          datasetId: f.dataset.id,
        },
      },
      ctx(),
    ),
    { code: "SKILL_TOOL_ESCALATION" },
  );
});

test("影子输入回放只用仿真工具，真实生产工具绑定会被拒绝", async () => {
  const f = fixture();
  const result = await f.advanced.executeJob(
    {
      type: "shadow_evaluate",
      payload: {
        versionId: f.version.id,
        inputs: [{ input: "订单查询", expected: "应先核验" }],
      },
    },
    ctx(),
  );
  assert.equal(result.productionEffects, false);
  const bad = f.store.create("tools", {
    adapter: "http",
    operation: "read",
    mode: "production",
  });
  const v2 = f.store.create("versions", {
    ...f.version,
    id: undefined,
    toolIds: [bad.id],
  });
  await assert.rejects(
    f.advanced.shadow({ versionId: v2.id, datasetId: f.dataset.id }),
    { code: "SHADOW_WRITE_ISOLATION" },
  );
});

test("schema边界与原型污染输入被拒绝", () => {
  assert.throws(
    () =>
      assertSchema(
        { value: "" },
        {
          type: "object",
          properties: { value: { type: "string", minLength: 1 } },
        },
      ),
    { code: "TOOL_SCHEMA" },
  );
  assert.throws(
    () =>
      assertSchema(JSON.parse('{"__proto__":{"polluted":true}}'), {
        type: "object",
      }),
    { code: "TOOL_SCHEMA" },
  );
  assert.equal({}.polluted, undefined);
  assert.throws(() => assertSchema("xx", { type: "string", pattern: "^x+$" }), {
    code: "SCHEMA_KEYWORD_UNSUPPORTED",
  });
  assert.throws(
    () => assertSchema(4, { oneOf: [{ type: "number" }, { type: "integer" }] }),
    { code: "TOOL_SCHEMA" },
  );
  assert.throws(
    () => assertSchema("not a URL", { type: "string", format: "uri" }),
    { code: "TOOL_SCHEMA" },
  );
});

test("知识发布回归只刷新目标知识，保留工具模型快照并保存父子配对报告", async (t) => {
  const f = frozenFixture(t),
    dataset = f.dataset("dev");
  await f.engine.executeJob(
    {
      type: "evaluate",
      payload: { versionId: f.version.id, datasetId: dataset.id },
    },
    ctx(),
  );
  const refreshed = f.store.put("knowledge", {
    ...f.knowledge,
    content: "新政策上限200元",
  });
  f.store.put("tools", {
    ...f.tool,
    operation: "delete",
    description: "这段实时漂移不可夹带",
  });
  f.store.put("models", { ...f.defaultModel, model: "live-drift-model" });
  const result = await f.advanced.executeJob(
    {
      type: "knowledge_regression",
      budgetTokens: 200000,
      payload: { knowledgeId: refreshed.id },
    },
    ctx(),
  );
  assert.equal(result.gaps.length, 0);
  assert.equal(result.results[0].status, "evaluated");
  const record = result.results[0],
    candidate = f.store.get("versions", record.candidateVersionId);
  assert.equal(
    candidate.manifest.snapshots.knowledge[0].content,
    "新政策上限200元",
  );
  assert.deepEqual(
    candidate.manifest.snapshots.tools,
    f.version.manifest.snapshots.tools,
  );
  assert.deepEqual(
    candidate.manifest.snapshots.model,
    f.version.manifest.snapshots.model,
  );
  assert.deepEqual(
    candidate.manifest.snapshots.skills,
    f.version.manifest.snapshots.skills,
  );
  assert.equal(
    f.store.get("employees", f.employee.id).currentVersionId,
    f.version.id,
  );
  assert.equal(record.comparison.comparable, true);
  assert.equal(record.comparison.improved.length, 1);
  assert.equal(
    f.store.get("reports", record.reportId).comparison.comparable,
    true,
  );
  assert.equal(result.promoted, false);
});

test("知识回归没有已有测试集时显式记录gap，候选不冒充已评测或已部署", async (t) => {
  const f = frozenFixture(t);
  f.store.put("knowledge", { ...f.knowledge, content: "新政策上限200元" });
  const result = await f.advanced.executeJob(
    { type: "knowledge_regression", payload: { knowledgeId: f.knowledge.id } },
    ctx(),
  );
  assert.equal(result.gaps[0].code, "NO_REGRESSION_DATASET");
  assert.ok(result.gaps[0].candidateVersionId);
  assert.equal(result.results[0].status, "gap");
  assert.equal(f.modelCalls, 0);
  assert.equal(f.store.list("runs").length, 0);
  assert.equal(
    f.store.get("employees", f.employee.id).currentVersionId,
    f.version.id,
  );
});

test("知识自动回归的排队修订已过期时不把后续内容冒充原发布版本", async (t) => {
  const f = frozenFixture(t),
    before = f.store.list("versions").length;
  f.store.put("knowledge", { ...f.knowledge, content: "新政策上限200元" });
  await assert.rejects(
    f.advanced.executeJob(
      {
        type: "knowledge_regression",
        payload: {
          knowledgeId: f.knowledge.id,
          sourceRevision: f.knowledge.revision,
        },
      },
      ctx(),
    ),
    { code: "KNOWLEDGE_REVISION_CHANGED" },
  );
  assert.equal(f.store.list("versions").length, before);
  assert.equal(f.modelCalls, 0);
});

test("真实HTTP训练成功回执可注册冻结模型候选，保留提交基线且不改变默认模型", async (t) => {
  const service = await serverFixture(t, (req, res) => {
    assert.equal(req.method, "POST");
    res.setHeader("content-type", "application/json");
    res.end(
      '{"id":"training-adoption-receipt","status":"succeeded","resultModel":"actual-trained-model"}',
    );
  });
  const f = frozenFixture(t),
    dataset = f.dataset("train");
  f.model.request = service.request;
  const provider = f.store.create("models", {
    name: "训练适配连接",
    provider: "http-training",
    model: "provider-base",
    baseUrl: "https://inference.example.test/v1",
    secretRef: "training-session",
    contextTokens: 100000,
    maxOutputTokens: 20000,
    training: {
      endpoint: `${service.url}/training`,
      protocol: "workloom-async-v1",
    },
  });
  const submitted = await f.advanced.executeJob(
    {
      type: "fine_tune",
      payload: {
        employeeId: f.employee.id,
        datasetId: dataset.id,
        providerModelId: provider.id,
      },
    },
    ctx(),
  );
  assert.equal(submitted.status, "succeeded");
  f.store.put("models", {
    ...provider,
    baseUrl: "https://unrelated-live-drift.example.test",
    model: "unrelated-live-base",
  });
  f.store.put("knowledge", { ...f.knowledge, content: "新政策上限200元" });
  const originalDefault = f.store.get("models", f.defaultModel.id);
  const result = f.advanced.createTrainedVersion(submitted.trainingId);
  const adoptedModel = f.store.get("models", result.modelId),
    candidate = f.store.get("versions", result.candidateVersionId);
  assert.equal(adoptedModel.model, "actual-trained-model");
  assert.equal(adoptedModel.baseUrl, "https://inference.example.test/v1");
  assert.equal(adoptedModel.secretRef, "training-session");
  assert.equal(adoptedModel.default, false);
  assert.equal(candidate.parentId, f.version.id);
  assert.deepEqual(
    candidate.manifest.snapshots.knowledge,
    f.version.manifest.snapshots.knowledge,
  );
  assert.deepEqual(
    candidate.manifest.snapshots.tools,
    f.version.manifest.snapshots.tools,
  );
  assert.deepEqual(f.store.get("models", f.defaultModel.id), originalDefault);
  assert.equal(
    f.store.get("employees", f.employee.id).currentVersionId,
    f.version.id,
  );
  const count = f.store.list("models").length;
  assert.equal(
    f.advanced.createTrainedVersion(submitted.trainingId).candidateVersionId,
    candidate.id,
  );
  assert.equal(f.store.list("models").length, count);
});

test("训练未成功或回执不匹配时拒绝生成权重版本，不创建占位模型", async () => {
  const f = fixture();
  const training = f.store.create("training", {
    employeeId: f.employee.id,
    status: "running",
    externalJobId: "provider-job",
    resultModel: null,
    providerReceipt: { id: "provider-job", status: "running" },
  });
  const before = f.store.list("models").length;
  assert.throws(() => f.advanced.createTrainedVersion(training.id), {
    code: "TRAINING_NOT_SUCCEEDED",
  });
  f.store.put("training", {
    ...training,
    status: "succeeded",
    resultModel: "model-name",
    providerReceipt: { id: "wrong-job", status: "succeeded" },
  });
  assert.throws(() => f.advanced.createTrainedVersion(training.id), {
    code: "TRAINING_NOT_SUCCEEDED",
  });
  assert.equal(f.store.list("models").length, before);
});
