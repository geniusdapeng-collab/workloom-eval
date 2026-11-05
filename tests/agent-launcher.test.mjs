import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureService } from "../scripts/agent-launcher.mjs";
async function listener(t, response) {
  const server = createServer((q, r) => {
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify(response));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return "http://127.0.0.1:" + server.address().port;
}
test("launcher reuses a healthy platform, refuses old/foreign identity and unsafe URLs", async (t) => {
  const good = await listener(t, {
    product: "workloom-eval",
    version: "1.1.0",
    ok: true,
  });
  assert.equal((await ensureService({ url: good })).reused, true);
  const old = await listener(t, {
    product: "workloom-eval",
    version: "1.0.0",
    ok: true,
  });
  await assert.rejects(
    ensureService({ url: old }),
    (e) => e.code === "SERVICE_UPGRADE_REQUIRED",
  );
  for (const version of ["1", "1.bad", "", null]) {
    const bad = await listener(t, {
      product: "workloom-eval",
      ok: true,
      version,
    });
    await assert.rejects(
      ensureService({ url: bad }),
      (e) => e.code === "SERVICE_UPGRADE_REQUIRED",
    );
  }
  const foreign = await listener(t, {
    product: "other",
    version: "1.1.0",
    ok: true,
  });
  await assert.rejects(
    ensureService({ url: foreign }),
    (e) => e.code === "SERVICE_IDENTITY_MISMATCH",
  );
  await assert.rejects(
    ensureService({ url: "http://remote.example" }),
    (e) => e.code === "UNSAFE_SERVICE_URL",
  );
});
test("concurrent local connections create one real service with persistent state and no stored secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wle-launch-"));
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const url = "http://127.0.0.1:" + port;
  let pid;
  t.after(async () => {
    if (pid)
      try {
        process.kill(pid, "SIGTERM");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    await new Promise((r) => setTimeout(r, 150));
    await rm(dir, { recursive: true, force: true });
  });
  const env = {
    PATH: process.env.PATH,
    EVAL_DB_PATH: join(dir, "eval.sqlite"),
    DEEPSEEK_API_KEY: "fixture-not-a-real-key",
    GH_TOKEN: "fixture-owner-credential",
  };
  const rows = await Promise.all([
    ensureService({ url, root: dir, env }),
    ensureService({ url, root: dir, env }),
  ]);
  assert.equal(rows.filter((r) => !r.reused).length, 1);
  const state = await readFile(
    join(dir, ".runtime", `agent-service-${port}.json`),
    "utf8",
  );
  pid = JSON.parse(state).pid;
  assert.ok(!state.includes("fixture"));
  const response = await fetch(url + "/api/agent/capabilities");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).product, "workloom-eval");
  const log = await readFile(
    join(dir, ".runtime", "agent-service.log"),
    "utf8",
  );
  assert.ok(!log.includes("fixture-owner-credential"));
  assert.ok(!log.includes("fixture-not-a-real-key"));
});
