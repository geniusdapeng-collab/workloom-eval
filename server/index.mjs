import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStore,
  HttpError,
  resourceKinds,
  immutableKinds,
  hash,
  validateData,
} from "./store.mjs";
import { createModel, MODEL_REGISTRY } from "./model.mjs";
import { seed } from "./seed.mjs";
import { createToolService } from "./tools.mjs";
import { createEngine } from "./engine.mjs";
import { createAdvanced } from "./advanced.mjs";
import { createAgentAccess } from "./agent-access.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VERSION = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8"),
).version;
const mutableKinds = new Set([
  "employees",
  "knowledge",
  "tools",
  "skills",
  "models",
  "datasets",
  "cases",
  "teams",
  "memories",
  "experiences",
  "settings",
]);
const ADMIN_KINDS = new Set(["models", "tools", "settings", "approvals"]);
const ENGINE_JOBS = new Set([
  "create_employee",
  "evaluate",
  "optimize",
  "team_evaluate",
  "memory_evaluate",
]);
const ADVANCED_JOBS = new Set([
  "fine_tune",
  "poll_training",
  "shadow_evaluate",
  "skill_repair",
  "browser_evaluate",
  "benchmark_portfolio",
  "long_horizon",
  "reconcile_deployment",
  "knowledge_regression",
]);
const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const safePublic = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, v) =>
      /^(tokenHash|password_hash|salt|reasoning_content|authorization|apiKey|accessToken)$/i.test(
        key,
      )
        ? undefined
        : v,
    ),
  );
