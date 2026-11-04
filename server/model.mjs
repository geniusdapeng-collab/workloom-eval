import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { HttpError, hash } from "./store.mjs";
import { safeRequest } from "./safe-http.mjs";

export const MODEL_REGISTRY = {
  version: "2026-11-04.1",
  provider: "deepseek",
  model: "deepseek-flash",
  displayVersion: "DeepSeek-V4.1-Flash-1017",
  baseUrl: "https://api.deepseek.com",
  contextTokens: 1048576,
  maxOutputTokens: 393216,
  source: "https://api-docs.deepseek.com/quick_start/pricing/",
  verifiedAt: "2026-11-04",
  pricing: {
    currency: "USD",
    unitTokens: 1000000,
    input: 0.3,
    cachedInput: 0.006,
    output: 1.2,
    method: "official-peak-bound-estimate",
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
    verifiedAt: "2026-11-04",
  },
};
export const estimateTokens = (value) => {
  const s = JSON.stringify(value);
  let wide = 0;
  for (const c of s) if (c.codePointAt(0) > 255) wide++;
  return Math.ceil((s.length - wide) / 3 + wide * 1.5) + 128;
};
const normalizeMessages = (rows) =>
  rows.map((m) =>
    Object.fromEntries(
      [
        "role",
        "content",
        "name",
        "tool_call_id",
        "tool_calls",
        "reasoning_content",
      ]
        .filter((k) => m[k] !== undefined)
        .map((k) => [k, m[k]]),
    ),
  );
