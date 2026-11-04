import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createStore } from "../server/store.mjs";
import { createToolService } from "../server/tools.mjs";
import {
  createEngine,
  evaluateAssertions,
  compareRuns,
  wilsonInterval,
} from "../server/engine.mjs";

const workspace = "test-workspace";
const returned = (value, extra = {}) => ({
  content: typeof value === "string" ? value : JSON.stringify(value),
  value: typeof value === "string" ? undefined : value,
  usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  receipt: { id: "stub-receipt", mode: "explicit-test-stub" },
  ...extra,
});
const toolCall = (request, name, args) => {
  const definition = request.tools.find(
    (item) => item.function.description === name || item.function.name === name,
  );
  assert.ok(definition, `Expected tool ${name}`);
  const call = {
    id: "call-1",
    type: "function",
    function: {
      name: definition.function.name,
      arguments: JSON.stringify(args),
    },
  };
  return returned("", {
    toolCalls: [call],
    message: {
      role: "assistant",
      content: "",
      reasoning_content: "TRANSIENT-REASONING-ONLY",
      tool_calls: [call],
    },
  });
};

function fixture(t, handler = () => null, databasePath = ":memory:") {
  const store = createStore(databasePath);
  t.after(() => {
    if (store.db.isOpen) store.close();
  });
  const requests = [];
  const model = {
    complete: async (request) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const custom = await handler(request, requests);
      if (custom) return custom;
      if (request.scene === "evaluation.judge")
        return returned({
          score: 90,
          passed: true,
          reason: "测试裁判：已依据任务证据评分",
          confidence: "high",
          issues: [],
        });
      if (request.scene === "employee.execute") return returned("任务已完成");
      throw new Error(`Test stub has no response for ${request.scene}`);
    },
  };
  const tools = createToolService({ store, model });
  const engine = createEngine({ store, model, tools });
  const modelRecord = store.create(
    "models",
    {
      name: "Explicit unit test model",
      model: "unit-test-only",
      provider: "test",
      secretRef: "test-key",
      contextTokens: 1000000,
      maxOutputTokens: 10000,
    },
    workspace,
  );
  const knowledge = store.create(
    "knowledge",
    {
      name: "政策",
      content: "原始规则：必须核验订单。",
      source: "test",
      allowedModelEgress: true,
    },
    workspace,
  );
  const tool = store.create(
    "tools",
    {
      name: "refund_order",
      description: "refund_order",
      adapter: "simulation",
      mode: "simulated",
      operation: "refund",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" }, amount: { type: "number" } },
        required: ["orderId", "amount"],
      },
    },
    workspace,
  );
  const employee = store.create(
    "employees",
    { name: "售后专员", role: "客服", accessMode: "managed" },
    workspace,
  );
  const version = engine.createVersion(
    employee.id,
    {
      modelId: modelRecord.id,
      prompt: "baseline 工作要求",
      knowledgeIds: [knowledge.id],
      toolIds: [tool.id],
      policy: { maxSteps: 4, allowWrites: true, approvalLimit: 500 },
    },
    workspace,
  );
  store.put(
    "employees",
    { ...employee, currentVersionId: version.id },
    workspace,
  );
  function dataset(overrides = {}, caseOverrides = {}) {
    let set = store.create(
      "datasets",
      { name: "测试集", purpose: "dev", caseIds: [], ...overrides },
      workspace,
    );
    const scenario = store.create(
      "cases",
      {
        datasetId: set.id,
        name: "标准任务",
        input: "请退款订单 A 的 100 元",
        expected: "核验并完成退款",
        category: "normal",
        initialState: { orders: [{ id: "A", amount: 100, status: "paid" }] },
        assertions: [{ type: "no_violation" }],
        ...caseOverrides,
      },
      workspace,
    );
    set = store.put("datasets", { ...set, caseIds: [scenario.id] }, workspace);
    return { dataset: set, scenario };
  }
  function run(type, payload, extra = {}) {
    return engine.executeJob(
      {
        id: "test-job",
        type,
        workspace,
        payload,
        budgetTokens: 100000,
        ...extra,
      },
      { workspace, jobId: "test-job", ...extra.ctx },
    );
  }
  return {
    store,
    model,
    tools,
    engine,
    modelRecord,
    knowledge,
    tool,
    employee,
    version,
    dataset,
    run,
    requests,
  };
}

test("version manifest freezes source content and cannot cross workspace boundaries", (t) => {
  const f = fixture(t);
  const digest = f.version.manifestHash;
  f.store.put("knowledge", { ...f.knowledge, content: "新规则" }, workspace);
  const saved = f.store.get("versions", f.version.id, workspace);
  assert.equal(saved.manifestHash, digest);
  assert.equal(
    saved.manifest.snapshots.knowledge[0].content,
    "原始规则：必须核验订单。",
  );
  assert.equal(saved.manifest.snapshots.knowledge[0].sourceRevision, 1);
  assert.throws(() => f.store.put("versions", saved, workspace), /不可修改/);
  const foreign = f.store.create(
    "knowledge",
    { name: "other", content: "private" },
    "other-workspace",
  );
  assert.throws(
    () =>
      f.engine.createVersion(
        f.employee.id,
        {
          modelId: f.modelRecord.id,
          prompt: "test",
          knowledgeIds: [foreign.id],
        },
        workspace,
      ),
    /无权访问/,
  );
});

test("natural-language employee creation is atomic and rejects invented asset identifiers", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.create"
      ? returned({
          name: "新员工",
          role: "售后",
          prompt: "明确职责",
          knowledgeIds: ["invented-id"],
          toolIds: [],
          skillIds: [],
          skills: [],
          gaps: [],
          cases: [{ name: "测试", input: "你好", expected: "回复" }],
        })
      : null,
  );
  await assert.rejects(
    f.run("create_employee", {
      requirements: "创建售后专员",
      modelId: f.modelRecord.id,
    }),
    { code: "UNAUTHORIZED_GENERATED_ASSET" },
  );
  assert.equal(f.store.list("employees", workspace).length, 1);
  assert.equal(f.store.list("datasets", workspace).length, 0);
});

test("natural-language creation builds an initial version, reusable skill and explicitly developmental cases", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.create"
      ? returned({
          name: "新员工",
          role: "售后",
          description: "处理咨询",
          prompt: "遵循售后流程",
          knowledgeIds: [],
          toolIds: [],
          skillIds: [],
          skills: [
            {
              name: "澄清",
              steps: ["核验信息", "解释规则"],
              content: "先澄清再处理",
            },
          ],
          policy: { maxSteps: 3, allowWrites: false },
          gaps: ["生产订单系统尚未接通"],
          cases: [
            {
              name: "咨询",
              input: "如何退款",
              expected: "说明需核验订单",
              assertions: [],
            },
          ],
        })
      : null,
  );
  const result = await f.run("create_employee", {
    requirements: "我需要一名售后客服",
    modelId: f.modelRecord.id,
    autoEvaluate: true,
  });
  const version = f.store.get("versions", result.versionId, workspace);
  assert.equal(version.label, "V0.1");
  assert.equal(version.skillIds.length, 1);
  const set = f.store.get("datasets", result.datasetId, workspace);
  assert.equal(set.purpose, "dev");
  assert.equal(set.generated, true);
  const report = f.store.get("reports", result.baseline.reportId, workspace);
  assert.equal(report.recommendation, "continue_validation");
  assert.ok(report.limitations.some((item) => item.includes("自动生成")));
  assert.equal(
    f.store.get("employees", result.employeeId, workspace).status,
    "draft",
  );
});

test("a plausible final message cannot replace the required business state change", async (t) => {
  const f = fixture(t);
  const { dataset } = f.dataset(
    {},
    {
      assertions: [
        { type: "state", path: "orders.0.status", value: "refunded" },
      ],
    },
  );
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.caseResults[0].judge.score, 90);
  assert.equal(run.caseResults[0].passed, false);
  assert.equal(run.caseResults[0].assertions[0].actual, "paid");
  assert.equal(run.metrics.passRate, 0);
});

