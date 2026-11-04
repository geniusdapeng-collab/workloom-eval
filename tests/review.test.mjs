import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../server/index.mjs";
import { createStore } from "../server/store.mjs";
import { createModel } from "../server/model.mjs";
import { createEngine } from "../server/engine.mjs";
import { createAdvanced } from "../server/advanced.mjs";
import { createToolService } from "../server/tools.mjs";

// These fixtures contain synthetic business data and injected transports only.
// They never open the application database or call a model provider.
function apiFixture(t) {
  const store = createStore();
  const app = createApplication({
    store,
    disableWorker: true,
    env: { HOST: "127.0.0.1", EVAL_AUTH_MODE: "local" },
  });
  t.after(() => {
    app.close();
    store.close();
  });
  const request = (path, method = "GET", data) =>
    app.app.request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  return { ...app, request };
}

test("review: an innocuous edit cannot return a hidden case answer in the mutation response", async (t) => {
  const f = apiFixture(t);
  const hidden = f.store.list("cases").find((c) => c.hidden);
  const before = await (
    await f.request(`/api/resources/cases/${hidden.id}`)
  ).json();
  assert.equal(before.input, undefined);
  const response = await f.request(`/api/resources/cases/${hidden.id}`, "PUT", {
    name: "rename only",
    expectedRevision: before.revision,
  });
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes(hidden.input), false);
  assert.equal(JSON.stringify(body).includes(hidden.expected), false);
});

test("review: dataset partitions and generated provenance cannot be laundered through generic updates", async (t) => {
  const f = apiFixture(t);
  const dataset = f.store.get("datasets", "dataset-aftersale-dev");
  const response = await f.request(
    `/api/resources/datasets/${dataset.id}`,
    "PUT",
    {
      expectedRevision: dataset.revision,
      purpose: "holdout",
      generated: false,
    },
  );
  assert.ok([403, 409].includes(response.status));
  assert.equal(f.store.get("datasets", dataset.id).purpose, "dev");
});

test("review: historical holdout evidence stays redacted even if live dataset metadata drifts", async (t) => {
  const f = apiFixture(t);
  const dataset = f.store.get("datasets", "dataset-aftersale-holdout");
  const run = f.store.create("runs", {
    versionId: "version-aftersale-01",
    datasetId: dataset.id,
    status: "completed",
    manifest: { datasetPurpose: "holdout" },
    metrics: { score: 99 },
    caseResults: [
      {
        caseId: dataset.caseIds[0],
        input: "HIDDEN_INPUT_MARKER",
        output: "HIDDEN_OUTPUT_MARKER",
        expected: "HIDDEN_EXPECTED_MARKER",
        steps: [],
        passed: true,
        status: "completed",
        score: 99,
      },
    ],
  });
  const report = f.engine.buildReport({
    ...run,
    metrics: {
      ...run.metrics,
      total: 1,
      valid: 1,
      passed: 1,
      passRate: 1,
      incomplete: 0,
      violations: 0,
      uniqueCases: 1,
      interval: { lower: 0.2 },
    },
  });
  // Direct store drift simulates an import/migration; API protections alone are insufficient.
  f.store.put("datasets", { ...dataset, purpose: "dev" });
  for (const path of [
    `/api/resources/runs/${run.id}`,
    `/api/resources/reports/${report.id}`,
    `/api/reports/${report.id}/export?format=json`,
  ]) {
    const response = await f.request(path);
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes("HIDDEN_"), false, path);
    assert.equal(
      body.redacted || body.caseResults?.every((c) => c.redacted),
      true,
      path,
    );
  }
});

test("review: deleting a holdout dataset cannot turn its generically-created cases into readable orphans", async (t) => {
  const f = apiFixture(t);
  const dataset = f.store.get("datasets", "dataset-aftersale-holdout");
  const created = await (
    await f.request("/api/resources/cases", "POST", {
      name: "new sealed case",
      input: "ORPHAN_HIDDEN_INPUT",
      expected: "ORPHAN_HIDDEN_EXPECTED",
      assertions: [],
      datasetId: dataset.id,
      hidden: false,
    })
  ).json();
  assert.equal(JSON.stringify(created).includes("ORPHAN_HIDDEN_"), false);
  const deleted = await f.request(
    `/api/resources/datasets/${dataset.id}`,
    "DELETE",
  );
  assert.ok(
    deleted.status >= 400,
    "a sealed partition must not be deleted while its cases exist",
  );
  const visible = await (
    await f.request(`/api/resources/cases/${created.id}`)
  ).json();
  assert.equal(JSON.stringify(visible).includes("ORPHAN_HIDDEN_"), false);
});

