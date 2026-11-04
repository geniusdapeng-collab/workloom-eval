import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../server/index.mjs";
import { createStore } from "../server/store.mjs";
const headers = { "content-type": "application/json" };
function fixture(t, extra = {}) {
  const store = extra.store || createStore();
  const a = createApplication({
    store,
    disableWorker: true,
    env: { HOST: "127.0.0.1", EVAL_AUTH_MODE: "local" },
    ...extra,
  });
  t.after(() => {
    a.close();
    store.close();
  });
  return a;
}
const req = (a, path, method = "GET", data, h = {}) =>
  a.app.request(`http://localhost${path}`, {
    method,
    headers: { ...headers, ...h },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
test("bootstrap contains persistent resources, explicit real model mode and no fabricated scores", async (t) => {
  const a = fixture(t),
    r = await req(a, "/api/bootstrap"),
    b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.employees.length, 1);
  assert.equal(b.runs.length, 0);
  assert.equal(b.overview.score, null);
  assert.equal(b.models[0].secretConfigured, false);
  assert.equal(b.settings.mode, "real-model-simulated-business");
  assert.ok(
    b.cases.filter((c) => c.hidden).every((c) => !c.input && !c.expected),
  );
  assert.equal(a.store.verifyEvents(), true);
});
test("CSRF, DNS rebinding host and resource-embedded secrets are denied", async (t) => {
  const a = fixture(t);
  assert.equal(
    (
      await req(
        a,
        "/api/resources/employees",
        "POST",
        { name: "x" },
        { origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await a.app.request("http://attacker.example/api/bootstrap")).status,
    403,
  );
  assert.equal(
    (
      await req(a, "/api/resources/models", "POST", {
        name: "bad",
        apiKey: "test-only-key",
      })
    ).status,
    422,
  );
});
test("updates require current revision and generic writes cannot alter frozen versions", async (t) => {
  const a = fixture(t),
    k = a.store.list("knowledge")[0];
  assert.equal(
    (await req(a, `/api/resources/knowledge/${k.id}`, "PUT", { name: "new" }))
      .status,
    422,
  );
  assert.equal(
    (
      await req(a, `/api/resources/knowledge/${k.id}`, "PUT", {
        name: "new",
        expectedRevision: k.revision,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await req(a, `/api/resources/knowledge/${k.id}`, "PUT", {
        name: "lost",
        expectedRevision: k.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (await req(a, "/api/resources/versions/version-aftersale-01", "DELETE"))
      .status,
    403,
  );
});
test("idempotent jobs can be cancelled without starting queued model work", async (t) => {
  const a = fixture(t),
    data = {
      type: "evaluate",
      payload: {
        versionId: "version-aftersale-01",
        datasetId: "dataset-aftersale-dev",
      },
    };
  const x = await (
      await req(a, "/api/jobs", "POST", data, { "idempotency-key": "same" })
    ).json(),
    y = await (
      await req(a, "/api/jobs", "POST", data, { "idempotency-key": "same" })
    ).json();
  assert.equal(x.id, y.id);
  const r = await req(a, `/api/jobs/${x.id}/cancel`, "POST", {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "cancelled");
  assert.equal(
    (await req(a, `/api/jobs/${x.id}/cancel`, "POST", {})).status,
    409,
  );
});
test("password sessions scope workspaces and viewer cannot mutate or read another workspace", async (t) => {
  const store = createStore();
  store.createUser({
    email: "viewer@example.com",
    password: "test-viewer-password",
    workspace: "team-b",
    role: "viewer",
  });
  const a = fixture(t, {
    store,
    env: { HOST: "127.0.0.1", EVAL_AUTH_MODE: "password" },
  });
  assert.equal((await req(a, "/api/bootstrap")).status, 401);
  const login = await req(a, "/api/auth/login", "POST", {
    email: "viewer@example.com",
    password: "test-viewer-password",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0],
    b = await (
      await req(a, "/api/bootstrap", "GET", undefined, { cookie })
    ).json();
  assert.equal(b.employees.length, 0);
  assert.equal(
    (
      await req(
        a,
        "/api/resources/employees",
        "POST",
        { name: "x" },
        { cookie },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await req(
        a,
        "/api/secrets",
        "POST",
        { ref: "x", value: "test-only-key" },
        { cookie },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await req(
        a,
        "/api/versions/version-aftersale-01/export",
        "GET",
        undefined,
        { cookie },
      )
    ).status,
    404,
  );
});
test("runner token only returned once and completion is bound to current lease", async (t) => {
  const a = fixture(t),
    r = await (
      await req(a, "/api/nodes/register", "POST", {
        name: "node",
        capabilities: ["script"],
      })
    ).json();
  assert.ok(r.token);
  assert.equal(r.node.tokenHash, undefined);
  const execution = a.store.create("executions", {
      type: "tool",
      requiredCapability: "script",
      payload: { taskName: "sum" },
      status: "queued",
    }),
    h = { authorization: `Bearer ${r.token}` };
  const claimed = await (
    await req(a, "/api/runner/claim", "POST", {}, h)
  ).json();
  assert.equal(claimed.task.id, execution.id);
  assert.equal(
    (
      await req(
        a,
        "/api/runner/result",
        "POST",
        { taskId: execution.id, leaseId: "wrong", result: 1 },
        h,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await req(
        a,
        "/api/runner/result",
        "POST",
        { taskId: execution.id, leaseId: claimed.task.leaseId, result: 1 },
        h,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await req(
        a,
        "/api/runner/result",
        "POST",
        { taskId: execution.id, leaseId: claimed.task.leaseId, result: 1 },
        h,
      )
    ).status,
    409,
  );
  assert.equal((await req(a, "/api/runner/claim", "POST", {})).status, 401);
});
test("holdout run views redact tool args, outputs, answers, states and judge reasons", async (t) => {
  const a = fixture(t),
    run = a.store.create("runs", {
      versionId: "version-aftersale-01",
      datasetId: "dataset-aftersale-holdout",
      status: "completed",
      metrics: { score: 90 },
      caseResults: [
        {
          caseId: "secret-case",
          passed: true,
          score: 90,
          input: "private-question",
          output: "private-answer",
          steps: [{ arguments: "private-value" }],
          finalState: { secret: 1 },
          assertions: [{ value: "answer" }],
          judge: { reason: "secret" },
        },
      ],
    });
  const r = await (await req(a, `/api/resources/runs/${run.id}`)).json(),
    dump = JSON.stringify(r);
  assert.equal(dump.includes("private"), false);
  assert.equal(dump.includes("finalState"), false);
  assert.equal(r.caseResults[0].redacted, true);
});
test("invalid dataset imports roll back and holdout cannot be exported as training data", async (t) => {
  const a = fixture(t),
    before = a.store.list("datasets").length;
  assert.equal(
    (
      await req(a, "/api/datasets/import", "POST", {
        name: "bad",
        purpose: "dev",
        cases: [{ name: "missing-input", assertions: [] }],
      })
    ).status,
    422,
  );
  assert.equal(a.store.list("datasets").length, before);
  assert.equal(
    (await req(a, "/api/training/export/dataset-aftersale-holdout")).status,
    403,
  );
});
test("unreferenced resources delete cleanly and case membership updates atomically", async (t) => {
  const a = fixture(t);
  const d = await (
    await req(a, "/api/resources/datasets", "POST", {
      name: "temporary",
      purpose: "dev",
    })
  ).json();
  const c = await (
    await req(a, "/api/resources/cases", "POST", {
      name: "case",
      datasetId: d.id,
      input: "input",
      expected: "expected",
      assertions: [],
    })
  ).json();
  assert.ok(a.store.get("datasets", d.id).caseIds.includes(c.id));
  assert.equal(
    (await req(a, `/api/resources/cases/${c.id}`, "DELETE")).status,
    200,
  );
  assert.equal(a.store.get("datasets", d.id).caseIds.length, 0);
  assert.equal(
    (await req(a, `/api/resources/datasets/${d.id}`, "DELETE")).status,
    200,
  );
  const e = await (
    await req(a, "/api/resources/employees", "POST", { name: "unversioned" })
  ).json();
  assert.equal(
    (await req(a, `/api/resources/employees/${e.id}`, "DELETE")).status,
    200,
  );
});
test("concurrency settings reject nonfinite values instead of opening unbounded dispatch", async (t) => {
  const a = fixture(t),
    s = a.store.list("settings")[0];
  assert.equal(
    (
      await req(a, `/api/resources/settings/${s.id}`, "PUT", {
        expectedRevision: s.revision,
        concurrency: "invalid",
      })
    ).status,
    422,
  );
});
test("checkpoints are immutable private evidence and holdout checkpoint API uses a strict allowlist", async (t) => {
  const a = fixture(t);
  const j = a.store.create("jobs", {
    type: "evaluate",
    status: "interrupted",
    payload: { mode: "simulated" },
    budgetTokens: 1000,
    usedTokens: 0,
  });
  const cp = a.store.create("checkpoints", {
    jobId: j.id,
    datasetPurpose: "holdout",
    caseId: "c",
    caseResult: {
      status: "completed",
      passed: true,
      score: 90,
      input: "SEALED_INPUT",
      output: "SEALED_OUTPUT",
      finalState: { answer: "SEALED_STATE" },
    },
  });
  assert.equal(
    (await req(a, `/api/resources/checkpoints/${cp.id}`)).status,
    403,
  );
  const list = await (await req(a, `/api/jobs/${j.id}/checkpoints`)).json();
  assert.equal(JSON.stringify(list).includes("SEALED_"), false);
  assert.equal(list[0].redacted, true);
  assert.throws(() => a.store.put("checkpoints", cp), {
    code: "IMMUTABLE_VERSION",
  });
});
test("node revocation and rotation immediately invalidate old credentials", async (t) => {
  const a = fixture(t),
    r = await (
      await req(a, "/api/nodes/register", "POST", {
        name: "lifecycle",
        capabilities: ["script"],
      })
    ).json();
  const old = { authorization: `Bearer ${r.token}` };
  assert.equal(
    (await req(a, "/api/runner/claim", "POST", {}, old)).status,
    200,
  );
  const rotated = await (
    await req(a, `/api/nodes/${r.node.id}/rotate`, "POST", {})
  ).json();
  assert.notEqual(rotated.token, r.token);
  assert.equal(
    (await req(a, "/api/runner/claim", "POST", {}, old)).status,
    401,
  );
  const current = { authorization: `Bearer ${rotated.token}` };
  assert.equal(
    (await req(a, "/api/runner/claim", "POST", {}, current)).status,
    200,
  );
  assert.equal(
    (await req(a, `/api/nodes/${r.node.id}/revoke`, "POST", {})).status,
    200,
  );
  assert.equal(
    (await req(a, "/api/runner/claim", "POST", {}, current)).status,
    401,
  );
});
test("publishing changed knowledge enqueues a scoped regression only when its workspace switch is enabled", async (t) => {
  const a = fixture(t);
  const settings = a.store.list("settings")[0];
  a.store.put("settings", { ...settings, autoKnowledgeRegression: true });
  const kb = a.store.get("knowledge", "kb-aftersale");
  const r = await req(a, `/api/resources/knowledge/${kb.id}`, "PUT", {
    expectedRevision: kb.revision,
    name: kb.name,
    published: true,
    content: kb.content + " 新修订补充：结果不明先核对回执。",
  });
  assert.equal(r.status, 200);
  const j = a.store.list("jobs")[0];
  assert.equal(j.type, "knowledge_regression");
  assert.equal(j.payload.knowledgeId, kb.id);
  assert.equal(j.workspace, "default");
  assert.equal(j.status, "queued");
});
test("HTTPS reverse proxies use configured public origin and secure cookies without trusting spoofed forwarding headers", async (t) => {
  const store = createStore();
  store.createUser({
    email: "proxy@example.com",
    password: "test-proxy-password",
    role: "admin",
  });
  const a = fixture(t, {
    store,
    env: {
      HOST: "127.0.0.1",
      EVAL_AUTH_MODE: "password",
      EVAL_PUBLIC_ORIGIN: "https://eval.example.com",
    },
  });
  const r = await req(
    a,
    "/api/auth/login",
    "POST",
    { email: "proxy@example.com", password: "test-proxy-password" },
    { origin: "https://eval.example.com" },
  );
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("set-cookie").includes("Secure"));
  assert.equal(
    (
      await req(
        a,
        "/api/auth/login",
        "POST",
        { email: "proxy@example.com", password: "test-proxy-password" },
        { origin: "https://attacker.example", "x-forwarded-proto": "https" },
      )
    ).status,
    403,
  );
});
test("forwarded-for spoofing does not bypass per-account login throttling", async (t) => {
  const a = fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await req(
          a,
          "/api/auth/login",
          "POST",
          { email: "nobody@example.com", password: "wrong" },
          { "x-forwarded-for": `192.0.2.${i}` },
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await req(
        a,
        "/api/auth/login",
        "POST",
        { email: "nobody@example.com", password: "wrong" },
        { "x-forwarded-for": "198.51.100.1" },
      )
    ).status,
    429,
  );
});