test("real tool-loop protocol preserves reasoning transiently, resets state each repeat and persists safe evidence", async (t) => {
  const f = fixture(t, (request) => {
    if (request.scene !== "employee.execute") return null;
    if (request.messages.at(-1).role !== "tool")
      return toolCall(request, "refund_order", { orderId: "A", amount: 100 });
    assert.equal(
      request.messages.at(-2).reasoning_content,
      "TRANSIENT-REASONING-ONLY",
    );
    return returned("退款完成，订单 A 已退款100元");
  });
  const { dataset } = f.dataset(
    {},
    {
      assertions: [
        { type: "state", path: "orders.0.status", value: "refunded" },
        { type: "tool_called", value: "refund_order" },
      ],
    },
  );
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
    repeats: 2,
  });
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.metrics.passed, 2);
  assert.equal(run.metrics.uniqueCases, 1);
  assert.equal(run.metrics.stableCases, 1);
  assert.equal(run.metrics.total, 2);
  assert.ok(!JSON.stringify(run).includes("TRANSIENT-REASONING-ONLY"));
  assert.equal(
    run.caseResults[0].steps.find((step) => step.type === "tool").receipt
      .adapter,
    "simulation",
  );
  assert.equal(run.caseResults[1].finalState.orders[0].refundedAmount, 100);
  assert.ok(f.store.verifyEvents(workspace));
});

test("server-side role policy blocks write tools even if the model chooses to call them", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.execute" &&
    request.messages.at(-1).role !== "tool"
      ? toolCall(request, "refund_order", { orderId: "A", amount: 100 })
      : null,
  );
  const version = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id, policy: { maxSteps: 4, allowWrites: false } },
    workspace,
  );
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: version.id,
    datasetId: dataset.id,
  });
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.metrics.violations, 1);
  assert.equal(run.metrics.passed, 0);
  assert.equal(run.caseResults[0].finalState.orders[0].status, "paid");
  assert.equal(run.caseResults[0].violations[0].code, "WRITE_NOT_ALLOWED");
});

test("refund amounts above approval limit are denied independently of natural-language instructions", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.execute" &&
    request.messages.at(-1).role !== "tool"
      ? toolCall(request, "refund_order", { orderId: "A", amount: 800 })
      : null,
  );
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(
    run.caseResults[0].violations[0].code,
    "APPROVAL_LIMIT_EXCEEDED",
  );
  assert.equal(run.caseResults[0].finalState.orders[0].status, "paid");
});

test("judge schema failure produces an incomplete report instead of a passing score", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "evaluation.judge"
      ? returned({ score: "100", passed: true })
      : null,
  );
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.status, "incomplete");
  assert.equal(run.metrics.valid, 0);
  assert.equal(
    f.store.get("reports", result.reportId, workspace).recommendation,
    "incomplete",
  );
});

test("provider failure after a tool side effect preserves intermediate receipts and state", async (t) => {
  const f = fixture(t, (request) => {
    if (request.scene !== "employee.execute") return null;
    if (request.messages.at(-1).role !== "tool")
      return toolCall(request, "refund_order", { orderId: "A", amount: 100 });
    throw Object.assign(new Error("test provider unavailable"), {
      code: "PROVIDER_UNAVAILABLE",
      status: 503,
    });
  });
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.caseResults[0].status, "error");
  assert.equal(run.caseResults[0].finalState.orders[0].status, "refunded");
  assert.equal(
    run.caseResults[0].steps.filter((step) => step.type === "tool").length,
    1,
  );
});

test("budget exhaustion stops subsequent cases and never labels excluded tasks as successful", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.execute"
      ? returned("result", { usage: { totalTokens: 150 } })
      : null,
  );
  let { dataset, scenario } = f.dataset();
  const second = f.store.create(
    "cases",
    { ...scenario, id: undefined, name: "second" },
    workspace,
  );
  dataset = f.store.put(
    "datasets",
    { ...dataset, caseIds: [...dataset.caseIds, second.id] },
    workspace,
  );
  const result = await f.run(
    "evaluate",
    { versionId: f.version.id, datasetId: dataset.id },
    { budgetTokens: 100 },
  );
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.metrics.total, 2);
  assert.equal(run.metrics.passed, 0);
  assert.equal(run.metrics.incomplete, 2);
  assert.equal(run.caseResults[1].status, "budget_exhausted");
  assert.equal(f.requests.length, 1);
});

test("cancel after execution persists the planned denominator and stops remaining dispatch", async (t) => {
  const controller = new AbortController();
  const f = fixture(t, (request) => {
    if (request.scene === "employee.execute") {
      controller.abort();
      return returned("result");
    }
    return null;
  });
  const { dataset } = f.dataset();
  const result = await f.run(
    "evaluate",
    { versionId: f.version.id, datasetId: dataset.id, repeats: 2 },
    { ctx: { signal: controller.signal } },
  );
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.status, "cancelled");
  assert.equal(run.metrics.total, 2);
  assert.equal(f.requests.length, 1);
});

test("optimizer cannot read holdout or hidden cases", async (t) => {
  const f = fixture(t);
  const { dataset } = f.dataset({ purpose: "holdout" }, { hidden: true });
  await assert.rejects(
    f.run("optimize", { versionId: f.version.id, datasetId: dataset.id }),
    { code: "HOLDOUT_LEAK_PREVENTED" },
  );
  assert.equal(f.requests.length, 0);
});

test("optimizer rejects changes to evaluator, permissions or model and keeps its failed task evidence", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "optimization.patch"
      ? returned({
          prompt: "changed",
          policy: { allowWrites: true },
          rationale: "bad patch",
        })
      : null,
  );
  const { dataset } = f.dataset();
  await assert.rejects(
    f.run("optimize", {
      versionId: f.version.id,
      datasetId: dataset.id,
      maxRounds: 1,
      candidatesPerRound: 1,
    }),
    { code: "PATCH_SCOPE_VIOLATION" },
  );
  const task = f.store.list("optimizations", workspace)[0];
  assert.equal(task.status, "failed");
  assert.equal(task.bestVersionId, f.version.id);
  assert.equal(f.store.list("versions", workspace).length, 1);
});

test("optimization creates evaluated candidates and recommendations without overwriting the employee pointer", async (t) => {
  let f;
  f = fixture(t, (request) => {
    if (request.scene === "employee.execute")
      return returned(
        request.messages[0].content.startsWith("improved")
          ? "改进后的正确结果"
          : "旧结果",
      );
    if (request.scene === "evaluation.judge") {
      const evidence = JSON.parse(request.messages[1].content);
      const improved = evidence.output.includes("正确");
      return returned({
        score: improved ? 96 : 60,
        passed: improved,
        reason: improved ? "符合目标" : "缺少必要步骤",
        confidence: "high",
        issues: [],
      });
    }
    if (request.scene === "optimization.patch") {
      f.store.put(
        "knowledge",
        {
          ...f.store.get("knowledge", f.knowledge.id, workspace),
          content: "不应悄悄采用的新政策",
        },
        workspace,
      );
      return returned({
        prompt: "improved 泛化方法：先核验再完成任务",
        skillOverrides: [],
        rationale: "补充核验步骤",
        hypothesis: "核验可减少遗漏",
        risks: [],
      });
    }
    return null;
  });
  const { dataset } = f.dataset();
  const result = await f.run("optimize", {
    versionId: f.version.id,
    datasetId: dataset.id,
    maxRounds: 1,
    candidatesPerRound: 1,
  });
  assert.notEqual(result.bestVersionId, f.version.id);
  const record = f.store.list("optimizations", workspace)[0];
  assert.equal(record.candidates[0].accepted, true);
  assert.equal(record.candidates[0].comparison.improved.length, 1);
  const candidate = f.store.get("versions", result.bestVersionId, workspace);
  assert.equal(
    candidate.manifest.snapshots.knowledge[0].content,
    f.version.manifest.snapshots.knowledge[0].content,
  );
  assert.equal(
    f.store.get("employees", f.employee.id, workspace).currentVersionId,
    f.version.id,
  );
  assert.equal(
    record.recommendation,
    "candidate_requires_independent_validation",
  );
});