test("review: a previously exposed dev case cannot be relabeled as an independent holdout case", async (t) => {
  const f = apiFixture(t);
  const dataset = f.store.get("datasets", "dataset-aftersale-dev");
  const scenario = f.store.get("cases", dataset.caseIds[0]);
  const response = await f.request(
    `/api/resources/cases/${scenario.id}`,
    "PUT",
    {
      expectedRevision: scenario.revision,
      datasetId: "dataset-aftersale-holdout",
    },
  );
  assert.ok([403, 409].includes(response.status));
  assert.equal(f.store.get("cases", scenario.id).datasetId, dataset.id);
});

test("review: invalid provider usage holds the in-flight budget instead of funding a second request", async (t) => {
  const store = createStore();
  t.after(() => store.close());
  store.create("models", {
    id: "budget-model",
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    secretRef: "test-key",
    contextTokens: 100000,
    maxOutputTokens: 100000,
  });
  const job = store.create("jobs", {
    status: "running",
    type: "evaluate",
    budgetTokens: 1000,
    usedTokens: 0,
  });
  let calls = 0;
  const model = createModel({
    store,
    secrets: new Map([["default:test-key", "synthetic-test-secret"]]),
    transport: async () => {
      calls++;
      return {
        data: {
          id: "synthetic-response",
          model: "deepseek-flash",
          choices: [
            { finish_reason: "stop", message: { content: '{"ok":true}' } },
          ],
          usage: {},
        },
      };
    },
  });
  await model.withBudget(job, async () => {
    const input = {
      modelId: "budget-model",
      scene: "schema.review",
      messages: [{ role: "user", content: "Return JSON." }],
    };
    await assert.rejects(model.complete(input), { code: "MISSING_USAGE" });
    await assert.rejects(model.complete(input));
  });
  assert.equal(
    calls,
    1,
    "an unaccounted provider attempt must not release its reservation",
  );
  assert.equal(
    store.list("receipts").some((r) => r.reservationHeld === true),
    true,
  );
});

test("review: unresolved model attempts survive dispatcher recreation and cannot be resent as a new job", async (t) => {
  const store = createStore();
  t.after(() => store.close());
  store.create("models", {
    id: "restart-model",
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    secretRef: "test-key",
    contextTokens: 100000,
    maxOutputTokens: 100000,
  });
  let calls = 0;
  const options = {
    store,
    secrets: new Map([["default:test-key", "synthetic-test-secret"]]),
    transport: async () => {
      calls++;
      throw Object.assign(new Error("synthetic ambiguous timeout"), {
        code: "UPSTREAM_TIMEOUT",
        status: 504,
      });
    },
  };
  const input = {
    modelId: "restart-model",
    scene: "schema.review",
    messages: [
      { role: "user", content: "identical request after process restart" },
    ],
  };
  const firstJob = store.create("jobs", {
    status: "running",
    type: "evaluate",
    budgetTokens: 1000,
    usedTokens: 0,
  });
  const firstModel = createModel(options);
  await assert.rejects(
    firstModel.withBudget(firstJob, () => firstModel.complete(input)),
    { code: "UPSTREAM_TIMEOUT" },
  );
  const secondModel = createModel(options);
  const secondJob = store.create("jobs", {
    status: "running",
    type: "evaluate",
    budgetTokens: 1000,
    usedTokens: 0,
  });
  await assert.rejects(
    secondModel.withBudget(secondJob, () => secondModel.complete(input)),
    { code: "UNRESOLVED_ATTEMPT" },
  );
  assert.equal(calls, 1);
});

test("review: direct dispatcher calls respect model permission revocation outside the evaluation engine", async (t) => {
  const store = createStore();
  t.after(() => store.close());
  store.create("models", {
    id: "denied-model",
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    secretRef: "test-key",
    permissions: { enabled: false },
  });
  let calls = 0;
  const model = createModel({
    store,
    secrets: new Map([["default:test-key", "synthetic-test-secret"]]),
    transport: async () => {
      calls++;
      throw new Error("revoked model must not be sent");
    },
  });
  await assert.rejects(
    model.complete({
      modelId: "denied-model",
      scene: "long_horizon",
      messages: [{ role: "user", content: "synthetic memory question" }],
    }),
    (error) => error.status === 403,
  );
  assert.equal(calls, 0);
  assert.equal(model.available().length, 0);
});

