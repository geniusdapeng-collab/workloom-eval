import test from "node:test";
import assert from "node:assert/strict";
import { createApplication } from "../server/index.mjs";
import { createStore } from "../server/store.mjs";

function fixture(t, remote = false) {
  const store = createStore();
  const a = createApplication({
    store,
    disableWorker: true,
    env: {
      HOST: "127.0.0.1",
      EVAL_AUTH_MODE: remote ? "password" : "local",
      EVAL_ADMIN_PASSWORD: "test-admin-password",
    },
  });
  t.after(() => {
    a.close();
    store.close();
  });
  return a;
}
function req(a, path, method = "GET", data, extra = {}) {
  return a.app.request("http://localhost" + path, {
    method,
    headers: { "content-type": "application/json", ...extra },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
async function issue(a, role = "editor", headers = {}) {
  const r = await req(
    a,
    "/api/agent/tokens",
    "POST",
    { name: "integration test", role },
    headers,
  );
  assert.equal(r.status, 201);
  return r.json();
}
test("capabilities are authenticated and identify supported workflows without keys", async (t) => {
  const a = fixture(t);
  const c = await (await req(a, "/api/agent/capabilities")).json();
  assert.equal(c.product, "workloom-eval");
  assert.equal(c.jobTypes.length, 14);
  assert.equal(c.rules.jobSubmissionIsCompletion, false);
  const remote = fixture(t, true);
  assert.equal((await req(remote, "/api/agent/capabilities")).status, 401);
});
test("bearer hash-only issuance, editor permissions and bad-token fail-closed in local mode", async (t) => {
  const a = fixture(t);
  const { token, credential } = await issue(a);
  const h = { authorization: "Bearer " + token };
  assert.equal(
    (
      await req(
        a,
        "/api/resources/employees",
        "POST",
        { name: "Agent employee" },
        h,
      )
    ).status,
    201,
  );
  assert.equal(
    (await req(a, "/api/resources/models", "POST", { name: "denied" }, h))
      .status,
    403,
  );
  assert.equal(
    (
      await req(
        a,
        "/api/agent/tokens",
        "POST",
        { name: "escalate", role: "admin" },
        h,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await req(a, "/api/status", "GET", undefined, {
        authorization: "Bearer invalid",
      })
    ).status,
    401,
  );
  const rows = a.store.db.prepare("SELECT * FROM agent_tokens").all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(token));
  assert.ok(!JSON.stringify(a.store.events()).includes(token));
  const list = await (await req(a, "/api/agent/tokens")).json();
  assert.equal(list[0].id, credential.id);
  assert.ok(!JSON.stringify(list).includes("token_hash"));
  assert.equal(
    (
      await req(
        a,
        "/api/resources/knowledge",
        "POST",
        { name: "secret", content: token },
        h,
      )
    ).status,
    422,
  );
});
test("viewer tokens cannot mutate, expiry and revocation take effect immediately", async (t) => {
  const a = fixture(t);
  const x = await issue(a, "viewer"),
    h = { authorization: "Bearer " + x.token };
  assert.equal((await req(a, "/api/status", "GET", undefined, h)).status, 200);
  assert.equal(
    (await req(a, "/api/jobs", "POST", { type: "evaluate", payload: {} }, h))
      .status,
    403,
  );
  a.store.db
    .prepare("UPDATE agent_tokens SET expires_at=0 WHERE id=?")
    .run(x.credential.id);
  assert.equal((await req(a, "/api/status", "GET", undefined, h)).status, 401);
  const y = await issue(a);
  assert.equal(
    (await req(a, "/api/agent/tokens/" + y.credential.id, "DELETE")).status,
    200,
  );
  assert.equal(
    (
      await req(a, "/api/status", "GET", undefined, {
        authorization: "Bearer " + y.token,
      })
    ).status,
    401,
  );
});
test("password-issued credentials retain tenant and current owner role restrictions", async (t) => {
  const a = fixture(t, true);
  const admin = a.store.createUser({
    email: "agent-owner@example.test",
    password: "test-owner-password",
    workspace: "other",
    role: "admin",
  });
  const login = a.store.login(admin.email, "test-owner-password"),
    cookie = { cookie: "eval_session=" + login.token };
  const x = await issue(a, "admin", cookie),
    h = { authorization: "Bearer " + x.token };
  const session = await (
    await req(a, "/api/session", "GET", undefined, h)
  ).json();
  assert.equal(session.workspace, "other");
  assert.equal(
    (
      await req(
        a,
        "/api/resources/employees/employee-aftersale",
        "GET",
        undefined,
        h,
      )
    ).status,
    404,
  );
  assert.equal(
    (await req(a, "/api/agent/tokens", "GET", undefined, h)).status,
    403,
  );
  a.store.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(admin.id);
  assert.equal(
    (await req(a, "/api/resources/employees", "POST", { name: "no" }, h))
      .status,
    403,
  );
  a.store.db
    .prepare("UPDATE users SET workspace='moved' WHERE id=?")
    .run(admin.id);
  assert.equal((await req(a, "/api/status", "GET", undefined, h)).status, 401);
});
test("agent credential fields reject invalid role, oversized names and TTLs", async (t) => {
  const a = fixture(t);
  for (const data of [
    { name: "" },
    { name: "x", role: "owner" },
    { name: "x", expiresInSeconds: 1 },
    { name: "x", expiresInSeconds: 7776001 },
    { name: "x", expiresInSeconds: Infinity },
  ])
    assert.equal((await req(a, "/api/agent/tokens", "POST", data)).status, 422);
  assert.equal(
    (await req(a, "/api/agent/tokens/missing", "DELETE")).status,
    404,
  );
});