test("revoked assets remain inaccessible even through a frozen version", async (t) => {
  const f = fixture(t);
  f.store.put("knowledge", { ...f.knowledge, status: "revoked" }, workspace);
  const { dataset } = f.dataset();
  await assert.rejects(
    f.run("evaluate", { versionId: f.version.id, datasetId: dataset.id }),
    { code: "ASSET_REVOKED" },
  );
  assert.equal(f.requests.length, 0);
});

test("revoked model flags and status deny old frozen versions before any provider request", async (t) => {
  for (const change of [
    { revoked: true },
    { status: "revoked" },
    { status: "disabled" },
    { permissions: { enabled: false } },
    { permissions: { denied: true } },
  ]) {
    const f = fixture(t);
    const { dataset } = f.dataset();
    f.store.put("models", { ...f.modelRecord, ...change }, workspace);
    await assert.rejects(
      f.run("evaluate", { versionId: f.version.id, datasetId: dataset.id }),
      {
        code: change.permissions ? "MODEL_PERMISSION_DENIED" : "MODEL_REVOKED",
        status: 403,
      },
    );
    assert.equal(f.requests.length, 0);
  }
});

test("employee generation and in-flight follow-up calls honor model revocation", async (t) => {
  const f = fixture(t, (request) => {
    if (request.scene !== "employee.execute") return null;
    const response = toolCall(request, "refund_order", {
      orderId: "A",
      amount: 100,
    });
    f.store.put("models", { ...f.modelRecord, status: "revoked" }, workspace);
    return response;
  });
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.store.get("runs", result.runId, workspace).caseResults[0].error.code,
    "MODEL_REVOKED",
  );
  const before = f.requests.length;
  await assert.rejects(
    f.run("create_employee", {
      requirements: "创建一个售后专员",
      modelId: f.modelRecord.id,
    }),
    { code: "MODEL_REVOKED", status: 403 },
  );
  assert.equal(f.requests.length, before);
});

test("shared deployment validation honors current model permissions on frozen versions", (t) => {
  const f = fixture(t);
  const validation = f.engine.validateVersion(f.version.id, workspace);
  assert.equal(validation.valid, true);
  assert.equal(validation.manifestHash, f.version.manifestHash);
  f.store.put(
    "models",
    { ...f.modelRecord, permissions: { enabled: false } },
    workspace,
  );
  assert.throws(() => f.engine.validateVersion(f.version.id, workspace), {
    code: "MODEL_PERMISSION_DENIED",
    status: 403,
  });
  assert.equal(f.requests.length, 0);
});

test("disabled model or tool also blocks shared pre-deployment validation", (t) => {
  const f = fixture(t);
  f.store.put("models", { ...f.modelRecord, status: "disabled" }, workspace);
  assert.throws(() => f.engine.validateVersion(f.version.id, workspace), {
    code: "MODEL_REVOKED",
    status: 403,
  });
  f.store.put(
    "models",
    {
      ...f.store.get("models", f.modelRecord.id, workspace),
      status: "configured",
    },
    workspace,
  );
  f.store.put("tools", { ...f.tool, status: "disabled" }, workspace);
  assert.throws(() => f.engine.validateVersion(f.version.id, workspace), {
    code: "ASSET_REVOKED",
    status: 403,
  });
  assert.equal(f.requests.length, 0);
});

test("creation receives public tool schemas and simulation resource without credentials, endpoints or customer fixtures", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.create"
      ? returned({
          name: "契约员工",
          role: "售后",
          prompt: "遵循契约",
          knowledgeIds: [],
          toolIds: [],
          skillIds: [],
          skills: [],
          gaps: [],
          cases: [
            {
              name: "测试",
              input: "查询订单",
              expected: "先询问必要信息",
              assertions: [],
            },
          ],
        })
      : null,
  );
  const currentTool = f.store.put(
    "tools",
    {
      ...f.tool,
      secretRef: "private-tool-secret-reference",
      endpoint: "https://private-business-endpoint.invalid",
      config: {
        resource: "orders",
        url: "https://private-business-endpoint.invalid",
        testArgs: { customerName: "Private-Customer-Example" },
        testState: { customerEmail: "private-customer@example.invalid" },
      },
      inputSchema: {
        type: "object",
        properties: {
          orderId: { type: "string", default: "Private-Customer-Order" },
          amount: { type: "number", minimum: 0.01 },
        },
        required: ["orderId", "amount"],
        examples: [{ orderId: "Private-Customer-Order", amount: 123 }],
      },
      outputSchema: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string" } },
      },
    },
    workspace,
  );
  await f.run("create_employee", {
    requirements: "根据已选工具创建售后员工",
    modelId: f.modelRecord.id,
    toolIds: [currentTool.id],
  });
  const request = f.requests.find((item) => item.scene === "employee.create");
  const catalogue = JSON.parse(request.messages[1].content).assets;
  assert.equal(catalogue.tools.length, 1);
  assert.equal(catalogue.tools[0].inputSchema.properties.amount.minimum, 0.01);
  assert.deepEqual(catalogue.tools[0].inputSchema.required, [
    "orderId",
    "amount",
  ]);
  assert.deepEqual(catalogue.tools[0].outputSchema.required, ["status"]);
  assert.equal(catalogue.tools[0].config.resource, "orders");
  assert.ok(!JSON.stringify(catalogue).includes("secretRef"));
  assert.ok(!JSON.stringify(catalogue).includes("private-business-endpoint"));
  assert.ok(!JSON.stringify(catalogue).includes("Private-Customer"));
  assert.ok(
    !JSON.stringify(catalogue).includes("private-customer@example.invalid"),
  );
});

test("automatic creation does not silently adopt draft knowledge, disabled or unauthorized assets", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.create"
      ? returned({
          name: "过滤员工",
          role: "售后",
          prompt: "遵循授权资料",
          knowledgeIds: [],
          toolIds: [],
          skillIds: [],
          skills: [],
          gaps: ["草案资料需要先审核发布"],
          cases: [
            { name: "测试", input: "咨询规则", expected: "缺少依据时澄清" },
          ],
        })
      : null,
  );
  const published = f.store.put(
    "knowledge",
    { ...f.knowledge, published: true, status: "published" },
    workspace,
  );
  const draft = f.store.create(
    "knowledge",
    {
      name: "草案知识",
      content: "不可自动采纳",
      status: "draft",
      published: false,
      allowedModelEgress: true,
    },
    workspace,
  );
  const noEgress = f.store.create(
    "knowledge",
    {
      name: "禁止出域知识",
      content: "不允许发送给该模型",
      status: "published",
      published: true,
      allowedModelEgress: false,
    },
    workspace,
  );
  const disabled = f.store.create(
    "tools",
    {
      name: "停用工具",
      adapter: "simulation",
      operation: "read",
      status: "disabled",
    },
    workspace,
  );
  const denied = f.store.create(
    "tools",
    {
      name: "未授权工具",
      adapter: "simulation",
      operation: "read",
      permissions: [],
    },
    workspace,
  );
  const disabledSkill = f.store.create(
    "skills",
    { name: "停用技能", content: "不可采用", status: "disabled" },
    workspace,
  );
  await f.run("create_employee", {
    requirements: "创建能使用当前发布资料的员工",
    modelId: f.modelRecord.id,
  });
  const catalogue = JSON.parse(
    f.requests.find((item) => item.scene === "employee.create").messages[1]
      .content,
  ).assets;
  assert.deepEqual(
    catalogue.knowledge.map((item) => item.id),
    [published.id],
  );
  for (const id of [
    draft.id,
    noEgress.id,
    disabled.id,
    denied.id,
    disabledSkill.id,
  ])
    assert.ok(!JSON.stringify(catalogue).includes(id));
  f.model.complete = async (request) => {
    assert.ok(
      !JSON.parse(request.messages[1].content).assets.knowledge.some(
        (item) => item.id === draft.id,
      ),
    );
    return returned({
      name: "非法采纳",
      role: "售后",
      prompt: "使用草案",
      knowledgeIds: [draft.id],
      toolIds: [],
      skillIds: [],
      cases: [{ name: "测试", input: "咨询", expected: "澄清" }],
    });
  };
  await assert.rejects(
    f.run("create_employee", {
      requirements: "明确选择了草案但仍不能自动采纳",
      modelId: f.modelRecord.id,
      knowledgeIds: [draft.id],
    }),
    { code: "UNAUTHORIZED_GENERATED_ASSET" },
  );
});