test("review: virtual search forwards the frozen model configuration instead of silently reading the live model", async (t) => {
  const store = createStore();
  t.after(() => store.close());
  let observed;
  const model = {
    search: async (request) => {
      observed = request;
      return { results: [] };
    },
  };
  const service = createToolService({ store, model });
  const modelConfig = { id: "model", model: "frozen-model", revision: 1 };
  await service.execute({
    toolId: "virtual-search",
    toolSnapshot: {
      id: "virtual-search",
      name: "search_web",
      adapter: "http",
      mode: "readonly",
      operation: "search_web",
      config: { modelId: "model", modelConfig },
      inputSchema: { type: "object" },
    },
    args: { query: "public evaluation methods" },
  });
  assert.deepEqual(observed.modelConfig, modelConfig);
});

test("review: removing live write permission blocks a historical tool snapshot that still contains write access", async (t) => {
  const store = createStore();
  t.after(() => store.close());
  const original = store.create("tools", {
    name: "refund",
    adapter: "simulation",
    operation: "refund",
    mode: "simulated",
    permissions: ["read", "write"],
    inputSchema: { type: "object" },
  });
  store.put("tools", { ...original, permissions: ["read"] });
  const tools = createToolService({ store, model: {} });
  await assert.rejects(
    tools.execute({
      toolId: original.id,
      toolSnapshot: original,
      args: { orderId: "order", amount: 10 },
      state: { orders: [{ id: "order", amount: 10, status: "paid" }] },
    }),
    (error) => error.status === 403,
  );
});

function engineFixture(t, handler) {
  const store = createStore();
  t.after(() => store.close());
  let completeCalls = 0;
  const model = {
    complete: async (request) => {
      completeCalls++;
      const value = handler?.(request);
      if (value)
        return {
          value,
          content: JSON.stringify(value),
          usage: { totalTokens: 20 },
          receipt: { id: "synthetic-receipt" },
        };
      if (request.scene === "evaluation.judge")
        return {
          value: {
            score: 100,
            passed: true,
            reason: "synthetic passing judge",
          },
          usage: { totalTokens: 20 },
          receipt: {},
        };
      return {
        content: "synthetic employee answer",
        toolCalls: [],
        usage: { totalTokens: 20 },
        receipt: {},
      };
    },
  };
  const tools = createToolService({ store, model });
  const engine = createEngine({ store, model, tools });
  const modelRecord = store.create("models", {
    name: "review model",
    provider: "test",
    model: "frozen-model",
    secretRef: "test-only",
  });
  const employee = store.create("employees", {
    name: "review employee",
    accessMode: "managed",
  });
  const knowledge = store.create("knowledge", {
    name: "review knowledge",
    content: "frozen knowledge",
    allowedModelEgress: true,
  });
  const tool = store.create("tools", {
    name: "query",
    operation: "query",
    adapter: "simulation",
    mode: "simulated",
  });
  const skill = store.create("skills", {
    name: "review skill",
    content: "frozen skill",
    version: 1,
    toolIds: [tool.id],
    steps: [],
  });
  const version = engine.createVersion(employee.id, {
    prompt: "review employee",
    modelId: modelRecord.id,
    knowledgeIds: [knowledge.id],
    toolIds: [tool.id],
    skillIds: [skill.id],
  });
  store.put("employees", { ...employee, currentVersionId: version.id });
  function dataset(purpose = "dev", count = 1) {
    const d = store.create("datasets", {
      name: "review dataset",
      purpose,
      generated: false,
      caseIds: [],
    });
    const ids = Array.from(
      { length: count },
      (_, i) =>
        store.create("cases", {
          datasetId: d.id,
          name: `review case ${i}`,
          input: `synthetic question ${i}`,
          expected: "synthetic employee answer",
          hidden: purpose === "holdout",
          assertions: [{ type: "no_violation" }],
          initialState: {},
        }).id,
    );
    return store.put("datasets", { ...d, caseIds: ids });
  }
  return {
    store,
    model,
    tools,
    engine,
    employee,
    modelRecord,
    knowledge,
    tool,
    skill,
    version,
    dataset,
    get calls() {
      return completeCalls;
    },
  };
}

test("review: a revoked live model blocks an existing frozen employee before any provider call", async (t) => {
  const f = engineFixture(t);
  const dataset = f.dataset();
  f.store.put("models", { ...f.modelRecord, revoked: true, status: "revoked" });
  await assert.rejects(
    f.engine.executeJob(
      {
        id: "review-revocation",
        type: "evaluate",
        payload: { versionId: f.version.id, datasetId: dataset.id },
      },
      { workspace: "default" },
    ),
  );
  assert.equal(f.calls, 0);
});

