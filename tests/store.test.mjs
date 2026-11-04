import test from "node:test";
import assert from "node:assert/strict";
import { createStore, hash } from "../server/store.mjs";

test("workspace isolation covers lists, lookups, references and event chains", () => {
  const s = createStore();
  const x = s.create("knowledge", { name: "A", content: "private" }, "a");
  assert.equal(s.list("knowledge", "b").length, 0);
  assert.throws(() => s.get("knowledge", x.id, "b"), { status: 404 });
  s.put("knowledge", { ...x, content: "new" }, "a", { expectedRevision: 1 });
  assert.equal(s.verifyEvents("a"), true);
  assert.equal(s.events("b").length, 0);
  s.close();
});
test("optimistic revisions reject stale writers and events cannot be edited", () => {
  const s = createStore(),
    r = s.create("employees", { name: "one" });
  s.put("employees", { ...r, name: "two" }, "default", { expectedRevision: 1 });
  assert.throws(
    () =>
      s.put("employees", { ...r, name: "lost" }, "default", {
        expectedRevision: 1,
      }),
    { code: "REVISION_CONFLICT" },
  );
  assert.throws(
    () => s.db.exec("UPDATE events SET kind='tampered'"),
    /append-only/,
  );
  assert.throws(() => s.db.exec("DELETE FROM events"), /append-only/);
  s.close();
});
test("frozen manifests, reports, runs and receipts cannot be overwritten or deleted", () => {
  const s = createStore();
  for (const kind of ["versions", "runs", "reports", "receipts"]) {
    const r = s.create(kind, { name: kind });
    assert.throws(() => s.put(kind, r), { code: "IMMUTABLE_VERSION" });
    assert.throws(() => s.remove(kind, r.id), { code: "IMMUTABLE_VERSION" });
  }
  s.close();
});
test("transactions roll back resources and their appended events together", () => {
  const s = createStore();
  assert.throws(() =>
    s.transaction(() => {
      s.create("employees", { name: "rollback" });
      throw new Error("fail");
    }),
  );
  assert.equal(s.list("employees").length, 0);
  assert.equal(s.events().length, 0);
  s.close();
});
test("idempotency returns the original result and rejects parameter reuse", () => {
  const s = createStore();
  let calls = 0;
  const a = s.idempotent("default", "x", { a: 1 }, () => {
    calls++;
    return { id: "first" };
  });
  const b = s.idempotent("default", "x", { a: 1 }, () => {
    calls++;
    return { id: "second" };
  });
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.throws(() => s.idempotent("default", "x", { a: 2 }, () => ({})), {
    code: "IDEMPOTENCY_CONFLICT",
  });
  s.close();
});
test("secrets and unsafe object fields are rejected before database persistence", () => {
  const s = createStore();
  assert.throws(() => s.create("models", { apiKey: "test-only-key" }), {
    code: "SECRET_IN_RESOURCE",
  });
  assert.throws(() => s.create("tools", JSON.parse('{"__proto__":{"x":1}}')), {
    code: "UNSAFE_KEY",
  });
  assert.equal(s.list("models").length, 0);
  s.close();
});
test("password auth hashes credentials, expires sessions and rejects incorrect credentials", () => {
  const s = createStore();
  s.createUser({
    email: "owner@example.com",
    password: "test-password-123",
    workspace: "private",
    role: "editor",
  });
  assert.throws(() => s.login("owner@example.com", "incorrect"), {
    code: "INVALID_CREDENTIALS",
  });
  const r = s.login("owner@example.com", "test-password-123");
  assert.equal(s.session(r.token).workspace, "private");
  assert.equal(
    s.db
      .prepare("SELECT password_hash FROM users")
      .get()
      .password_hash.includes("test-password"),
    false,
  );
  s.logout(r.token);
  assert.equal(s.session(r.token), null);
  s.close();
});
test("credentials pasted into arbitrary content are rejected before logging or storage", () => {
  const s = createStore();
  assert.throws(
    () =>
      s.create("employees", {
        name: "accidental secret",
        requirements: "sk-" + "a".repeat(32),
      }),
    { code: "SECRET_IN_CONTENT" },
  );
  assert.equal(s.events().length, 0);
  assert.equal(s.list("employees").length, 0);
  s.close();
});