test("same canonical model with different evaluator configurations cannot form a comparable experiment", async (t) => {
  const f = fixture(t);
  const { dataset } = f.dataset();
  const first = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  f.store.put(
    "models",
    {
      ...f.modelRecord,
      thinking: false,
      baseUrl: "https://different-config.invalid",
    },
    workspace,
  );
  const version = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id },
    workspace,
  );
  const second = await f.run("evaluate", {
    versionId: version.id,
    datasetId: dataset.id,
  });
  const baseline = f.store.get("runs", first.runId, workspace);
  const candidate = f.store.get("runs", second.runId, workspace);
  assert.equal(baseline.manifest.judgeModel, candidate.manifest.judgeModel);
  assert.equal(baseline.manifest.datasetHash, candidate.manifest.datasetHash);
  assert.notEqual(
    baseline.manifest.modelConfigHash,
    candidate.manifest.modelConfigHash,
  );
  assert.notEqual(
    baseline.manifest.evaluatorHash,
    candidate.manifest.evaluatorHash,
  );
  assert.equal(compareRuns(baseline, candidate).comparable, false);
});

test("knowledge marked no-egress is blocked before the model is called", async (t) => {
  const f = fixture(t);
  f.store.put(
    "knowledge",
    { ...f.knowledge, allowedModelEgress: false },
    workspace,
  );
  const { dataset } = f.dataset();
  await assert.rejects(
    f.run("evaluate", { versionId: f.version.id, datasetId: dataset.id }),
    { code: "KNOWLEDGE_EGRESS_DENIED" },
  );
  assert.equal(f.requests.length, 0);
});

test("memory sequence scopes retrieval and expires simulated memory without touching production memory", async (t) => {
  const observed = [];
  const f = fixture(t, (request) => {
    if (request.scene === "employee.execute") {
      observed.push(request.messages[0].content);
      return returned("done");
    }
    return null;
  });
  f.store.create(
    "memories",
    {
      employeeId: f.employee.id,
      scope: "different-scope",
      content: "DO-NOT-LEAK",
      approved: true,
    },
    workspace,
  );
  f.store.create(
    "memories",
    {
      employeeId: "other-employee",
      scope: "active",
      content: "OTHER-EMPLOYEE",
      approved: true,
    },
    workspace,
  );
  f.store.create(
    "memories",
    {
      employeeId: f.employee.id,
      scope: "active",
      content: "APPROVED",
      approved: true,
    },
    workspace,
  );
  const before = f.store.list("memories", workspace);
  const result = await f.run("memory_evaluate", {
    versionId: f.version.id,
    employeeId: f.employee.id,
    scope: "active",
    inputs: [
      { input: "记住代号", remember: [{ content: "EPHEMERAL", ttlMs: 10 }] },
      { input: "现在复述" },
      { input: "稍后询问", advanceMs: 100 },
    ],
  });
  assert.ok(observed[0].includes("APPROVED"));
  assert.ok(!observed[0].includes("DO-NOT-LEAK"));
  assert.ok(!observed[0].includes("OTHER-EMPLOYEE"));
  assert.ok(observed[1].includes("EPHEMERAL"));
  assert.ok(!observed[2].includes("EPHEMERAL"));
  assert.deepEqual(f.store.list("memories", workspace), before);
  assert.equal(
    f.store.get("runs", result.runId, workspace).manifest
      .productionMemoryModified,
    false,
  );
});

test("team execution records authorized handoff and member contribution evidence", async (t) => {
  const assignments = [];
  const f = fixture(t, (request) => {
    if (request.scene === "employee.execute") {
      assignments.push(JSON.parse(request.messages[1].content));
      return returned(`member-result-${assignments.length}`);
    }
    return null;
  });
  const other = f.store.create(
    "employees",
    { name: "审核员", role: "审核" },
    workspace,
  );
  const version = f.engine.createVersion(
    other.id,
    {
      modelId: f.modelRecord.id,
      prompt: "检查事实",
      toolIds: [],
      knowledgeIds: [],
    },
    workspace,
  );
  const team = f.store.create(
    "teams",
    {
      name: "协作组",
      description: "生成并审核报告",
      members: [
        {
          employeeId: f.employee.id,
          versionId: f.version.id,
          task: "起草报告",
        },
        { employeeId: other.id, versionId: version.id, task: "审核报告" },
      ],
      memoryPolicy: "isolated",
    },
    workspace,
  );
  const result = await f.run("team_evaluate", {
    teamId: team.id,
    input: "请完成报告",
  });
  assert.equal(assignments[0].authorizedHandoff.length, 0);
  assert.equal(assignments[1].authorizedHandoff[0].output, "member-result-1");
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.caseResults[0].contributions.length, 2);
  assert.equal(run.manifest.members[1].versionId, version.id);
});

test("assertion operators reject unsupported instructions and unsafe paths do not expose prototypes", () => {
  const evidence = {
    output: "完成",
    steps: [],
    finalState: {},
    violations: [],
  };
  assert.throws(
    () => evaluateAssertions([{ type: "execute_arbitrary_code" }], evidence),
    { code: "INVALID_ASSERTION" },
  );
  const [result] = evaluateAssertions(
    [{ type: "state", path: "__proto__.constructor", operator: "not_exists" }],
    evidence,
  );
  assert.equal(result.passed, true);
});

test("comparison refuses mismatched conditions and confidence is calculated on independent cases", () => {
  const base = {
    datasetId: "a",
    manifest: { comparisonHash: "one" },
    metrics: { score: 80, passRate: 0.8, tokens: 100, latencyMs: 100 },
    caseResults: [{ caseId: "x", passed: true }],
  };
  const next = {
    ...base,
    manifest: { comparisonHash: "two" },
    metrics: { ...base.metrics, score: 90 },
    caseResults: [{ caseId: "x", passed: false, category: "critical" }],
  };
  const comparison = compareRuns(base, next);
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.criticalRegressions.length, 1);
  const interval = wilsonInterval(1, 1);
  assert.ok(interval.lower < 0.3);
  assert.ok(interval.upper <= 1);
});

test("version input validates permission types and rejects malformed asset arrays", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.engine.createVersion(
        f.employee.id,
        { parentId: f.version.id, policy: { allowWrites: "false" } },
        workspace,
      ),
    { code: "INVALID_POLICY" },
  );
  assert.throws(
    () =>
      f.engine.createVersion(
        f.employee.id,
        {
          parentId: f.version.id,
          policy: { allowWrites: true, approvalLimit: -1 },
        },
        workspace,
      ),
    { code: "INVALID_POLICY" },
  );
  assert.throws(
    () =>
      f.engine.createVersion(
        f.employee.id,
        { parentId: f.version.id, toolIds: "invalid-array" },
        workspace,
      ),
    { code: "INVALID_ASSET_IDS" },
  );
  const derived = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id, policy: { maxSteps: 3 } },
    workspace,
  );
  assert.equal(derived.policy.allowWrites, false);
});

test("authorization revocation on a live tool also denies execution through an old snapshot", async (t) => {
  const f = fixture(t);
  f.store.put(
    "tools",
    { ...f.tool, permissions: { enabled: false } },
    workspace,
  );
  const { dataset } = f.dataset();
  await assert.rejects(
    f.run("evaluate", { versionId: f.version.id, datasetId: dataset.id }),
    { code: "TOOL_PERMISSION_DENIED" },
  );
  assert.equal(f.requests.length, 0);
});