test("review: runs with different frozen judge configurations cannot be compared as identical conditions", async (t) => {
  const f = engineFixture(t);
  const dataset = f.dataset();
  const first = await f.engine.executeJob(
    {
      type: "evaluate",
      payload: { versionId: f.version.id, datasetId: dataset.id },
    },
    { workspace: "default" },
  );
  f.store.put("models", { ...f.modelRecord, thinking: "disabled" });
  const candidate = f.engine.createVersion(f.employee.id, {
    parentId: f.version.id,
  });
  const second = await f.engine.executeJob(
    {
      type: "evaluate",
      payload: { versionId: candidate.id, datasetId: dataset.id },
    },
    { workspace: "default" },
  );
  const comparison = f.engine.compareRuns(
    f.store.get("runs", first.runId),
    f.store.get("runs", second.runId),
  );
  assert.equal(comparison.comparable, false);
});

test("review: skill repair preserves all non-skill frozen dependencies despite shared asset drift", async (t) => {
  let boundTool;
  const f = engineFixture(t, (request) =>
    request.scene === "skill_repair"
      ? {
          content: "improved declared skill",
          reason: "synthetic regression repair",
          steps: [{ toolId: boundTool, argsTemplate: {}, onError: "stop" }],
        }
      : null,
  );
  boundTool = f.tool.id;
  const dataset = f.dataset();
  f.store.put("knowledge", {
    ...f.knowledge,
    content: "live drift that must not be adopted",
  });
  f.store.put("tools", { ...f.tool, operation: "delete" });
  f.store.put("models", { ...f.modelRecord, model: "live-drift-model" });
  const advanced = createAdvanced(f);
  const result = await advanced.executeJob(
    {
      type: "skill_repair",
      payload: {
        versionId: f.version.id,
        skillId: f.skill.id,
        datasetId: dataset.id,
      },
    },
    { workspace: "default", jobId: "review-skill-repair" },
  );
  const candidate = f.store.get("versions", result.candidateVersionId);
  for (const key of ["knowledge", "tools", "model"])
    assert.deepEqual(
      candidate.manifest.snapshots[key],
      f.version.manifest.snapshots[key],
      key,
    );
});

test("review: old acceptance cannot deploy a version after a required knowledge asset has been revoked", async (t) => {
  const f = engineFixture(t);
  const dataset = f.dataset("holdout");
  await f.engine.executeJob(
    {
      type: "evaluate",
      payload: { versionId: f.version.id, datasetId: dataset.id },
    },
    { workspace: "default" },
  );
  f.store.put("knowledge", {
    ...f.knowledge,
    revoked: true,
    status: "revoked",
  });
  const advanced = createAdvanced(f);
  await assert.rejects(
    advanced.deploy({
      employeeId: f.employee.id,
      versionId: f.version.id,
      target: "local",
      mode: "simulated",
    }),
    (error) => error.status === 403,
  );
  assert.equal(f.store.list("deployments").length, 0);
});

test("review: concurrent real deployments cannot leave local and observed remote employee versions split", async (t) => {
  const f = engineFixture(t);
  const dataset = f.dataset("holdout", 40);
  const first = f.engine.createVersion(f.employee.id, {
    parentId: f.version.id,
    prompt: "first deployment",
  });
  const second = f.engine.createVersion(f.employee.id, {
    parentId: f.version.id,
    prompt: "second deployment",
  });
  for (const version of [first, second])
    await f.engine.executeJob(
      {
        type: "evaluate",
        payload: { versionId: version.id, datasetId: dataset.id },
        budgetTokens: 100000,
      },
      { workspace: "default" },
    );
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered;
  const entered = new Promise((resolve) => {
    firstEntered = resolve;
  });
  let remoteVersion = f.version.id,
    remoteReceipt;
  f.model.request = async (request) => {
    if (request.method === "POST") {
      if (request.body.versionId === first.id) {
        firstEntered();
        await gate;
      }
      remoteVersion = request.body.versionId;
      remoteReceipt = `synthetic-${remoteVersion}`;
      return { data: { receiptId: remoteReceipt } };
    }
    return { data: { versionId: remoteVersion, receiptId: remoteReceipt } };
  };
  const advanced = createAdvanced(f);
  const pendingFirst = advanced
    .deploy({
      employeeId: f.employee.id,
      versionId: first.id,
      mode: "real",
      target: "https://synthetic.example/deploy",
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await entered;
  const pendingSecond = advanced
    .deploy({
      employeeId: f.employee.id,
      versionId: second.id,
      mode: "real",
      target: "https://synthetic.example/deploy",
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const timer = setTimeout(releaseFirst, 20);
  const [firstResult, secondResult] = await Promise.all([
    pendingFirst,
    pendingSecond,
  ]);
  clearTimeout(timer);
  assert.equal(
    f.store.get("employees", f.employee.id).currentVersionId,
    remoteVersion,
    "local pointer and independently read-back remote version must agree",
  );
  assert.ok(
    firstResult.value || secondResult.value,
    "at least one deployment should commit; competing mutations must be refused or serialized",
  );
});