export function validUsage(u) {
  return Boolean(
    u &&
    Number.isSafeInteger(u.prompt_tokens) &&
    u.prompt_tokens >= 0 &&
    Number.isSafeInteger(u.completion_tokens) &&
    u.completion_tokens >= 0 &&
    Number.isSafeInteger(u.total_tokens) &&
    u.total_tokens > 0 &&
    u.total_tokens >= u.prompt_tokens + u.completion_tokens,
  );
}
export function createModel({
  store,
  secrets = new Map(),
  envSecrets = {},
  networkPolicy = {
    allowedHosts: ["api.deepseek.com"],
    allowPrivateHosts: [],
    allowInsecure: false,
  },
  transport = safeRequest,
}) {
  const budgets = new AsyncLocalStorage();
  const resolveSecret = (ref, ws = "default") =>
    ref
      ? secrets.get(`${ws}:${ref}`) ||
        (ws === "default" ? envSecrets[ref] : null) ||
        null
      : null;
  function config(modelId, ws, snapshot) {
    const live = modelId
      ? store.get("models", modelId, ws)
      : store.list("models", ws)[0];
    if (!live)
      throw new HttpError(503, "MODEL_NOT_CONFIGURED", "请先配置真实模型");
    if (
      live.revoked ||
      ["revoked", "disabled"].includes(live.status) ||
      live.permissions?.denied ||
      live.permissions?.enabled === false
    )
      throw new HttpError(403, "MODEL_REVOKED", "模型授权已撤销");
    if (
      snapshot &&
      (snapshot.id !== live.id ||
        (snapshot.workspace && snapshot.workspace !== ws))
    )
      throw new HttpError(
        403,
        "MODEL_SNAPSHOT_MISMATCH",
        "模型快照标识或工作区不匹配",
      );
    const c = snapshot || live;
    if (c.provider === "deepseek" && c.model !== MODEL_REGISTRY.model)
      throw new HttpError(
        422,
        "UNVERIFIED_MODEL",
        "请更新模型注册表并重新评测后使用该DeepSeek模型",
      );
    return c;
  }
  function receipt(ws, data) {
    const r = store.create(
      "receipts",
      { ...data, recordedAt: new Date().toISOString() },
      ws,
    );
    store.event(ws, "model.attempt", r.id, {
      scene: data.scene,
      status: data.status,
      attemptId: data.attemptId,
      requestHash: data.requestHash,
      model: data.requestedModel,
      usage: data.usage || null,
    });
    return r;
  }
  function unresolved(ws) {
    const receipts = store.list("receipts", ws),
      settled = new Set(
        receipts
          .filter(
            (r) =>
              r.status === "settled" ||
              r.status === "reconciled" ||
              r.status === "not_accepted",
          )
          .map((r) => r.attemptId),
      );
    const pending = new Map();
    for (const r of receipts)
      if (
        r.reservationHeld &&
        r.attemptId &&
        !settled.has(r.attemptId) &&
        !pending.has(r.attemptId)
      )
        pending.set(r.attemptId, r);
    return [...pending.values()];
  }
  function fail(error) {
    return {
      code: error.code || "PROVIDER_ERROR",
      message:
        error.code === "UPSTREAM_HTTP_ERROR"
          ? `模型服务返回HTTP ${error.details?.upstreamStatus || "异常"}`
          : error.code === "UPSTREAM_TIMEOUT"
            ? "模型请求超时，结果和用量待核对"
            : String(error.message || "模型连接失败").slice(0, 240),
    };
  }
  async function request({
    workspace = "default",
    url,
    secretRef,
    method = "GET",
    body,
    signal,
    headers = {},
    timeoutMs = 300000,
    maxBytes = 16777216,
  }) {
    const key = resolveSecret(secretRef, workspace);
    if (secretRef && !key)
      throw new HttpError(503, "SECRET_NOT_CONFIGURED", "连接凭据尚未配置");
    const safeHeaders = { ...headers };
    for (const k of Object.keys(safeHeaders))
      if (
        ["authorization", "proxy-authorization", "cookie"].includes(
          k.toLowerCase(),
        )
      )
        delete safeHeaders[k];
    if (key) safeHeaders.authorization = `Bearer ${key}`;
    return transport({
      url,
      method,
      body,
      headers: safeHeaders,
      signal,
      ...networkPolicy,
      timeoutMs,
      maxBytes,
    });
  }
  const model = {
    request,
    unresolved,
    status(ws = "default") {
      return {
        configured: model.available(ws).length > 0,
        unknownAttempts: unresolved(ws).length,
        registry: MODEL_REGISTRY,
      };
    },
    secretConfigured(ref, ws = "default") {
      return Boolean(resolveSecret(ref, ws));
    },
    available(ws = "default") {
      return store
        .list("models", ws)
        .filter(
          (m) =>
            !m.revoked &&
            !["revoked", "disabled"].includes(m.status) &&
            !m.permissions?.denied &&
            m.permissions?.enabled !== false &&
            resolveSecret(m.secretRef, ws),
        );
    },
    async withBudget(job, fn) {
      const prior = unresolved(job.workspace)
        .filter((r) => r.jobId === job.id)
        .reduce((n, r) => n + Number(r.reservationTokens || 0), 0);
      return budgets.run(
        {
          jobId: job.id,
          workspace: job.workspace,
          max: Number(job.budgetTokens || 1000000),
          used: Number(job.usedTokens || 0),
          reserved: prior,
        },
        fn,
      );
    },
    reconcile(attemptId, evidence, ws = "default") {
      const pending = unresolved(ws).find((r) => r.attemptId === attemptId);
      if (!pending)
        throw new HttpError(409, "ATTEMPT_NOT_PENDING", "该请求没有待核对预留");
      if (
        !evidence?.source ||
        !["not_executed", "completed"].includes(evidence.outcome) ||
        (evidence.outcome === "completed" &&
          (!evidence.responseId || !validUsage(evidence.usage)))
      )
        throw new HttpError(
          422,
          "RECONCILIATION_EVIDENCE_REQUIRED",
          "需提供供应商核对依据；已完成请求需实际回执ID和完整用量",
        );
      return store.transaction(() => {
        const r = receipt(ws, {
          attemptId,
          scene: pending.scene,
          status: "reconciled",
          reservationHeld: false,
          semanticHash: pending.semanticHash,
          requestHash: pending.requestHash,
          evidence: { ...evidence, attestation: "workspace-admin-provided" },
          jobId: pending.jobId,
        });
        if (evidence.outcome === "completed" && pending.jobId) {
          const j = store.get("jobs", pending.jobId, ws);
          store.put(
            "jobs",
            {
              ...j,
              usedTokens:
                Number(j.usedTokens || 0) + evidence.usage.total_tokens,
            },
            ws,
          );
        }
        return r;
      });
    },
    async complete({
      workspace = "default",
      modelId,
      modelConfig,
      scene = "employee.execute",
      messages,
      json = true,
      tools = [],
      signal,
      budgetTokens,
      search = false,
    }) {
      if (signal?.aborted) throw new HttpError(499, "CANCELLED", "任务已取消");
      if (!Array.isArray(messages) || !messages.length)
        throw new HttpError(422, "EMPTY_MESSAGES", "模型输入不能为空");
      const c = config(modelId, workspace, modelConfig),
        ctx = budgets.getStore(),
        attemptId = randomUUID(),
        thinking =
          c.thinking === false ||
          c.thinking === "disabled" ||
          /route|extract|schema|normalize/.test(scene)
            ? "disabled"
            : "enabled";
      const structured = json && !tools.length,
        body = {
          model: c.model,
          messages: normalizeMessages(messages),
          stream: false,
        };
      if (c.provider === "deepseek") {
        body.thinking = { type: thinking };
        if (thinking === "enabled") body.reasoning_effort = "high";
      }
      if (structured) body.response_format = { type: "json_object" };
      if (tools.length) body.tools = tools;
      const inputEstimate = estimateTokens(body),
        legal = Math.min(
          Number(c.maxOutputTokens || MODEL_REGISTRY.maxOutputTokens),
          Number(c.contextTokens || MODEL_REGISTRY.contextTokens) -
            inputEstimate,
        ),
        remaining = Math.min(
          ctx ? ctx.max - ctx.used - ctx.reserved : Infinity,
          budgetTokens ?? Infinity,
        ),
        outputCeiling = Math.floor(Math.min(legal, remaining - inputEstimate));
      const requestHash = hash({ ...body, max_tokens: outputCeiling }),
        semanticHash = hash({ scene, body }),
        reservationTokens = inputEstimate + Math.max(outputCeiling, 0),
        base = {
          attemptId,
          jobId: ctx?.jobId,
          scene,
          requestedModel: c.model,
          modelConfigHash: hash(c),
          registryVersion: MODEL_REGISTRY.version,
          pricingSnapshot:
            c.pricing ||
            (c.provider === "deepseek" ? MODEL_REGISTRY.pricing : null),
          requestHash,
          semanticHash,
          thinking,
          inputEstimate,
          inputCountMethod: "conservative-estimate-han1.5-ascii3",
          legalOutputCeiling: legal,
          sentOutputCeiling: outputCeiling,
          reservationTokens,
          searchRequested: search,
        };
      const deny = (code, message, status) => {
        receipt(workspace, {
          ...base,
          status: "denied",
          errorCode: code,
          reservationHeld: false,
        });
        throw new HttpError(status, code, message);
      };
      if (!resolveSecret(c.secretRef, workspace))
        deny(
          "SECRET_NOT_CONFIGURED",
          "真实模型密钥未配置；没有模拟模型降级",
          503,
        );
      if (!Number.isFinite(legal) || legal < 1)
        deny(
          "CONTEXT_LIMIT",
          "完整输入超过模型窗口，未裁剪内容、未发出请求",
          422,
        );
      if (outputCeiling < 1)
        deny("BUDGET_EXCEEDED", "任务预算不足，未发出请求", 429);
      if (unresolved(workspace).some((r) => r.semanticHash === semanticHash))
        deny(
          "UNRESOLVED_ATTEMPT",
          "相同请求存在结果或用量不明的尝试；请先核对原请求，平台未重复发送",
          409,
        );
      body.max_tokens = outputCeiling;
      if (ctx) ctx.reserved += reservationTokens;
      receipt(workspace, {
        ...base,
        status: "dispatching",
        reservationHeld: true,
        sent: false,
      });
      const started = Date.now();
      let sent = false,
        settled = false,
        data;
      try {
        sent = true;
        const response = await request({
          workspace,
          url: `${c.baseUrl.replace(/\/$/, "")}/chat/completions`,
          method: "POST",
          body,
          secretRef: c.secretRef,
          signal,
        });
        data = response.data;
        if (!validUsage(data?.usage))
          throw new HttpError(
            502,
            "MISSING_USAGE",
            "供应商用量缺失或无效，预留保持待核对",
          );
        const u = data.usage,
          usage = {
            inputTokens: u.prompt_tokens,
            outputTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
            reasoningTokens: Number(
              u.completion_tokens_details?.reasoning_tokens || 0,
            ),
            cachedInputTokens: Number(u.prompt_cache_hit_tokens || 0),
          };
        const pricing =
          c.pricing ||
          (c.provider === "deepseek" ? MODEL_REGISTRY.pricing : null);
        if (
          pricing &&
          [pricing.input, pricing.cachedInput, pricing.output].every(
            (x) => Number.isFinite(x) && x >= 0,
          )
        ) {
          const cached = Math.min(
            usage.inputTokens,
            Math.max(0, usage.cachedInputTokens),
          );
          usage.costUSD =
            ((usage.inputTokens - cached) * pricing.input +
              cached * pricing.cachedInput +
              usage.outputTokens * pricing.output) /
            Number(pricing.unitTokens || 1000000);
          usage.costBasis = pricing.method || "configured-price-estimate";
        }
        store.transaction(() => {
          receipt(workspace, {
            ...base,
            status: "settled",
            reservationHeld: false,
            responseId: data.id,
            actualModel: data.model,
            usage,
          });
          if (ctx) {
            const current = store.get("jobs", ctx.jobId, workspace);
            store.put(
              "jobs",
              { ...current, usedTokens: ctx.used + usage.totalTokens },
              workspace,
            );
          }
        });
        if (ctx) {
          ctx.reserved -= reservationTokens;
          ctx.used += usage.totalTokens;
        }
        settled = true;
        if (!Array.isArray(data.choices) || !data.choices.length)
          throw new HttpError(
            502,
            "INVALID_PROVIDER_RESPONSE",
            "模型响应缺少候选内容",
          );
        const choice = data.choices[0],
          message = choice.message || {},
          finish = choice.finish_reason;
        if (data.model !== c.model)
          throw new HttpError(
            502,
            "MODEL_IDENTITY_MISMATCH",
            "实际模型标识与冻结配置不符",
          );
        if (finish === "length")
          throw new HttpError(
            502,
            "MODEL_TRUNCATED",
            "模型输出被截断，结果未接受",
          );
        if (!["stop", "tool_calls"].includes(finish))
          throw new HttpError(502, "MODEL_FINISH_ERROR", "模型未正常完成");
        if (thinking === "disabled" && usage.reasoningTokens > 0)
          throw new HttpError(
            502,
            "THINKING_POLICY_MISMATCH",
            "模型思考策略与场景配置不符",
          );
        const content =
            typeof message.content === "string"
              ? message.content
              : Array.isArray(message.content)
                ? message.content.map((p) => p.text || "").join("")
                : "",
          toolCalls = message.tool_calls || [];
        if (!content.trim() && !toolCalls.length)
          throw new HttpError(
            502,
            "EMPTY_MODEL_RESULT",
            "模型仅返回空内容或思考内容",
          );
        let value;
        if (structured) {
          try {
            value = JSON.parse(content);
          } catch {
            throw new HttpError(
              502,
              "INVALID_MODEL_JSON",
              "模型返回JSON无效，未用规则结果替代",
            );
          }
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new HttpError(
              502,
              "INVALID_MODEL_JSON",
              "模型结果必须为JSON对象",
            );
        }
        const r = receipt(workspace, {
          ...base,
          status: "completed",
          reservationHeld: false,
          sent: true,
          responseId: data.id,
          actualModel: data.model,
          systemFingerprint: data.system_fingerprint || null,
          finishReason: finish,
          usage,
          latencyMs: Date.now() - started,
          responseHash: hash(data),
        });
        return { content, value, toolCalls, message, usage, receipt: r };
      } catch (e) {
        const knownNotAccepted =
          e.code === "UPSTREAM_HTTP_ERROR" &&
          [400, 401, 402, 403, 404, 422, 429].includes(
            e.details?.upstreamStatus,
          );
        if (!settled && knownNotAccepted && ctx)
          ctx.reserved -= reservationTokens;
        const error = fail(e),
          held = !settled && sent && !knownNotAccepted;
        receipt(workspace, {
          ...base,
          status: knownNotAccepted
            ? "not_accepted"
            : held
              ? "unresolved"
              : "failed",
          reservationHeld: held,
          sent,
          errorCode: error.code,
          errorMessage: error.message,
          latencyMs: Date.now() - started,
        });
        throw new HttpError(e.status || 503, error.code, error.message);
      }
    },
    async search({
      workspace = "default",
      modelId,
      modelConfig,
      query,
      count = 5,
      needContent = true,
      signal,
    }) {
      if (
        typeof query !== "string" ||
        [...query].length < 1 ||
        [...query].length > 128
      )
        throw new HttpError(
          422,
          "INVALID_SEARCH_QUERY",
          "搜索词应为1至128个字符",
        );
      const c = config(modelId, workspace, modelConfig);
      if (c.provider !== "deepseek")
        throw new HttpError(
          422,
          "SEARCH_NOT_SUPPORTED",
          "供应商尚未配置搜索适配器",
        );
      const r = await request({
        workspace,
        url: `${c.baseUrl.replace(/\/$/, "")}/v1/tools/search`,
        method: "POST",
        secretRef: c.secretRef,
        body: {
          query,
          count: Math.max(1, Math.min(50, count)),
          need_content: needContent,
        },
        signal,
      });
      if (!Array.isArray(r.data?.results))
        throw new HttpError(502, "SEARCH_RESPONSE_INVALID", "搜索返回结构无效");
      return {
        ...r.data,
        receipt: receipt(workspace, {
          scene: "tool.search",
          status: "completed",
          requestedModel: c.model,
          requestHash: hash({ query, count, needContent }),
          responseHash: hash(r.data),
          resultCount: r.data.results.length,
          toolMode: "real",
        }),
      };
    },
    async fetch({ workspace = "default", modelId, modelConfig, url, signal }) {
      let target;
      try {
        target = new URL(url);
      } catch {
        throw new HttpError(422, "INVALID_FETCH_URL", "正文地址无效");
      }
      if (
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password ||
        url.length > 8192
      )
        throw new HttpError(
          422,
          "INVALID_FETCH_URL",
          "正文地址必须无凭据HTTP(S)",
        );
      const c = config(modelId, workspace, modelConfig);
      const r = await request({
        workspace,
        url: `${c.baseUrl.replace(/\/$/, "")}/v1/tools/fetch`,
        method: "POST",
        secretRef: c.secretRef,
        body: { url },
        signal,
      });
      if (typeof r.data?.content !== "string")
        throw new HttpError(502, "FETCH_RESPONSE_INVALID", "正文返回结构无效");
      return {
        ...r.data,
        receipt: receipt(workspace, {
          scene: "tool.fetch",
          status: "completed",
          requestedModel: c.model,
          requestHash: hash({ url }),
          responseHash: hash(r.data),
          toolMode: "real",
        }),
      };
    },
    async test(modelId, workspace = "default") {
      const c = config(modelId, workspace),
        r = await model.complete({
          workspace,
          modelId,
          scene: "schema.probe",
          messages: [
            { role: "system", content: "Return a JSON object only." },
            {
              role: "user",
              content: 'Return {"connected":true,"message":"模型连接成功"}',
            },
          ],
          json: true,
          budgetTokens: 400000,
        });
      if (r.value.connected !== true)
        throw new HttpError(502, "MODEL_PROBE_INVALID", "连通测试断言未通过");
      return {
        connected: true,
        model: r.receipt.actualModel,
        displayVersion:
          c.provider === "deepseek" ? MODEL_REGISTRY.displayVersion : c.model,
        usage: r.usage,
        receiptId: r.receipt.id,
      };
    },
  };
  return model;
}