test("black-box HTTP employees require explicit test mode and self-reported state is not accepted as business evidence", async (t) => {
  const f = fixture(t);
  f.store.put(
    "employees",
    {
      ...f.store.get("employees", f.employee.id, workspace),
      accessMode: "http",
      endpoint: "https://example.invalid/test-agent",
    },
    workspace,
  );
  const version = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id },
    workspace,
  );
  const { dataset } = f.dataset(
    {},
    {
      assertions: [
        { type: "state", path: "orders.0.status", value: "refunded" },
      ],
    },
  );
  const calls = [];
  const engine = createEngine({
    store: f.store,
    model: f.model,
    tools: {
      execute: async (request) => {
        calls.push(request);
        return {
          result: {
            output: "退款完成",
            finalState: { orders: [{ status: "refunded" }] },
          },
          state: request.state,
          receipt: { adapter: "http", mode: "test" },
        };
      },
    },
  });
  const first = await engine.executeJob(
    {
      id: "remote-1",
      workspace,
      type: "evaluate",
      payload: { versionId: version.id, datasetId: dataset.id },
    },
    { workspace },
  );
  assert.equal(calls.length, 0);
  assert.equal(
    f.store.get("runs", first.runId, workspace).caseResults[0].error.code,
    "EXTERNAL_TEST_MODE_REQUIRED",
  );
  const result = await engine.executeJob(
    {
      id: "remote-2",
      workspace,
      type: "evaluate",
      payload: { versionId: version.id, datasetId: dataset.id, mode: "test" },
    },
    { workspace },
  );
  assert.equal(calls.length, 1);
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.caseResults[0].passed, false);
  assert.equal(run.caseResults[0].finalState.orders[0].status, "paid");
  assert.equal(run.caseResults[0].externalEvidence, "self-reported");
  assert.ok(
    f.store
      .get("reports", result.reportId, workspace)
      .limitations.some((item) => item.includes("独立观察器")),
  );
});

test("dispatcher budget code is recognized and prevents another case dispatch", async (t) => {
  const f = fixture(t, (request) => {
    if (request.scene === "employee.execute")
      throw Object.assign(new Error("budget refused"), {
        code: "BUDGET_EXCEEDED",
        status: 429,
      });
    return null;
  });
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
    repeats: 2,
  });
  assert.equal(result.budgetExhausted, true);
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.store.get("runs", result.runId, workspace).caseResults[1].status,
    "budget_exhausted",
  );
});

test("public search tools are frozen, actually invoked, and a role can narrow the default permission", async (t) => {
  const f = fixture(t, (request) => {
    if (
      request.scene === "employee.execute" &&
      request.messages.at(-1).role !== "tool"
    )
      return toolCall(request, "search_web", {
        query: "人工智能评测的公开方法",
        count: 2,
      });
    return null;
  });
  f.store.put("models", { ...f.modelRecord, search: true }, workspace);
  const calls = [];
  f.model.search = async (request) => {
    calls.push(request);
    return {
      results: [
        {
          title: "公开方法",
          url: "https://example.org/research",
          content: "研究正文",
        },
      ],
    };
  };
  const version = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id },
    workspace,
  );
  assert.deepEqual(version.manifest.virtualTools, [
    "search_web",
    "fetch_web_page",
  ]);
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: version.id,
    datasetId: dataset.id,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    f.store
      .get("runs", result.runId, workspace)
      .caseResults[0].steps.find((step) => step.type === "tool").toolName,
    "search_web",
  );
  const searchAsset = f.store.create(
    "tools",
    {
      name: "bound_search",
      adapter: "http",
      operation: "search_web",
      mode: "readonly",
      config: { modelId: f.modelRecord.id },
    },
    workspace,
  );
  const narrowed = f.engine.createVersion(
    f.employee.id,
    {
      parentId: version.id,
      toolIds: [searchAsset.id],
      policy: { allowSearch: false },
    },
    workspace,
  );
  assert.deepEqual(narrowed.manifest.virtualTools, []);
  const start = f.requests.length;
  await f.run("evaluate", { versionId: narrowed.id, datasetId: dataset.id });
  const firstRequest = f.requests[start];
  assert.ok(
    !firstRequest.tools.some(
      (item) =>
        item.function.name === "search_web" ||
        item.function.description === "bound_search",
    ),
  );
  assert.equal(calls.length, 1);
});

test("search privacy guard denies customer identifiers before sending data to a public service", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.execute" &&
    request.messages.at(-1).role !== "tool"
      ? toolCall(request, "search_web", { query: "请搜索客户电话 13800138000" })
      : null,
  );
  f.store.put("models", { ...f.modelRecord, search: true }, workspace);
  let sent = false;
  f.model.search = async () => {
    sent = true;
    return { results: [] };
  };
  const version = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id },
    workspace,
  );
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: version.id,
    datasetId: dataset.id,
  });
  assert.equal(sent, false);
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.caseResults[0].violations[0].code, "SEARCH_PRIVACY_DENIED");
  assert.equal(run.caseResults[0].passed, false);
});

test("human adjudication creates a new report reference without changing historical evidence or cancelling redlines", async (t) => {
  const f = fixture(t);
  const { dataset, scenario } = f.dataset(
    {},
    {
      assertions: [
        { type: "state", path: "orders.0.status", value: "refunded" },
      ],
    },
  );
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  const beforeRun = f.store.get("runs", result.runId, workspace);
  const beforeReport = f.store.get("reports", result.reportId, workspace);
  const review = f.store.create(
    "reviews",
    {
      runId: result.runId,
      caseId: scenario.id,
      decision: "pass",
      reason: "人工确认表达合格，但业务状态未改变",
    },
    workspace,
  );
  const report = f.engine.buildReport(result.runId, workspace);
  assert.notEqual(report.id, beforeReport.id);
  assert.equal(report.adjudication.reviews[0].id, review.id);
  assert.equal(report.adjudication.deniedOverrides.length, 1);
  assert.equal(report.adjudication.effectiveMetrics.passed, 0);
  assert.deepEqual(f.store.get("runs", result.runId, workspace), beforeRun);
  assert.deepEqual(
    f.store.get("reports", result.reportId, workspace),
    beforeReport,
  );
});

async function interruptAfterCheckpoint(f, payload) {
  const job = f.store.create(
    "jobs",
    {
      type: "evaluate",
      payload,
      status: "running",
      usedTokens: 0,
      budgetTokens: 100000,
    },
    workspace,
  );
  await assert.rejects(
    f.engine.executeJob(job, {
      workspace,
      jobId: job.id,
      onProgress: (progress, message) => {
        const current = f.store.get("jobs", job.id, workspace);
        assert.equal(
          current.checkpointIds.length,
          1,
          "case is durable before progress is acknowledged",
        );
        f.store.put("jobs", { ...current, progress, message }, workspace);
        throw Object.assign(
          new Error("simulated process interruption after checkpoint"),
          { code: "TEST_PROCESS_INTERRUPTED" },
        );
      },
    }),
    { code: "TEST_PROCESS_INTERRUPTED" },
  );
  const interrupted = f.store.get("jobs", job.id, workspace);
  return f.store.put(
    "jobs",
    { ...interrupted, status: "interrupted" },
    workspace,
  );
}

test("SQLite checkpoints survive an interrupted evaluation and resume completed cases without another model call", async (t) => {
  const f = fixture(t);
  let { dataset, scenario } = f.dataset();
  const second = f.store.create(
    "cases",
    {
      ...scenario,
      id: undefined,
      name: "第二个场景",
      input: "请核验另一个标准任务",
    },
    workspace,
  );
  dataset = f.store.put(
    "datasets",
    { ...dataset, caseIds: [scenario.id, second.id] },
    workspace,
  );
  const payload = {
    versionId: f.version.id,
    datasetId: dataset.id,
    mode: "simulated",
  };
  const oldJob = await interruptAfterCheckpoint(f, payload);
  assert.equal(f.requests.length, 2);
  assert.equal(f.store.list("runs", workspace).length, 0);
  const original = f.store.get(
    "checkpoints",
    oldJob.checkpointIds[0],
    workspace,
  );
  assert.equal(original.caseId, scenario.id);
  assert.equal(original.caseResult.status, "completed");
  assert.equal(original.datasetPurpose, "dev");
  assert.ok(original.inputSnapshotHash);
  assert.ok(original.comparisonHash);
  assert.throws(
    () => f.store.put("checkpoints", original, workspace),
    /不可修改/,
  );
  const job = f.store.create(
    "jobs",
    {
      type: "evaluate",
      payload: { ...payload, resumeFromJobId: oldJob.id },
      status: "running",
      budgetTokens: 100000,
    },
    workspace,
  );
  const result = await f.engine.executeJob(job, {
    workspace,
    jobId: job.id,
    onProgress: (progress, message) => {
      const current = f.store.get("jobs", job.id, workspace);
      f.store.put("jobs", { ...current, progress, message }, workspace);
    },
  });
  assert.equal(
    f.requests.length,
    4,
    "only the unfinished second case and its judge are called",
  );
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.metrics.total, 2);
  assert.equal(run.metrics.passed, 2);
  assert.equal(run.metrics.reusedCaseCount, 1);
  assert.equal(run.metrics.reusedTokens, 40);
  assert.equal(run.metrics.totalJobTokens, 40);
  assert.equal(run.manifest.resumedFromJobId, oldJob.id);
  assert.equal(run.caseResults[0].resumedFromCheckpointId, original.id);
  assert.equal(f.store.get("jobs", job.id, workspace).checkpointIds.length, 2);
  assert.equal(
    f.store.get("checkpoints", result.checkpointIds[0], workspace)
      .resumedFromJobId,
    oldJob.id,
  );
  assert.equal(f.store.verifyEvents(workspace), true);
});