export function createApplication(options = {}) {
  const env = options.env || process.env,
    host = env.HOST || "127.0.0.1",
    port = Number(env.PORT || 4317),
    localMode = (env.EVAL_AUTH_MODE || "local") === "local";
  if (localMode && !["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error(
      "Local auth can only bind loopback. Configure password mode for remote deployment.",
    );
  const publicOrigin = env.EVAL_PUBLIC_ORIGIN
    ? new URL(env.EVAL_PUBLIC_ORIGIN).origin
    : null;
  if (publicOrigin && !publicOrigin.startsWith("https://"))
    throw new Error("EVAL_PUBLIC_ORIGIN must use HTTPS.");
  const store =
    options.store ||
    createStore(env.EVAL_DB_PATH || resolve(ROOT, ".runtime/eval.sqlite"));
  const secrets = new Map(),
    networkPolicy = {
      allowedHosts: [
        "api.deepseek.com",
        ...(env.EVAL_ALLOWED_HOSTS || "").split(",").filter(Boolean),
      ],
      allowPrivateHosts: (env.EVAL_PRIVATE_HOSTS || "")
        .split(",")
        .filter(Boolean),
      allowInsecure: env.EVAL_ALLOW_HTTP === "1",
    };
  const model =
    options.model ||
    createModel({
      store,
      secrets,
      envSecrets: { "env:DEEPSEEK_API_KEY": env.DEEPSEEK_API_KEY },
      networkPolicy,
    });
  const tools =
    options.tools || createToolService({ store, model, networkPolicy });
  const engine = options.engine || createEngine({ store, model, tools });
  const advanced =
    options.advanced || createAdvanced({ store, model, tools, engine });
  seed(store);
  if (!localMode && !store.userCount()) {
    if (!env.EVAL_ADMIN_PASSWORD)
      throw new Error(
        "EVAL_ADMIN_PASSWORD is required to bootstrap password authentication.",
      );
    store.createUser({
      email: env.EVAL_ADMIN_EMAIL || "admin@workloom.local",
      password: env.EVAL_ADMIN_PASSWORD,
      role: "admin",
    });
  }
  const app = new Hono(),
    active = new Map(),
    loginAttempts = new Map();
  const agentAccess = createAgentAccess({ store, localMode });
  let pumping = false,
    closed = false;
  const allJobs = () =>
    store.db
      .prepare(
        "SELECT data FROM resources WHERE kind='jobs' ORDER BY created_at",
      )
      .all()
      .map((r) => JSON.parse(r.data));
  for (const j of allJobs())
    if (j.status === "running")
      store.put(
        "jobs",
        {
          ...j,
          status: "interrupted",
          error: {
            code: "PROCESS_RESTARTED",
            message: "执行进程重启，历史尝试已保留；请核对外部状态后重新运行",
          },
        },
        j.workspace,
      );
  for (const row of store.db
    .prepare("SELECT data FROM resources WHERE kind='deployments'")
    .all()) {
    const d = JSON.parse(row.data);
    if (["deploying", "rolling_back"].includes(d.status))
      store.put(
        "deployments",
        {
          ...d,
          status: d.mode === "simulated" ? "failed" : "uncertain",
          reconciliationRequired: d.mode !== "simulated",
          error: {
            code: "PROCESS_RESTARTED",
            message: "部署进程中断，需核对远端版本，不会自动重复提交",
          },
        },
        d.workspace,
      );
  }
  function requireRole(c, role = "editor") {
    const u = c.get("user");
    if (!u) throw new HttpError(401, "LOGIN_REQUIRED", "请先登录");
    if (u.role === "viewer" || (role === "admin" && u.role !== "admin"))
      throw new HttpError(403, "PERMISSION_DENIED", "当前角色无权执行该操作");
    return u;
  }
  function workspace(c) {
    return c.get("user")?.workspace || "default";
  }
  async function body(c) {
    let value;
    try {
      value = await c.req.json();
    } catch {
      throw new HttpError(422, "INVALID_JSON", "请求内容不是有效JSON");
    }
    validateData(value);
    return value;
  }
  function visibleRun(run, ws) {
    const out = safePublic(run);
    let holdout =
      run.manifest?.datasetPurpose === "holdout" ||
      run.caseResults?.some((r) => r.hidden);
    try {
      holdout ||=
        store.get("datasets", run.datasetId, ws).purpose === "holdout";
    } catch {
      if (run.datasetId) holdout = true;
    }
    if (holdout)
      out.caseResults = (out.caseResults || []).map((r) => ({
        caseId: r.caseId,
        status: r.status,
        passed: r.passed,
        score: r.score,
        latencyMs: r.latencyMs,
        redacted: true,
      }));
    return out;
  }
  function clean(kind, obj, ws) {
    const out = safePublic(obj);
    if (kind === "models")
      return {
        ...out,
        secretConfigured: model.secretConfigured?.(obj.secretRef, ws) || false,
      };
    if (kind === "cases") {
      let hidden = obj.hidden;
      try {
        hidden ||=
          store.get("datasets", obj.datasetId, ws).purpose === "holdout";
      } catch {
        hidden = true;
      }
      if (hidden)
        return {
          id: obj.id,
          name: "封存验收用例",
          datasetId: obj.datasetId,
          hidden: true,
          revision: obj.revision,
        };
    }
    if (kind === "runs") return visibleRun(obj, ws);
    if (kind === "reports") {
      let holdout = false;
      try {
        const run = store.get("runs", obj.runId, ws);
        holdout =
          run.manifest?.datasetPurpose === "holdout" ||
          store.get("datasets", run.datasetId, ws).purpose === "holdout";
      } catch {
        holdout = true;
      }
      if (holdout)
        return {
          id: obj.id,
          versionId: obj.versionId,
          runId: obj.runId,
          title: obj.title,
          metrics: obj.metrics,
          recommendation: obj.recommendation,
          limitations: ["封存验收只展示聚合结果，细节不会反馈给优化器"],
          redacted: true,
        };
    }
    if (kind === "executions")
      return {
        id: obj.id,
        type: obj.type,
        status: obj.status,
        nodeId: obj.nodeId,
      };
    return out;
  }
  function validateReferences(kind, obj, ws) {
    const refs =
      kind === "teams"
        ? (obj.members || []).flatMap((m) => [
            ["employees", m.employeeId],
            ["versions", m.versionId],
          ])
        : kind === "cases"
          ? [["datasets", obj.datasetId]]
          : kind === "memories"
            ? [["employees", obj.employeeId]]
            : kind === "skills"
              ? (obj.toolIds || []).map((x) => ["tools", x])
              : [];
    for (const [k, v] of refs) if (v) store.get(k, v, ws);
  }
  function validateResource(kind, obj, ws) {
    if (!mutableKinds.has(kind))
      throw new HttpError(403, "RESOURCE_WRITE_DENIED", "该资源由专用流程产生");
    if (
      kind !== "settings" &&
      (!obj.name || typeof obj.name !== "string" || obj.name.length > 160)
    )
      throw new HttpError(422, "NAME_REQUIRED", "请填写不超过160字的名称");
    if (
      kind === "datasets" &&
      !["train", "dev", "validation", "holdout"].includes(obj.purpose)
    )
      throw new HttpError(422, "DATASET_PURPOSE", "测试集用途无效");
    if (kind === "knowledge" && typeof obj.content !== "string")
      throw new HttpError(422, "KNOWLEDGE_CONTENT", "知识内容必须为文本");
    if (kind === "cases" && (!obj.input || !Array.isArray(obj.assertions)))
      throw new HttpError(422, "CASE_INVALID", "场景需要输入与断言数组");
    if (
      kind === "settings" &&
      (!Number.isInteger(Number(obj.concurrency)) ||
        Number(obj.concurrency) < 1 ||
        Number(obj.concurrency) > 5)
    )
      throw new HttpError(422, "CONCURRENCY_INVALID", "并发必须为1至5的整数");
    if (kind === "models") {
      if (!obj.model || !obj.baseUrl || !obj.secretRef)
        throw new HttpError(
          422,
          "MODEL_INVALID",
          "模型需要标识、地址和密钥引用",
        );
      const u = new URL(obj.baseUrl);
      if (u.username || u.password || u.protocol !== "https:")
        throw new HttpError(
          422,
          "MODEL_URL_INVALID",
          "模型地址需要无凭据HTTPS",
        );
    }
    validateReferences(kind, obj, ws);
  }
  function queue(type, payload, ws, budgetTokens, idempotency) {
    if (!ENGINE_JOBS.has(type) && !ADVANCED_JOBS.has(type))
      throw new HttpError(422, "JOB_TYPE_INVALID", "任务类型无效");
    const budget = Number(budgetTokens || payload.budgetTokens || 1000000);
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 50000000)
      throw new HttpError(
        422,
        "BUDGET_INVALID",
        "任务token预算应为1至50000000",
      );
    return store.idempotent(ws, idempotency, { type, payload, budget }, () =>
      store.create(
        "jobs",
        {
          type,
          payload,
          status: "queued",
          progress: 0,
          usedTokens: 0,
          budgetTokens: budget,
          cancelRequested: false,
        },
        ws,
      ),
    );
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      const settings = store.list("settings")[0],
        rawLimit = Number(settings?.concurrency || 2),
        limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(5, rawLimit))
          : 2;
      for (const j of allJobs()) {
        if (active.size >= limit) break;
        if (j.status !== "queued") continue;
        const controller = new AbortController();
        active.set(j.id, controller);
        const ws = j.workspace;
        store.put(
          "jobs",
          { ...j, status: "running", startedAt: new Date().toISOString() },
          ws,
        );
        const ctx = {
          workspace: ws,
          signal: controller.signal,
          jobId: j.id,
          onProgress: (progress, message) => {
            const current = store.get("jobs", j.id, ws);
            store.put(
              "jobs",
              {
                ...current,
                progress: Math.min(99, Math.max(0, progress)),
                message,
              },
              ws,
            );
          },
        };
        Promise.resolve()
          .then(() =>
            model.withBudget
              ? model.withBudget(j, () =>
                  ENGINE_JOBS.has(j.type)
                    ? engine.executeJob(j, ctx)
                    : advanced.executeJob(j, ctx),
                )
              : ENGINE_JOBS.has(j.type)
                ? engine.executeJob(j, ctx)
                : advanced.executeJob(j, ctx),
          )
          .then((result) => {
            const current = store.get("jobs", j.id, ws);
            store.put(
              "jobs",
              {
                ...current,
                status: controller.signal.aborted ? "cancelled" : "completed",
                progress: controller.signal.aborted ? current.progress : 100,
                result: safePublic(result),
                completedAt: new Date().toISOString(),
              },
              ws,
            );
          })
          .catch((error) => {
            const current = store.get("jobs", j.id, ws);
            store.put(
              "jobs",
              {
                ...current,
                status: controller.signal.aborted ? "cancelled" : "failed",
                error: {
                  code: error.code || "EXECUTION_FAILED",
                  message: String(error.message || "执行失败").slice(0, 500),
                },
                completedAt: new Date().toISOString(),
              },
              ws,
            );
          })
          .finally(() => {
            active.delete(j.id);
            queueMicrotask(pump);
          });
      }
    } finally {
      pumping = false;
    }
  }
  const timer = options.disableWorker
    ? null
    : setInterval(() => void pump(), 500);
  timer?.unref();
  app.onError((err, c) => {
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    return c.json(
      {
        error: {
          code: err.code || "INTERNAL_ERROR",
          message:
            status === 500
              ? "服务暂时无法完成请求"
              : String(err.message || "请求失败"),
          ...(err.details ? { details: safePublic(err.details) } : {}),
        },
      },
      status,
    );
  });
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
    );
    await next();
  });
  app.use("/api/*", async (c, next) => {
    if (Number(c.req.header("content-length") || 0) > 16 * 1024 * 1024)
      throw new HttpError(413, "BODY_TOO_LARGE", "请求内容过大");
    const hostHeader = c.req.header("host") || new URL(c.req.url).host;
    if (
      localMode &&
      !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHeader)
    )
      throw new HttpError(403, "HOST_DENIED", "本地工作区拒绝非本机主机名");
    const origin = c.req.header("origin");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      origin &&
      origin !== (publicOrigin || new URL(c.req.url).origin)
    )
      throw new HttpError(403, "ORIGIN_DENIED", "请求来源不匹配");
    if (c.req.path.startsWith("/api/runner/")) return next();
    if (c.req.path === "/api/auth/login" || c.req.path === "/api/health")
      return next();
    const authorization = c.req.header("authorization");
    const agent = authorization
      ? agentAccess.authenticate(authorization)
      : null;
    const user =
      agent?.user ||
      (localMode
        ? {
            id: "local-owner",
            email: "local@workloom",
            workspace: "default",
            role: "admin",
          }
        : store.session(getCookie(c, "eval_session")));
    if (!user && c.req.path !== "/api/session")
      throw new HttpError(401, "LOGIN_REQUIRED", "请先登录");
    c.set("user", user);
    if (agent) c.set("agentCredentialId", agent.credentialId);
    await next();
  });
  app.get("/api/health", (c) =>
    c.json({ ok: true, product: "workloom-eval", version: VERSION }),
  );
  app.get("/api/agent/capabilities", (c) =>
    c.json({
      product: "workloom-eval",
      version: VERSION,
      apiVersion: "1",
      workspace: workspace(c),
      role: c.get("user")?.role,
      authentication: ["local-loopback", "session-cookie", "scoped-bearer"],
      jobTypes: [...ENGINE_JOBS, ...ADVANCED_JOBS],
      endpoints: {
        jobs: "/api/jobs",
        resources: "/api/resources/:kind",
        reports: "/api/reports/:id/export",
        versions: "/api/versions/:id/export",
      },
      workflow: [
        "discover",
        "configure-assets",
        "create_employee",
        "evaluate",
        "optimize",
        "read-report",
      ],
      rules: {
        sealedDataRedacted: true,
        productionWritesRequireApproval: true,
        writeRetriesAutomatic: false,
        jobSubmissionIsCompletion: false,
      },
    }),
  );
  function credentialManager(c) {
    const u = requireRole(c, "admin");
    if (c.get("agentCredentialId"))
      throw new HttpError(
        403,
        "AGENT_CREDENTIAL_MANAGEMENT_DENIED",
        "请使用管理员会话管理Agent凭据，Bearer凭据不能铸造其他凭据",
      );
    return u;
  }
  app.get("/api/agent/tokens", (c) => {
    credentialManager(c);
    return c.json(agentAccess.list(workspace(c)));
  });
  app.post("/api/agent/tokens", async (c) => {
    const u = credentialManager(c);
    return c.json(agentAccess.issue(u, await body(c)), 201);
  });
  app.delete("/api/agent/tokens/:id", (c) => {
    credentialManager(c);
    return c.json(agentAccess.revoke(workspace(c), c.req.param("id")));
  });
  app.get("/api/session", (c) =>
    c.json({
      user: c.get("user") || null,
      workspace: workspace(c),
      role: c.get("user")?.role,
      localMode,
    }),
  );
  app.post("/api/auth/login", async (c) => {
    const b = await c.req.json();
    const addr = String(b.email || "")
        .toLowerCase()
        .slice(0, 256),
      previous = loginAttempts.get(addr) || { count: 0, time: Date.now() };
    if (Date.now() - previous.time > 600000) {
      previous.count = 0;
      previous.time = Date.now();
    }
    previous.count++;
    loginAttempts.set(addr, previous);
    if (previous.count > 10)
      throw new HttpError(429, "LOGIN_RATE_LIMIT", "尝试次数过多，请稍后重试");
    if (loginAttempts.size > 1000)
      for (const [key, attempt] of loginAttempts)
        if (Date.now() - attempt.time > 600000) loginAttempts.delete(key);
    if (loginAttempts.size > 5000)
      throw new HttpError(429, "LOGIN_RATE_LIMIT", "登录队列繁忙，请稍后重试");
    const r = store.login(b.email, b.password);
    setCookie(c, "eval_session", r.token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: Boolean(publicOrigin) || new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: 43200,
    });
    return c.json({ user: r.user });
  });
  app.post("/api/auth/logout", (c) => {
    store.logout(getCookie(c, "eval_session"));
    deleteCookie(c, "eval_session");
    return c.json({ ok: true });
  });
  app.get("/api/status", (c) =>
    c.json({
      ok: true,
      modelConfigured: model.available(workspace(c)).length > 0,
      registry: MODEL_REGISTRY,
      localMode,
      activeJobs: active.size,
      ledgerValid: store.verifyEvents(workspace(c)),
    }),
  );
  app.get("/api/bootstrap", (c) => {
    const ws = workspace(c),
      data = {};
    for (const kind of resourceKinds)
      if (
        ![
          "receipts",
          "executions",
          "approvals",
          "settings",
          "checkpoints",
        ].includes(kind)
      )
        data[kind] = store.list(kind, ws).map((x) => clean(kind, x, ws));
    const completed = data.runs.filter(
        (r) => r.status === "completed" || r.status === "complete",
      ),
      recent = completed[0];
    data.settings = {
      ...store.list("settings", ws)[0],
      modelConfigured: model.available(ws).length > 0,
      localMode,
      registry: MODEL_REGISTRY,
    };
    data.overview = {
      employees: data.employees.length,
      versions: data.versions.length,
      runs: data.runs.length,
      activeJobs: data.jobs.filter((j) =>
        ["running", "queued"].includes(j.status),
      ).length,
      score: recent?.metrics?.score ?? null,
      passRate: recent?.metrics?.passRate ?? null,
      tokens: data.jobs.reduce((a, j) => a + Number(j.usedTokens || 0), 0),
      ledgerValid: store.verifyEvents(ws),
    };
    return c.json(data);
  });
  app.get("/api/resources/:kind", (c) => {
    const k = c.req.param("kind");
    if (
      [
        "receipts",
        "executions",
        "approvals",
        "settings",
        "checkpoints",
      ].includes(k)
    )
      throw new HttpError(403, "RESOURCE_PRIVATE", "请使用专用接口");
    return c.json(
      store.list(k, workspace(c)).map((x) => clean(k, x, workspace(c))),
    );
  });
  app.get("/api/resources/:kind/:id", (c) => {
    const k = c.req.param("kind");
    if (["executions", "approvals", "checkpoints"].includes(k))
      throw new HttpError(403, "RESOURCE_PRIVATE", "请使用专用接口");
    return c.json(
      clean(k, store.get(k, c.req.param("id"), workspace(c)), workspace(c)),
    );
  });
  app.post("/api/resources/:kind", async (c) => {
    const k = c.req.param("kind");
    requireRole(c, ADMIN_KINDS.has(k) ? "admin" : "editor");
    const b = await body(c);
    delete b.workspace;
    delete b.id;
    if (k === "employees" && b.currentVersionId)
      throw new HttpError(
        403,
        "VERSION_POINTER_MANAGED",
        "员工生效版本由部署流程管理",
      );
    if (k === "datasets") b.caseIds = [];
    if (k === "cases") {
      const d = store.get("datasets", b.datasetId, workspace(c));
      b.hidden = d.purpose === "holdout" || Boolean(b.hidden);
      b.partition = d.purpose;
    }
    validateResource(k, b, workspace(c));
    const created = store.transaction(() => {
      const r = store.create(k, b, workspace(c));
      if (k === "employees" && b.currentVersionId)
        throw new HttpError(
          403,
          "VERSION_POINTER_MANAGED",
          "员工生效版本由部署流程管理",
        );
      if (k === "datasets") b.caseIds = [];
      if (k === "cases") {
        const d = store.get("datasets", r.datasetId, workspace(c));
        store.put(
          "datasets",
          { ...d, caseIds: [...new Set([...(d.caseIds || []), r.id])] },
          workspace(c),
        );
      }
      return r;
    });
    return c.json(clean(k, created, workspace(c)), 201);
  });
  app.put("/api/resources/:kind/:id", async (c) => {
    const k = c.req.param("kind");
    requireRole(c, ADMIN_KINDS.has(k) ? "admin" : "editor");
    const b = await body(c),
      old = store.get(k, c.req.param("id"), workspace(c));
    if (b.expectedRevision === undefined)
      throw new HttpError(422, "REVISION_REQUIRED", "更新需提供预期修订号");
    const expectedRevision = b.expectedRevision;
    if (
      k === "employees" &&
      b.currentVersionId !== undefined &&
      b.currentVersionId !== old.currentVersionId
    )
      throw new HttpError(
        403,
        "VERSION_POINTER_MANAGED",
        "员工生效版本只能通过部署与回退流程更新",
      );
    if (
      k === "cases" &&
      (old.hidden ||
        store.get("datasets", old.datasetId, workspace(c)).purpose ===
          "holdout")
    )
      throw new HttpError(
        403,
        "SEALED_CASE",
        "封存用例不能通过通用编辑接口读取或修改，请新建独立测试集",
      );
    if (
      k === "cases" &&
      b.datasetId !== undefined &&
      b.datasetId !== old.datasetId
    )
      throw new HttpError(
        409,
        "CASE_PARTITION_IMMUTABLE",
        "场景所属测试集不可改变，请新建保留来源的场景",
      );
    if (
      k === "datasets" &&
      b.caseIds !== undefined &&
      JSON.stringify(b.caseIds) !== JSON.stringify(old.caseIds)
    )
      throw new HttpError(
        409,
        "CASE_MEMBERSHIP_MANAGED",
        "测试集成员由场景接口管理",
      );
    if (k === "datasets")
      for (const key of [
        "purpose",
        "generated",
        "source",
        "sourceRequirementsHash",
      ])
        if (
          b[key] !== undefined &&
          JSON.stringify(b[key]) !== JSON.stringify(old[key])
        )
          throw new HttpError(
            409,
            "DATASET_PARTITION_IMMUTABLE",
            "数据用途和来源不可重写，请创建新测试集",
          );
    if (
      k === "cases" &&
      b.hidden !== undefined &&
      b.hidden !== old.hidden &&
      old.hidden
    )
      throw new HttpError(403, "SEALED_CASE", "隐藏标记不可取消");
    delete b.expectedRevision;
    delete b.workspace;
    const next = { ...old, ...b, id: old.id };
    validateResource(k, next, workspace(c));
    const saved = store.transaction(() => {
      const r = store.put(k, next, workspace(c), { expectedRevision });
      if (
        k === "knowledge" &&
        r.published &&
        (r.content !== old.content || !old.published) &&
        store.list("settings", workspace(c))[0]?.autoKnowledgeRegression
      ) {
        queue(
          "knowledge_regression",
          { knowledgeId: r.id, sourceRevision: r.revision },
          workspace(c),
          store.list("settings", workspace(c))[0]?.defaultBudgetTokens,
          `knowledge-${r.id}-${r.revision}`,
        );
      }
      if (k === "cases" && old.datasetId !== r.datasetId) {
        const before = store.get("datasets", old.datasetId, workspace(c)),
          after = store.get("datasets", r.datasetId, workspace(c));
        store.put(
          "datasets",
          {
            ...before,
            caseIds: (before.caseIds || []).filter((id) => id !== r.id),
          },
          workspace(c),
        );
        store.put(
          "datasets",
          { ...after, caseIds: [...new Set([...(after.caseIds || []), r.id])] },
          workspace(c),
        );
      }
      return r;
    });
    return c.json(clean(k, saved, workspace(c)));
  });
  app.delete("/api/resources/:kind/:id", (c) => {
    const k = c.req.param("kind");
    requireRole(c, ADMIN_KINDS.has(k) ? "admin" : "editor");
    if (!mutableKinds.has(k))
      throw new HttpError(403, "RESOURCE_WRITE_DENIED", "资源不可删除");
    return c.json(
      store.transaction(() => {
        const old = store.get(k, c.req.param("id"), workspace(c));
        if (
          k === "cases" &&
          (old.hidden ||
            store.get("datasets", old.datasetId, workspace(c)).purpose ===
              "holdout")
        )
          throw new HttpError(
            403,
            "SEALED_CASE",
            "封存用例不可通过通用接口删除",
          );
        const result = store.remove(k, old.id, workspace(c));
        if (k === "cases") {
          const d = store.get("datasets", old.datasetId, workspace(c));
          store.put(
            "datasets",
            { ...d, caseIds: (d.caseIds || []).filter((id) => id !== old.id) },
            workspace(c),
          );
        }
        return result;
      }),
    );
  });
  app.post("/api/versions", async (c) => {
    requireRole(c);
    const b = await body(c);
    return c.json(engine.createVersion(b.employeeId, b, workspace(c)), 201);
  });
  app.post("/api/jobs", async (c) => {
    requireRole(c);
    const b = await body(c);
    if (b.type === "reconcile_deployment") requireRole(c, "admin");
    const j = queue(
      b.type,
      b.payload || {},
      workspace(c),
      b.budgetTokens,
      c.req.header("idempotency-key"),
    );
    if (!options.disableWorker) queueMicrotask(pump);
    return c.json(j, 202);
  });
  app.get("/api/jobs/:id", (c) =>
    c.json(store.get("jobs", c.req.param("id"), workspace(c))),
  );
  app.get("/api/jobs/:id/checkpoints", (c) => {
    const ws = workspace(c),
      j = store.get("jobs", c.req.param("id"), ws);
    return c.json(
      store
        .list("checkpoints", ws)
        .filter((p) => p.jobId === j.id)
        .map((p) => {
          if (p.datasetPurpose === "holdout" || p.caseResult?.hidden)
            return {
              id: p.id,
              jobId: p.jobId,
              caseId: p.caseId,
              repeat: p.repeat,
              completedAt: p.completedAt,
              redacted: true,
              caseResult: {
                status: p.caseResult?.status,
                score: p.caseResult?.score,
                passed: p.caseResult?.passed,
              },
            };
          return safePublic(p);
        }),
    );
  });
  app.post("/api/jobs/:id/resume", (c) => {
    requireRole(c);
    const ws = workspace(c),
      old = store.get("jobs", c.req.param("id"), ws);
    if (
      old.type !== "evaluate" ||
      !["interrupted", "failed", "cancelled"].includes(old.status) ||
      (old.payload.mode && old.payload.mode !== "simulated")
    )
      throw new HttpError(
        409,
        "JOB_NOT_RESUMABLE",
        "仅中断的仿真评测可以继续，结果不明的真实写任务需要先核对",
      );
    if ((model.unresolved?.(ws) || []).some((r) => r.jobId === old.id))
      throw new HttpError(
        409,
        "UNRESOLVED_ATTEMPT",
        "该任务存在未核对供应商请求，请先核对用量与终态",
      );
    const checkpoints = store
      .list("checkpoints", ws)
      .filter((p) => p.jobId === old.id);
    if (!checkpoints.length)
      throw new HttpError(
        409,
        "NO_CHECKPOINT",
        "没有可复用的完成场景，请重新创建评测任务",
      );
    const remaining = old.budgetTokens - Number(old.usedTokens || 0);
    if (remaining < 1)
      throw new HttpError(429, "BUDGET_EXCEEDED", "原任务预算已耗尽");
    const j = queue(
      "evaluate",
      { ...old.payload, mode: "simulated", resumeFromJobId: old.id },
      ws,
      remaining,
      c.req.header("idempotency-key"),
    );
    if (!options.disableWorker) queueMicrotask(pump);
    return c.json(j, 202);
  });
  app.post("/api/jobs/:id/cancel", (c) => {
    requireRole(c);
    const j = store.get("jobs", c.req.param("id"), workspace(c));
    if (!["queued", "running"].includes(j.status))
      throw new HttpError(409, "JOB_TERMINAL", "任务已结束");
    active.get(j.id)?.abort(new HttpError(499, "CANCELLED", "用户取消任务"));
    return c.json(
      store.put(
        "jobs",
        {
          ...j,
          cancelRequested: true,
          status: j.status === "queued" ? "cancelled" : j.status,
        },
        workspace(c),
      ),
    );
  });
  app.post("/api/secrets", async (c) => {
    requireRole(c, "admin");
    const b = await c.req.json();
    if (
      typeof b.ref !== "string" ||
      !b.ref ||
      b.ref.length > 120 ||
      typeof b.value !== "string" ||
      b.value.length < 8 ||
      b.value.length > 4096
    )
      throw new HttpError(422, "INVALID_SECRET", "密钥引用或内容无效");
    secrets.set(`${workspace(c)}:${b.ref}`, b.value);
    store.event(workspace(c), "secret.configured", b.ref, {
      storage: "process-memory",
      configured: true,
    });
    return c.json({ configured: true, persistence: "session" });
  });
  app.post("/api/models/:id/test", async (c) => {
    requireRole(c, "admin");
    return c.json(await model.test(c.req.param("id"), workspace(c)));
  });
  app.post("/api/tools/:id/test", async (c) => {
    requireRole(c, "admin");
    const b = await c.req.json().catch(() => ({}));
    return c.json(
      await tools.probe({
        ...b,
        toolId: c.req.param("id"),
        workspace: workspace(c),
      }),
    );
  });
  app.post("/api/import/knowledge", async (c) => {
    requireRole(c);
    let name, content, source;
    if (c.req.header("content-type")?.includes("multipart/form-data")) {
      const form = await c.req.formData(),
        file = form.get("file");
      if (!file || typeof file === "string")
        throw new HttpError(422, "FILE_REQUIRED", "请选择文件");
      if (file.size > 8 * 1024 * 1024)
        throw new HttpError(413, "FILE_TOO_LARGE", "文件上限8MB");
      name = String(form.get("name") || file.name);
      source = file.name;
      if (
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf")
      ) {
        const { PDFParse } = await import("pdf-parse");
        const p = new PDFParse({
          data: new Uint8Array(await file.arrayBuffer()),
        });
        try {
          content = (await p.getText()).text;
        } finally {
          await p.destroy();
        }
      } else if (/\.(txt|md|markdown|json|csv)$/i.test(file.name))
        content = await file.text();
      else
        throw new HttpError(
          422,
          "FILE_TYPE_UNSUPPORTED",
          "支持文本、Markdown、JSON、CSV和文字PDF",
        );
    } else ({ name, content, source } = await body(c));
    if (typeof content !== "string" || !content.trim())
      throw new HttpError(
        422,
        "EMPTY_KNOWLEDGE",
        "未提取到文本，扫描PDF需先做OCR",
      );
    return c.json(
      store.create(
        "knowledge",
        {
          name: name || "导入知识",
          content,
          source: source || "用户导入",
          status: "draft",
          published: false,
          version: 1,
          allowedModelEgress: false,
        },
        workspace(c),
      ),
      201,
    );
  });
  app.post("/api/datasets/import", async (c) => {
    requireRole(c);
    const b = await body(c);
    if (!Array.isArray(b.cases) || !b.cases.length || b.cases.length > 1000)
      throw new HttpError(422, "INVALID_CASES", "导入需1至1000条用例");
    const result = store.transaction(() => {
      validateResource("datasets", b, workspace(c));
      const d = store.create(
        "datasets",
        {
          name: b.name,
          purpose: b.purpose,
          description: b.description || "",
          caseIds: [],
        },
        workspace(c),
      );
      const cases = b.cases.map((x) => {
        const obj = { ...x, datasetId: d.id, hidden: d.purpose === "holdout" };
        validateResource("cases", obj, workspace(c));
        return store.create("cases", obj, workspace(c));
      });
      return store.put(
        "datasets",
        { ...d, caseIds: cases.map((x) => x.id) },
        workspace(c),
      );
    });
    return c.json(result, 201);
  });
  function reportText(r, ws) {
    const v = store.get("versions", r.versionId, ws),
      employee = store.get("employees", v.employeeId, ws);
    return `# ${r.title || employee.name + " " + v.label + " 评测报告"}\n\n${r.summary || ""}\n\n## 结论\n\n${typeof r.recommendation === "string" ? r.recommendation : JSON.stringify(r.recommendation, null, 2)}\n\n## 指标\n\n${JSON.stringify(r.metrics, null, 2)}\n\n## 限制\n\n${JSON.stringify(r.limitations || [], null, 2)}\n\n版本：${v.id}\n运行：${r.runId}\n报告：${r.id}\n`;
  }
  app.get("/api/reports/:id/export", (c) => {
    const ws = workspace(c),
      r = clean("reports", store.get("reports", c.req.param("id"), ws), ws),
      format = c.req.query("format") || "markdown";
    if (format === "json") {
      c.header("Content-Disposition", `attachment; filename="${r.id}.json"`);
      return c.json(safePublic(r));
    }
    const text = reportText(r, ws);
    c.header(
      "Content-Disposition",
      `attachment; filename="${r.id}.${format === "html" ? "html" : "md"}"`,
    );
    if (format === "html")
      return c.html(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>员工评测报告</title><style>body{max-width:900px;margin:40px auto;font:16px/1.8 system-ui;padding:24px;white-space:pre-wrap}</style><body>${escapeHtml(text)}</body></html>`,
      );
    return c.text(text);
  });
  app.get("/api/versions/:id/export", (c) => {
    const v = store.get("versions", c.req.param("id"), workspace(c));
    c.header("Content-Disposition", `attachment; filename="${v.id}.json"`);
    return c.json({ schemaVersion: "workloom.employee/v1", ...safePublic(v) });
  });
  app.post("/api/training/:id/create-version", async (c) => {
    requireRole(c, "admin");
    return c.json(
      await advanced.createTrainedVersion(c.req.param("id"), workspace(c)),
      201,
    );
  });
  app.get("/api/training/export/:id", (c) => {
    const result = advanced.exportTraining(c.req.param("id"), workspace(c));
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="training.jsonl"');
    return c.body(
      typeof result === "string"
        ? result
        : result.jsonl || JSON.stringify(result),
    );
  });
  app.get("/api/portfolio/:id", (c) =>
    c.json(advanced.recommendPortfolio(c.req.param("id"), workspace(c))),
  );
  app.post("/api/deployments", async (c) => {
    requireRole(c, "admin");
    return c.json(await advanced.deploy(await body(c), workspace(c)), 201);
  });
  app.post("/api/deployments/:id/reconcile", async (c) => {
    requireRole(c, "admin");
    return c.json(await advanced.reconcile(c.req.param("id"), workspace(c)));
  });
  app.post("/api/deployments/:id/rollback", async (c) => {
    requireRole(c, "admin");
    return c.json(await advanced.rollback(c.req.param("id"), workspace(c)));
  });
  app.post("/api/experiences/:id/import", async (c) => {
    requireRole(c, "admin");
    return c.json(
      await advanced.importExperience(c.req.param("id"), workspace(c), {
        approved: true,
        sourceWorkspace: workspace(c),
        targetWorkspace: workspace(c),
      }),
    );
  });
  app.post("/api/reviews", async (c) => {
    requireRole(c);
    const b = await body(c);
    store.get("runs", b.runId, workspace(c));
    if (
      !["pass", "fail", "uncertain", "approved", "rejected"].includes(
        b.decision,
      ) ||
      !b.reason
    )
      throw new HttpError(422, "REVIEW_INVALID", "复核需有效结论和原因");
    const review = store.create("reviews", b, workspace(c)),
      report = engine.buildReport(b.runId, workspace(c));
    return c.json({ review, reportId: report.id }, 201);
  });
  app.get("/api/model-attempts", (c) => {
    requireRole(c, "admin");
    return c.json(model.unresolved?.(workspace(c)) || []);
  });
  app.post("/api/model-attempts/:id/reconcile", async (c) => {
    requireRole(c, "admin");
    return c.json(
      model.reconcile(c.req.param("id"), await body(c), workspace(c)),
    );
  });
  app.get("/api/events", (c) =>
    c.json(store.events(workspace(c), c.req.query("subjectId")).slice(-1000)),
  );
  app.post("/api/users", async (c) => {
    requireRole(c, "admin");
    const b = await c.req.json();
    return c.json(store.createUser({ ...b, workspace: workspace(c) }), 201);
  });
  app.post("/api/nodes/register", async (c) => {
    requireRole(c, "admin");
    const b = await body(c);
    if (
      !b.name ||
      !Array.isArray(b.capabilities) ||
      b.capabilities.some((x) => !["browser", "script", "training"].includes(x))
    )
      throw new HttpError(422, "NODE_INVALID", "节点需要名称和有效能力");
    const token = randomBytes(32).toString("hex"),
      node = store.create(
        "nodes",
        {
          name: b.name,
          capabilities: b.capabilities,
          status: "registered",
          tokenHash: hash(token),
        },
        workspace(c),
      );
    return c.json({ node: safePublic(node), token, oneTime: true }, 201);
  });
  app.post("/api/nodes/:id/revoke", (c) => {
    requireRole(c, "admin");
    const ws = workspace(c),
      n = store.get("nodes", c.req.param("id"), ws);
    store.put(
      "nodes",
      { ...n, status: "revoked", revokedAt: new Date().toISOString() },
      ws,
    );
    store.event(ws, "node.revoked", n.id, { revoked: true });
    return c.json({ revoked: true, id: n.id });
  });
  app.post("/api/nodes/:id/rotate", (c) => {
    requireRole(c, "admin");
    const ws = workspace(c),
      n = store.get("nodes", c.req.param("id"), ws),
      token = randomBytes(32).toString("hex");
    const next = store.put(
      "nodes",
      {
        ...n,
        tokenHash: hash(token),
        status: "registered",
        rotatedAt: new Date().toISOString(),
      },
      ws,
    );
    store.event(ws, "node.rotated", n.id, { storage: "hash-only" });
    return c.json({ node: safePublic(next), token, oneTime: true });
  });
  function nodeAuth(c) {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "");
    if (!token) throw new HttpError(401, "RUNNER_AUTH", "执行节点缺少认证");
    const digest = hash(token),
      row = store.db
        .prepare(
          "SELECT data FROM resources WHERE kind='nodes' AND json_extract(data,'$.tokenHash')=?",
        )
        .get(digest);
    if (!row) throw new HttpError(401, "RUNNER_AUTH", "执行节点认证失败");
    const node = JSON.parse(row.data);
    if (node.status === "revoked")
      throw new HttpError(401, "RUNNER_REVOKED", "执行节点已停用");
    return node;
  }
  app.post("/api/runner/claim", async (c) => {
    const node = nodeAuth(c);
    const task = store.transaction(() => {
      for (const e of store.list("executions", node.workspace)) {
        if (
          e.status === "leased" &&
          Date.parse(e.leaseExpiresAt) < Date.now()
        ) {
          store.put(
            "executions",
            {
              ...e,
              status: "failed",
              error: {
                code: "LEASE_EXPIRED",
                message: "执行器租约过期；结果不明，不自动重放外部写入",
              },
            },
            node.workspace,
          );
          continue;
        }
        if (
          e.status !== "queued" ||
          !node.capabilities.includes(e.requiredCapability) ||
          (e.payload?.nodeId && e.payload.nodeId !== node.id)
        )
          continue;
        return store.put(
          "executions",
          {
            ...e,
            status: "leased",
            nodeId: node.id,
            leaseId: randomBytes(20).toString("hex"),
            leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
          },
          node.workspace,
        );
      }
      return null;
    });
    store.put(
      "nodes",
      { ...node, status: "online", lastSeen: new Date().toISOString() },
      node.workspace,
    );
    return c.json({ task });
  });
  app.post("/api/runner/heartbeat", async (c) => {
    const node = nodeAuth(c),
      b = await c.req.json();
    if (!b.taskId) {
      store.put(
        "nodes",
        { ...node, status: "online", lastSeen: new Date().toISOString() },
        node.workspace,
      );
      return c.json({ ok: true });
    }
    const e = store.get("executions", b.taskId, node.workspace);
    if (
      e.nodeId !== node.id ||
      e.leaseId !== b.leaseId ||
      e.status !== "leased" ||
      Date.parse(e.leaseExpiresAt) < Date.now()
    )
      throw new HttpError(409, "STALE_LEASE", "执行器租约已失效");
    return c.json(
      store.put(
        "executions",
        { ...e, leaseExpiresAt: new Date(Date.now() + 30000).toISOString() },
        node.workspace,
      ),
    );
  });
  app.post("/api/runner/result", async (c) => {
    const node = nodeAuth(c),
      b = await c.req.json();
    validateData(b);
    const e = store.get("executions", b.taskId, node.workspace);
    if (
      e.nodeId !== node.id ||
      e.leaseId !== b.leaseId ||
      e.status !== "leased" ||
      Date.parse(e.leaseExpiresAt) < Date.now()
    )
      throw new HttpError(409, "STALE_LEASE", "结果不属于当前有效租约");
    return c.json(
      store.put(
        "executions",
        {
          ...e,
          status: b.error ? "failed" : "completed",
          result: b.result,
          error: b.error,
          completedAt: new Date().toISOString(),
        },
        node.workspace,
      ),
    );
  });
  if (existsSync(resolve(ROOT, "dist/index.html"))) {
    app.use("/*", serveStatic({ root: resolve(ROOT, "dist") }));
    app.get("*", serveStatic({ path: resolve(ROOT, "dist/index.html") }));
  } else
    app.get("*", (c) =>
      c.html(
        '<!doctype html><meta charset="utf-8"><title>WorkLoom Eval</title><p>前端尚未构建。请运行 pnpm build 后启动服务。</p>',
      ),
    );
  return {
    app,
    store,
    model,
    tools,
    engine,
    advanced,
    pump,
    host,
    port,
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      for (const c of active.values()) c.abort();
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const instance = createApplication();
  const server = serve(
    { fetch: instance.app.fetch, port: instance.port, hostname: instance.host },
    () =>
      console.log(
        `WorkLoom Eval ready: http://${instance.host}:${instance.port}`,
      ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      instance.close();
      server.close(() => {
        instance.store.close();
        process.exit(0);
      });
    });
}