test("resume rejects changed input or evaluator conditions before sending another request", async (t) => {
  const f = fixture(t);
  const { dataset, scenario } = f.dataset();
  const payload = { versionId: f.version.id, datasetId: dataset.id };
  const oldJob = await interruptAfterCheckpoint(f, payload);
  const before = f.requests.length;
  f.store.put("cases", { ...scenario, input: "已经改变的输入" }, workspace);
  const job = f.store.create(
    "jobs",
    {
      type: "evaluate",
      payload: { ...payload, resumeFromJobId: oldJob.id },
      status: "running",
      budgetTokens: 100000,
    },
    workspace,
  );
  await assert.rejects(f.engine.executeJob(job, { workspace, jobId: job.id }), {
    code: "RESUME_CONDITIONS_CHANGED",
  });
  assert.equal(f.requests.length, before);
});

test("resume refuses test endpoints, active source jobs and different frozen versions", async (t) => {
  const f = fixture(t);
  const { dataset } = f.dataset();
  const payload = { versionId: f.version.id, datasetId: dataset.id };
  const oldJob = await interruptAfterCheckpoint(f, payload);
  const before = f.requests.length;
  const run = (change) =>
    f.engine.executeJob(
      {
        id: "new-resume-job",
        type: "evaluate",
        workspace,
        budgetTokens: 100000,
        payload: { ...payload, resumeFromJobId: oldJob.id, ...change },
      },
      { workspace },
    );
  await assert.rejects(run({ mode: "test" }), { code: "UNSAFE_RESUME_MODE" });
  const version = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id, prompt: "新的版本" },
    workspace,
  );
  await assert.rejects(run({ versionId: version.id }), {
    code: "RESUME_CONDITIONS_CHANGED",
  });
  f.store.put(
    "jobs",
    { ...f.store.get("jobs", oldJob.id, workspace), status: "running" },
    workspace,
  );
  await assert.rejects(run({}), { code: "RESUME_JOB_NOT_ELIGIBLE" });
  assert.equal(f.requests.length, before);
});

test("confirmed error checkpoints are retained as failures instead of automatically retrying their original request", async (t) => {
  const f = fixture(t, (request) => {
    if (
      request.scene === "employee.execute" &&
      request.messages[1].content.includes("明确失败的场景")
    )
      throw Object.assign(new Error("confirmed rejected test request"), {
        code: "CONFIRMED_REQUEST_REJECTED",
        status: 422,
      });
    return null;
  });
  let { dataset, scenario } = f.dataset({}, { input: "明确失败的场景" });
  const second = f.store.create(
    "cases",
    { ...scenario, id: undefined, input: "剩余场景", name: "剩余场景" },
    workspace,
  );
  dataset = f.store.put(
    "datasets",
    { ...dataset, caseIds: [scenario.id, second.id] },
    workspace,
  );
  const payload = { versionId: f.version.id, datasetId: dataset.id };
  const oldJob = await interruptAfterCheckpoint(f, payload);
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.store.get("checkpoints", oldJob.checkpointIds[0], workspace).caseResult
      .status,
    "error",
  );
  const job = f.store.create(
    "jobs",
    {
      type: "evaluate",
      payload: { ...payload, resumeFromJobId: oldJob.id },
      status: "running",
      budgetTokens: 100000,
    },
    workspace,
  );
  const result = await f.engine.executeJob(job, { workspace, jobId: job.id });
  assert.equal(f.requests.length, 3);
  const run = f.store.get("runs", result.runId, workspace);
  assert.equal(run.metrics.total, 2);
  assert.equal(run.metrics.incomplete, 1);
  assert.equal(run.caseResults[0].error.code, "CONFIRMED_REQUEST_REJECTED");
  assert.equal(run.caseResults[0].resumedFromJobId, oldJob.id);
});

test("direct engine calls without a stored jobs row still persist case evidence", async (t) => {
  const f = fixture(t);
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  assert.equal(result.checkpointIds.length, 1);
  assert.equal(
    f.store.get("checkpoints", result.checkpointIds[0], workspace).jobId,
    "test-job",
  );
  assert.equal(f.store.list("jobs", workspace).length, 0);
});

test("checkpoints and source job links survive closing and reopening a disk SQLite database", async (t) => {
  mkdirSync("work", { recursive: true });
  const directory = mkdtempSync(join("work", "checkpoint-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "evaluation.sqlite");
  const f = fixture(t, () => null, file);
  let { dataset, scenario } = f.dataset();
  const second = f.store.create(
    "cases",
    {
      ...scenario,
      id: undefined,
      name: "进程恢复后的场景",
      input: "继续剩余任务",
    },
    workspace,
  );
  dataset = f.store.put(
    "datasets",
    { ...dataset, caseIds: [scenario.id, second.id] },
    workspace,
  );
  const payload = { versionId: f.version.id, datasetId: dataset.id };
  const oldJob = await interruptAfterCheckpoint(f, payload);
  const originalPointId = oldJob.checkpointIds[0];
  f.store.close();
  const restartedStore = createStore(file);
  t.after(() => {
    if (restartedStore.db.isOpen) restartedStore.close();
  });
  const restartedTools = createToolService({
    store: restartedStore,
    model: f.model,
  });
  const restartedEngine = createEngine({
    store: restartedStore,
    model: f.model,
    tools: restartedTools,
  });
  assert.equal(
    restartedStore.get("jobs", oldJob.id, workspace).checkpointIds[0],
    originalPointId,
  );
  const job = restartedStore.create(
    "jobs",
    {
      type: "evaluate",
      payload: { ...payload, resumeFromJobId: oldJob.id },
      status: "running",
      budgetTokens: 100000,
    },
    workspace,
  );
  const result = await restartedEngine.executeJob(job, {
    workspace,
    jobId: job.id,
  });
  const run = restartedStore.get("runs", result.runId, workspace);
  assert.equal(f.requests.length, 4);
  assert.equal(run.metrics.total, 2);
  assert.equal(run.metrics.reusedCaseCount, 1);
  assert.equal(run.caseResults[0].resumedFromCheckpointId, originalPointId);
  assert.equal(restartedStore.verifyEvents(workspace), true);
  restartedStore.close();
});

test("retrieval configuration is frozen, strictly bounded and controls actual returned chunks and threshold", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.version.retrieval, {
    topK: 8,
    chunkSize: 1400,
    overlap: 300,
    minScore: 0,
  });
  for (const retrieval of [
    { topK: 0 },
    { topK: 31 },
    { topK: 1.5 },
    { chunkSize: 255 },
    { overlap: 1400 },
    { minScore: -1 },
    { extra: "not-supported" },
  ])
    assert.throws(
      () =>
        f.engine.createVersion(
          f.employee.id,
          { parentId: f.version.id, retrieval },
          workspace,
        ),
      { code: "INVALID_RETRIEVAL" },
    );
  const knowledge = f.store.put(
    "knowledge",
    { ...f.knowledge, content: "订单".repeat(1000) },
    workspace,
  );
  const version = f.engine.createVersion(
    f.employee.id,
    {
      parentId: f.version.id,
      retrieval: { topK: 2, chunkSize: 256, overlap: 16 },
    },
    workspace,
  );
  assert.deepEqual(version.manifest.retrieval, {
    topK: 2,
    chunkSize: 256,
    overlap: 16,
    minScore: 0,
  });
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: version.id,
    datasetId: dataset.id,
  });
  const hits = f.store
    .get("runs", result.runId, workspace)
    .caseResults[0].steps.find((step) => step.type === "retrieval").hits;
  assert.equal(hits.length, 2);
  assert.equal(hits[0].content.length, 256);
  assert.equal(hits[1].start, 240);
  const filtered = f.engine.createVersion(
    f.employee.id,
    { parentId: version.id, retrieval: { minScore: 1000 } },
    workspace,
  );
  const next = await f.run("evaluate", {
    versionId: filtered.id,
    datasetId: dataset.id,
  });
  assert.ok(
    !f.store
      .get("runs", next.runId, workspace)
      .caseResults[0].steps.some((step) => step.type === "retrieval"),
  );
  assert.equal(
    f.store.get("knowledge", knowledge.id, workspace).content,
    knowledge.content,
  );
});

test("optimizer can improve retrieval alone as a material version change without modifying knowledge or binding extra assets", async (t) => {
  let f;
  f = fixture(t, (request) => {
    if (request.scene === "employee.execute")
      return returned(
        request.messages[0].content.includes("补充规则：退款后核验到账状态。")
          ? "正确结果"
          : "缺少后续核验",
      );
    if (request.scene === "evaluation.judge") {
      const evidence = JSON.parse(request.messages[1].content);
      const passed = evidence.output === "正确结果";
      return returned({
        score: passed ? 96 : 60,
        passed,
        reason: passed ? "包含完整流程" : "遗漏到账核验",
        issues: [],
      });
    }
    if (request.scene === "optimization.patch") {
      const evidence = JSON.parse(request.messages[1].content);
      assert.equal(evidence.retrieval.topK, 1);
      return returned({
        prompt: evidence.prompt,
        retrieval: { topK: 2 },
        skillOverrides: [],
        rationale: "取回第二条授权知识，覆盖核验流程",
        hypothesis: "扩大命中候选可减少遗漏",
        risks: [],
      });
    }
    return null;
  });
  const extra = f.store.create(
    "knowledge",
    {
      name: "补充流程",
      content: "补充规则：退款后核验到账状态。",
      source: "test",
      allowedModelEgress: true,
    },
    workspace,
  );
  const baseline = f.engine.createVersion(
    f.employee.id,
    {
      parentId: f.version.id,
      knowledgeIds: [f.knowledge.id, extra.id],
      retrieval: { topK: 1 },
    },
    workspace,
  );
  const { dataset } = f.dataset();
  const result = await f.run("optimize", {
    versionId: baseline.id,
    datasetId: dataset.id,
    maxRounds: 1,
    candidatesPerRound: 1,
  });
  const candidate = f.store.get("versions", result.bestVersionId, workspace);
  assert.notEqual(candidate.id, baseline.id);
  assert.equal(candidate.prompt, baseline.prompt);
  assert.equal(candidate.retrieval.topK, 2);
  assert.deepEqual(candidate.knowledgeIds, baseline.knowledgeIds);
  assert.deepEqual(
    candidate.manifest.snapshots.knowledge,
    baseline.manifest.snapshots.knowledge,
  );
  assert.equal(
    f.store.list("optimizations", workspace)[0].candidates[0].accepted,
    true,
  );
});

test("all known call costs survive employee and judge aggregation and the price configuration remains frozen", async (t) => {
  const f = fixture(t, (request) => {
    const usage = {
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      costUSD: request.scene === "evaluation.judge" ? 0.003 : 0.002,
      costBasis: "USD_estimate",
    };
    if (request.scene === "employee.execute")
      return returned("完成", { usage });
    if (request.scene === "evaluation.judge")
      return returned(
        { score: 90, passed: true, reason: "已核验", issues: [] },
        { usage },
      );
    return null;
  });
  const pricing = {
    inputPerMillionUSD: 0.1,
    outputPerMillionUSD: 0.5,
    source: "test-only-rate",
    verifiedAt: "2026-11-04",
  };
  f.store.put("models", { ...f.modelRecord, pricing }, workspace);
  const version = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id },
    workspace,
  );
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: version.id,
    datasetId: dataset.id,
    repeats: 2,
  });
  const run = f.store.get("runs", result.runId, workspace);
  assert.ok(Math.abs(run.metrics.costUSD - 0.01) < 1e-10);
  assert.equal(run.metrics.costBasis, "USD_estimate");
  assert.equal(run.caseResults[0].usage.modelCalls, 2);
  assert.ok(Math.abs(run.caseResults[0].usage.costUSD - 0.005) < 1e-10);
  assert.deepEqual(version.manifest.snapshots.model.pricing, pricing);
});

test("unknown model pricing stays a token proxy rather than becoming an invented zero cost", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.execute"
      ? returned("完成", { usage: { totalTokens: 20, costUSD: 0.002 } })
      : null,
  );
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  assert.equal(result.metrics.costBasis, "tokens");
  assert.equal(Object.hasOwn(result.metrics, "costUSD"), false);
});

test("targeted knowledge refresh adopts only the selected published revision and preserves other parent snapshots", (t) => {
  const f = fixture(t);
  const other = f.store.create(
    "knowledge",
    {
      name: "另一份知识",
      content: "旧知识二",
      published: true,
      status: "published",
      allowedModelEgress: true,
    },
    workspace,
  );
  const baseline = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id, knowledgeIds: [f.knowledge.id, other.id] },
    workspace,
  );
  const first = f.store.put(
    "knowledge",
    {
      ...f.knowledge,
      content: "新发布知识一",
      published: true,
      status: "published",
    },
    workspace,
  );
  f.store.put(
    "knowledge",
    { ...other, content: "不应夹带更新的知识二" },
    workspace,
  );
  f.store.put("tools", { ...f.tool, operation: "delete" }, workspace);
  f.store.put(
    "models",
    {
      ...f.modelRecord,
      thinking: false,
      baseUrl: "https://unrelated-new-model-endpoint.invalid",
    },
    workspace,
  );
  const candidate = f.engine.createVersion(
    f.employee.id,
    {
      parentId: baseline.id,
      preserveParentSnapshots: true,
      refreshKnowledgeIds: [first.id],
    },
    workspace,
  );
  assert.equal(
    candidate.manifest.snapshots.knowledge[0].content,
    "新发布知识一",
  );
  assert.equal(
    candidate.manifest.snapshots.knowledge[0].sourceRevision,
    first.revision,
  );
  assert.equal(candidate.manifest.snapshots.knowledge[1].content, "旧知识二");
  assert.deepEqual(
    candidate.manifest.snapshots.tools,
    baseline.manifest.snapshots.tools,
  );
  assert.deepEqual(
    candidate.manifest.snapshots.model,
    baseline.manifest.snapshots.model,
  );
  assert.deepEqual(candidate.manifest.refreshKnowledgeIds, [first.id]);
  assert.notEqual(candidate.manifestHash, baseline.manifestHash);
});

test("targeted knowledge refresh rejects unpublished, unbound or egress-denied content and optimizer cannot request it", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "optimization.patch"
      ? returned({
          prompt: "changed",
          refreshKnowledgeIds: [f.knowledge.id],
          rationale: "不得由优化器刷新事实",
        })
      : null,
  );
  const configuration = {
    parentId: f.version.id,
    preserveParentSnapshots: true,
    refreshKnowledgeIds: [f.knowledge.id],
  };
  assert.throws(
    () => f.engine.createVersion(f.employee.id, configuration, workspace),
    { code: "KNOWLEDGE_REFRESH_NOT_PUBLISHED" },
  );
  assert.throws(
    () =>
      f.engine.createVersion(
        f.employee.id,
        { ...configuration, refreshKnowledgeIds: ["unbound"] },
        workspace,
      ),
    { code: "INVALID_KNOWLEDGE_REFRESH" },
  );
  f.store.put(
    "knowledge",
    {
      ...f.knowledge,
      published: true,
      status: "published",
      allowedModelEgress: false,
    },
    workspace,
  );
  assert.throws(
    () => f.engine.createVersion(f.employee.id, configuration, workspace),
    { code: "KNOWLEDGE_EGRESS_DENIED" },
  );
  f.store.put(
    "knowledge",
    {
      ...f.store.get("knowledge", f.knowledge.id, workspace),
      allowedModelEgress: true,
    },
    workspace,
  );
  const { dataset } = f.dataset();
  await assert.rejects(
    f.run("optimize", {
      versionId: f.version.id,
      datasetId: dataset.id,
      maxRounds: 1,
      candidatesPerRound: 1,
    }),
    { code: "PATCH_SCOPE_VIOLATION" },
  );
});

test("different worker models remain comparable under one frozen independent judge, but changing that judge does not", async (t) => {
  const f = fixture(t);
  const judge = f.store.create(
    "models",
    {
      ...f.modelRecord,
      id: undefined,
      name: "固定裁判",
      model: "fixed-test-judge",
      thinking: true,
      baseUrl: "https://judge.invalid",
    },
    workspace,
  );
  const workerB = f.store.create(
    "models",
    {
      ...f.modelRecord,
      id: undefined,
      name: "另一个被测权重",
      model: "different-trained-worker",
    },
    workspace,
  );
  f.store.create(
    "settings",
    { defaultModelId: f.modelRecord.id, defaultJudgeModelId: judge.id },
    workspace,
  );
  const versionB = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id, modelId: workerB.id },
    workspace,
  );
  const { dataset } = f.dataset();
  const first = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  const second = await f.run("evaluate", {
    versionId: versionB.id,
    datasetId: dataset.id,
  });
  const a = f.store.get("runs", first.runId, workspace),
    b = f.store.get("runs", second.runId, workspace);
  assert.notEqual(a.manifest.workerModel, b.manifest.workerModel);
  assert.notEqual(
    a.manifest.workerModelConfigHash,
    b.manifest.workerModelConfigHash,
  );
  assert.equal(
    a.manifest.judgeModelConfigHash,
    b.manifest.judgeModelConfigHash,
  );
  assert.equal(a.manifest.judgeModelId, judge.id);
  assert.equal(compareRuns(a, b).comparable, true);
  assert.ok(
    f.requests
      .filter((request) => request.scene === "evaluation.judge")
      .every((request) => request.modelId === judge.id),
  );
  f.store.put("models", { ...judge, thinking: false }, workspace);
  const third = await f.run("evaluate", {
    versionId: versionB.id,
    datasetId: dataset.id,
  });
  assert.equal(
    compareRuns(b, f.store.get("runs", third.runId, workspace)).comparable,
    false,
  );
});

test("judge selection follows evaluation then dataset then workspace priority", async (t) => {
  const f = fixture(t);
  const judges = [1, 2, 3].map((index) =>
    f.store.create(
      "models",
      {
        ...f.modelRecord,
        id: undefined,
        name: `裁判${index}`,
        model: `judge-${index}`,
      },
      workspace,
    ),
  );
  f.store.create("settings", { defaultJudgeModelId: judges[2].id }, workspace);
  const { dataset } = f.dataset({ judgeModelId: judges[1].id });
  const chosen = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
    judgeModelId: judges[0].id,
  });
  const datasetChosen = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  f.store.put("datasets", { ...dataset, judgeModelId: null }, workspace);
  const workspaceChosen = await f.run("evaluate", {
    versionId: f.version.id,
    datasetId: dataset.id,
  });
  assert.equal(
    f.store.get("runs", chosen.runId, workspace).manifest.judgeModelId,
    judges[0].id,
  );
  assert.equal(
    f.store.get("runs", datasetChosen.runId, workspace).manifest.judgeModelId,
    judges[1].id,
  );
  assert.equal(
    f.store.get("runs", workspaceChosen.runId, workspace).manifest.judgeModelId,
    judges[2].id,
  );
});

test("optimizer freezes one judge configuration across its baseline and candidates even if live configuration changes", async (t) => {
  let f, judge;
  f = fixture(t, (request) => {
    if (request.scene === "employee.execute")
      return returned(
        request.messages[0].content.startsWith("improved") ? "正确" : "遗漏",
      );
    if (request.scene === "evaluation.judge") {
      assert.equal(request.modelId, judge.id);
      assert.equal(request.modelConfig.thinking, true);
      const passed = JSON.parse(request.messages[1].content).output === "正确";
      return returned({
        score: passed ? 96 : 60,
        passed,
        reason: "按同一裁判标准",
        issues: [],
      });
    }
    if (request.scene === "optimization.patch") {
      f.store.put(
        "models",
        {
          ...judge,
          thinking: false,
          baseUrl: "https://new-live-judge.invalid",
        },
        workspace,
      );
      return returned({
        prompt: "improved 泛化步骤",
        rationale: "补齐步骤",
        skillOverrides: [],
      });
    }
    return null;
  });
  judge = f.store.create(
    "models",
    {
      ...f.modelRecord,
      id: undefined,
      name: "固定裁判",
      model: "judge-fixed",
      thinking: true,
    },
    workspace,
  );
  f.store.create("settings", { defaultJudgeModelId: judge.id }, workspace);
  const { dataset } = f.dataset();
  const result = await f.run("optimize", {
    versionId: f.version.id,
    datasetId: dataset.id,
    maxRounds: 1,
    candidatesPerRound: 1,
  });
  assert.notEqual(result.bestVersionId, f.version.id);
  const baseline = f.store.get("runs", result.baselineRunId, workspace);
  const best = f.store.get("runs", result.bestRunId, workspace);
  assert.equal(
    baseline.manifest.judgeModelConfigHash,
    best.manifest.judgeModelConfigHash,
  );
  assert.equal(compareRuns(baseline, best).comparable, true);
});

test("employee creation pins the workspace default and refuses ambiguous selection rather than switching to a new training model", async (t) => {
  const f = fixture(t, (request) =>
    request.scene === "employee.create"
      ? returned({
          name: "默认模型员工",
          role: "售后",
          prompt: "明确职责",
          knowledgeIds: [],
          toolIds: [],
          skillIds: [],
          gaps: [],
          cases: [{ name: "咨询", input: "如何办理", expected: "按依据澄清" }],
        })
      : null,
  );
  f.store.create(
    "models",
    {
      ...f.modelRecord,
      id: undefined,
      name: "刚训练完成的模型",
      model: "new-trained-model",
    },
    workspace,
  );
  await assert.rejects(
    f.run("create_employee", {
      requirements: "创建售后专员，不能擅自选新模型",
    }),
    { code: "DEFAULT_MODEL_REQUIRED" },
  );
  assert.equal(f.requests.length, 0);
  f.store.create("settings", { defaultModelId: f.modelRecord.id }, workspace);
  await f.run("create_employee", {
    requirements: "使用工作区默认模型创建售后专员",
  });
  assert.equal(f.requests[0].modelId, f.modelRecord.id);
});

test("private worker knowledge is not leaked to an explicitly selected remote judge", async (t) => {
  const f = fixture(t);
  f.store.put("models", { ...f.modelRecord, provider: "local" }, workspace);
  f.store.put(
    "knowledge",
    { ...f.knowledge, allowedModelEgress: false },
    workspace,
  );
  const localVersion = f.engine.createVersion(
    f.employee.id,
    { parentId: f.version.id },
    workspace,
  );
  const remoteJudge = f.store.create(
    "models",
    {
      ...f.modelRecord,
      id: undefined,
      provider: "remote-test",
      model: "remote-judge",
    },
    workspace,
  );
  const { dataset } = f.dataset();
  const result = await f.run("evaluate", {
    versionId: localVersion.id,
    datasetId: dataset.id,
    judgeModelId: remoteJudge.id,
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].scene, "employee.execute");
  assert.equal(
    f.store.get("runs", result.runId, workspace).caseResults[0].error.code,
    "KNOWLEDGE_EGRESS_DENIED",
  );
});
