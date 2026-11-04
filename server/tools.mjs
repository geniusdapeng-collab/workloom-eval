import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertSchema,
  getPath,
  setPath,
  problem,
  validateTarget,
} from "./safe-http.mjs";

const WRITES = new Set(["update", "refund", "publish", "create", "delete"]);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => structuredClone(value);

export function createToolService({ store, model, networkPolicy = {} }) {
  function policyFor(config = {}, currentConfig = {}) {
    const global = networkPolicy.allowedHosts || [];
    const requested = config.allowedHosts || config.allowHosts;
    return {
      allowedHosts: global.filter(
        (host) =>
          (!requested || requested.includes(host)) &&
          (!(currentConfig.allowedHosts || currentConfig.allowHosts) ||
            (currentConfig.allowedHosts || currentConfig.allowHosts).includes(
              host,
            )),
      ),
      allowPrivateHosts: networkPolicy.allowPrivateHosts || [],
      allowInsecure: networkPolicy.allowInsecure === true,
    };
  }

  async function request(url, tool, workspace, options = {}) {
    await validateTarget(url, policyFor(tool.config, tool.currentRestrictions));
    if (!model.request)
      throw problem(
        "REQUEST_ADAPTER_UNAVAILABLE",
        "凭据与网络请求适配器未连接",
        503,
      );
    return await model.request({
      workspace,
      url,
      secretRef: tool.secretRef,
      ...options,
    });
  }

  function checkApproval(tool, args, workspace, approvalId) {
    if (!approvalId)
      throw problem(
        "PRODUCTION_APPROVAL_REQUIRED",
        "生产写操作需要与本次参数绑定的审批",
        403,
      );
    const approval = store.get("approvals", approvalId, workspace);
    if (
      approval.status !== "approved" ||
      approval.consumedAt ||
      approval.toolId !== tool.id ||
      approval.operation !== tool.operation ||
      approval.argsHash !== digest(args) ||
      !approval.expiresAt ||
      Date.parse(approval.expiresAt) <= Date.now()
    )
      throw problem(
        "APPROVAL_MISMATCH",
        "审批已失效、已使用或与本次操作不匹配",
        403,
      );
    store.put(
      "approvals",
      { ...approval, consumedAt: new Date().toISOString(), status: "consumed" },
      workspace,
      { expectedRevision: approval.revision },
    );
  }

  async function injectFault(state, tool, signal) {
    const fault = state.__fault;
    if (
      !fault ||
      (fault.toolId && fault.toolId !== tool.id) ||
      (fault.operation && fault.operation !== tool.operation)
    )
      return;
    state.__faultConsumed ||= {};
    if (fault.once && state.__faultConsumed[tool.id]) return;
    state.__faultConsumed[tool.id] = true;
    if (fault.delayMs)
      await delay(Math.min(Number(fault.delayMs) || 0, 10000), undefined, {
        signal,
      });
    if (fault.type === "timeout")
      throw problem("SIMULATED_TIMEOUT", "仿真工具超时", 504);
    if (fault.type === "error")
      throw problem(
        "SIMULATED_TOOL_ERROR",
        fault.message || "仿真工具故障",
        502,
      );
    if (fault.type === "permission")
      throw problem("SIMULATED_PERMISSION_DENIED", "仿真权限不足", 403);
    if (fault.type === "empty") return { result: null };
    if (fault.type === "malformed") return { result: "invalid-tool-result" };
  }

  function simulate(tool, args, state) {
    const operation = tool.operation || "read";
    const resource = args.resource || tool.config?.resource || "orders";
    if (resource.startsWith("__"))
      throw problem("PRIVATE_STATE_ACCESS", "禁止访问评测内部状态", 403);
    const collection = getPath(state, resource) ?? [];
    const entries = Array.isArray(collection)
      ? collection
      : Object.values(collection);
    const id = args.id ?? args.orderId;
    const selected = entries.find((item) => String(item.id) === String(id));
    if (["read", "query", "list"].includes(operation)) {
      if (id !== undefined) {
        if (!selected) throw problem("RECORD_NOT_FOUND", "仿真记录不存在", 404);
        return clone(selected);
      }
      const filtered = args.where
        ? entries.filter((item) =>
            Object.entries(args.where).every(
              ([key, val]) => getPath(item, key) === val,
            ),
          )
        : entries;
      return clone(
        filtered.slice(0, Math.min(Number(args.limit) || 100, 1000)),
      );
    }
    if (operation === "calculate") {
      const values = args.values;
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.length > 10000 ||
        values.some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        )
      )
        throw problem("INVALID_CALCULATION", "values 必须为有限数字数组");
      const op = args.operator || "sum";
      if (!["sum", "average", "multiply", "min", "max"].includes(op))
        throw problem("INVALID_CALCULATION", "不支持的计算类型");
      const sum = values.reduce((a, b) => a + b, 0);
      const value =
        op === "average"
          ? sum / values.length
          : op === "multiply"
            ? values.reduce((a, b) => a * b, 1)
            : op === "min"
              ? Math.min(...values)
              : op === "max"
                ? Math.max(...values)
                : sum;
      if (!Number.isFinite(value))
        throw problem("CALCULATION_OVERFLOW", "计算结果溢出");
      return { value, operator: op };
    }
    if (!WRITES.has(operation))
      throw problem("UNSUPPORTED_SIMULATION", `未注册的仿真操作：${operation}`);
    if (operation === "publish") {
      if (typeof args.content !== "string" || !args.content.trim())
        throw problem("INVALID_PUBLICATION", "发布内容不能为空");
      state.publications ||= [];
      const publication = {
        id: randomUUID(),
        content: args.content,
        channel: args.channel || "simulation",
        status: "published",
        simulated: true,
      };
      state.publications.push(publication);
      return clone(publication);
    }
    if (operation === "create") {
      const record = {
        ...clone(args.record || {}),
        id: args.id || randomUUID(),
      };
      if (entries.some((item) => item.id === record.id))
        throw problem("DUPLICATE_RECORD", "仿真记录已存在", 409);
      if (Array.isArray(collection)) collection.push(record);
      else collection[record.id] = record;
      setPath(state, resource, collection);
      return clone(record);
    }
    if (!selected) throw problem("RECORD_NOT_FOUND", "仿真记录不存在", 404);
    if (operation === "refund") {
      const amount = Number(args.amount ?? selected.amount);
      if (!Number.isFinite(amount) || amount <= 0)
        throw problem("INVALID_REFUND", "退款金额必须大于零");
      if (selected.status === "refunded" || selected.refunded)
        throw problem("ALREADY_REFUNDED", "订单已退款，拒绝重复退款", 409);
      if (
        !Number.isFinite(Number(selected.amount)) ||
        amount > Number(selected.amount)
      )
        throw problem("REFUND_EXCEEDS_AMOUNT", "退款金额超过订单金额");
      selected.refundedAmount = amount;
      selected.refunded = true;
      selected.status = "refunded";
      return {
        orderId: selected.id,
        amount,
        status: "refunded",
        simulated: true,
      };
    }
    if (operation === "update") {
      if (
        !args.patch ||
        typeof args.patch !== "object" ||
        Array.isArray(args.patch)
      )
        throw problem("INVALID_PATCH", "更新必须提供 patch 对象");
      assertSchema(args.patch, { type: "object" });
      if (Object.hasOwn(args.patch, "id"))
        throw problem("IMMUTABLE_ID", "不可修改记录 ID");
      Object.assign(selected, clone(args.patch));
      return clone(selected);
    }
    if (Array.isArray(collection))
      collection.splice(collection.indexOf(selected), 1);
    else delete collection[selected.id];
    return { id, deleted: true, simulated: true };
  }

  async function runPrivate(tool, args, workspace, signal, mode) {
    const capability = tool.adapter;
    if (!tool.config?.taskName)
      throw problem("RUNNER_TASK_REQUIRED", "工具必须绑定注册的私有执行器任务");
    const execution = store.create(
      "executions",
      {
        type: "tool",
        requiredCapability: capability,
        payload: {
          taskName: tool.config.taskName,
          args,
          toolId: tool.id,
          mode,
          toolMode: tool.mode,
          ...(tool.config.nodeId ? { nodeId: tool.config.nodeId } : {}),
        },
        status: "queued",
      },
      workspace,
    );
    const deadline =
      Date.now() + Math.min(Number(tool.config.timeoutMs) || 60000, 300000);
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted)
          throw signal.reason || problem("ABORTED", "执行器任务已取消", 499);
        const current = store.get("executions", execution.id, workspace);
        if (current.status === "completed")
          return {
            result: current.result,
            executionId: current.id,
            nodeId: current.nodeId,
          };
        if (["failed", "cancelled"].includes(current.status))
          throw problem(
            "RUNNER_TASK_FAILED",
            current.error?.message || current.error || "私有执行器执行失败",
            502,
          );
        await delay(200, undefined, { signal });
      }
      throw problem("RUNNER_TIMEOUT", "私有执行器未在期限内完成任务", 504);
    } catch (error) {
      const current = store.get("executions", execution.id, workspace);
      if (!["completed", "failed", "cancelled"].includes(current.status))
        store.put(
          "executions",
          {
            ...current,
            status: "cancelled",
            error: { code: error.code || "ABORTED", message: error.message },
          },
          workspace,
        );
      throw error;
    }
  }

  async function execute({
    workspace = "default",
    toolId,
    toolSnapshot,
    args = {},
    state = {},
    mode = "simulated",
    signal,
    approvalId,
    modelConfig,
  }) {
    if (signal?.aborted)
      throw signal.reason || problem("ABORTED", "工具执行已取消", 499);
    const tool = toolSnapshot
      ? clone(toolSnapshot)
      : store.get("tools", toolId, workspace);
    if (tool.id !== toolId || (tool.workspace && tool.workspace !== workspace))
      throw problem(
        "TOOL_SCOPE_MISMATCH",
        "工具快照不属于当前工具或工作区",
        403,
      );
    const current =
      toolSnapshot && (tool.revision || tool.sourceRevision)
        ? store.get("tools", tool.sourceId || toolId, workspace)
        : tool;
    if (
      current.revoked ||
      ["revoked", "disabled"].includes(current.status) ||
      current.permissions?.denied ||
      current.permissions?.enabled === false
    )
      throw problem("TOOL_PERMISSION_DENIED", "工具当前权限已被撤销", 403);
    tool.currentRestrictions = current.config || {};
    assertSchema(args, tool.inputSchema || { type: "object" });
    if (Buffer.byteLength(JSON.stringify(args)) > 1048576)
      throw problem("ARGS_TOO_LARGE", "工具参数过大", 413);
    const writes = WRITES.has(tool.operation) || tool.config?.writes === true;
    if (
      writes &&
      (mode === "readonly" ||
        tool.mode === "readonly" ||
        current.mode === "readonly")
    )
      throw problem("READONLY_TOOL", "只读模式禁止写操作", 403);
    if (tool.permissions?.denied || tool.permissions?.enabled === false)
      throw problem("TOOL_PERMISSION_DENIED", "工具权限未授权", 403);
    for (const permissions of [tool.permissions, current.permissions]) {
      const required = writes ? "write" : "read";
      if (
        (Array.isArray(permissions) && !permissions.includes(required)) ||
        (permissions &&
          !Array.isArray(permissions) &&
          (Object.hasOwn(permissions, "read") ||
            Object.hasOwn(permissions, "write")) &&
          permissions[required] !== true)
      )
        throw problem(
          "TOOL_PERMISSION_DENIED",
          "工具当前或快照缺少所需权限",
          403,
        );
      if (
        permissions?.allowedOperations &&
        !permissions.allowedOperations.includes(tool.operation)
      )
        throw problem("TOOL_PERMISSION_DENIED", "当前授权不允许此操作", 403);
      if (
        writes &&
        permissions?.maxAmount !== undefined &&
        Number(args.amount || 0) > Number(permissions.maxAmount)
      )
        throw problem(
          "TOOL_PERMISSION_DENIED",
          "操作金额超过当前授权上限",
          403,
        );
    }
    const simulated = tool.adapter === "simulation";
    if (!simulated && current.mode === "simulated")
      throw problem(
        "LIVE_MODE_RESTRICTED",
        "当前工具仅允许仿真，禁止执行旧快照的真实适配器",
        403,
      );
    if (
      mode === "simulated" &&
      !simulated &&
      !["search_web", "fetch_web_page"].includes(tool.operation)
    )
      throw problem(
        "SIMULATION_ADAPTER_REQUIRED",
        "仿真模式拒绝调用真实业务工具，请绑定仿真适配器",
        403,
      );
    if (writes && !simulated && tool.mode !== "production" && mode !== "test")
      throw problem(
        "TEST_MODE_REQUIRED",
        "测试环境写工具只能在显式 test 模式执行",
        403,
      );
    const next = clone(state);
    const key = args.idempotencyKey;
    const hash = digest(args);
    const ledgerKey = key ? `${tool.id}:${String(key)}` : null;
    const cached = ledgerKey && next.__toolLedger?.[ledgerKey];
    if (cached) {
      if (cached.argsHash !== hash)
        throw problem(
          "IDEMPOTENCY_CONFLICT",
          "相同幂等键不可用于不同参数",
          409,
        );
      return {
        result: clone(cached.result),
        state: next,
        receipt: { ...cached.receipt, replayed: true },
      };
    }
    const productionAction =
      !simulated &&
      tool.mode === "production" &&
      (writes ||
        ["mcp", "browser"].includes(tool.adapter) ||
        (tool.adapter === "http" &&
          !["GET", "HEAD"].includes(tool.config?.method || "POST") &&
          !["search_web", "fetch_web_page"].includes(tool.operation)));
    if (productionAction) checkApproval(tool, args, workspace, approvalId);
    const startedAt = new Date().toISOString();
    let injected;
    try {
      injected = await injectFault(next, tool, signal);
    } catch (error) {
      error.details = { ...error.details, state: next };
      throw error;
    }
    let result, execution;
    if (injected) result = injected.result;
    else if (simulated) result = simulate(tool, args, next);
    else if (tool.operation === "search_web") {
      if (!model.search)
        throw problem("SEARCH_UNAVAILABLE", "真实搜索适配器未连接", 503);
      const searchConfig = tool.config?.modelConfig || modelConfig;
      result = await model.search({
        workspace,
        modelId: tool.config?.modelId || searchConfig?.id,
        modelConfig: searchConfig,
        query: args.query,
        count: args.count || 5,
        needContent: args.needContent ?? true,
        signal,
      });
    } else if (tool.operation === "fetch_web_page") {
      if (!model.fetch)
        throw problem("FETCH_UNAVAILABLE", "网页读取适配器未连接", 503);
      const fetchConfig = tool.config?.modelConfig || modelConfig;
      result = await model.fetch({
        workspace,
        modelId: tool.config?.modelId || fetchConfig?.id,
        modelConfig: fetchConfig,
        url: args.url,
        signal,
      });
    } else if (tool.adapter === "http") {
      const response = await request(tool.config?.url, tool, workspace, {
        method: tool.config.method || "POST",
        body: args,
        signal,
      });
      result =
        response.data ??
        (Object.hasOwn(response, "status") && Object.hasOwn(response, "text")
          ? { status: response.status, text: response.text }
          : response);
    } else if (tool.adapter === "mcp") {
      const endpoint = tool.config?.url;
      const protocol = tool.config.protocolVersion || "2025-11-25";
      if (!["2025-06-18", "2025-11-25"].includes(protocol))
        throw problem(
          "MCP_PROTOCOL_UNSUPPORTED",
          "此适配器支持2025握手版MCP，请显式选择兼容协议",
        );
      const decodeMCP = (response, id) => {
        if (response.data) return response.data;
        if (response.text?.includes("data:")) {
          for (const block of response.text.split(/\r?\n\r?\n/)) {
            const data = block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (!data) continue;
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              throw problem("MCP_INVALID_SSE", "MCP事件不是有效JSON", 502);
            }
            if (parsed.id === id) return parsed;
          }
          throw problem(
            "MCP_RESPONSE_MISSING",
            "MCP事件流缺少匹配请求结果",
            502,
          );
        }
        return response;
      };
      const init = await request(endpoint, tool, workspace, {
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: protocol,
            capabilities: {},
            clientInfo: { name: "workloom-eval", version: "1.0.0" },
          },
        },
        headers: { accept: "application/json, text/event-stream" },
        signal,
      });
      const initData = decodeMCP(init, 1);
      if (initData.error)
        throw problem("MCP_INITIALIZE_ERROR", "MCP 初始化失败", 502);
      const session = init.headers?.["mcp-session-id"];
      if (
        !["2025-06-18", "2025-11-25"].includes(initData.result?.protocolVersion)
      )
        throw problem(
          "MCP_PROTOCOL_MISMATCH",
          "MCP服务端返回不支持的协议版本",
          502,
        );
      const headers = {
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": initData.result.protocolVersion,
        ...(session ? { "mcp-session-id": session } : {}),
      };
      await request(endpoint, tool, workspace, {
        method: "POST",
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
        headers,
        signal,
      });
      const call = await request(endpoint, tool, workspace, {
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: tool.config.toolName || tool.name, arguments: args },
        },
        headers,
        signal,
      });
      const value = decodeMCP(call, 2);
      if (value.error || value.result?.isError)
        throw problem("MCP_TOOL_ERROR", "MCP 工具返回错误", 502, {
          upstreamCode: value.error?.code,
        });
      if (!value.result)
        throw problem("MCP_INVALID_RESULT", "MCP 工具缺少结果", 502);
      result = value.result;
    } else if (["browser", "script"].includes(tool.adapter)) {
      execution = await runPrivate(tool, args, workspace, signal, mode);
      result = execution.result;
    } else
      throw problem(
        "UNSUPPORTED_ADAPTER",
        `工具适配器尚未注册：${tool.adapter}`,
      );
    assertSchema(result, tool.outputSchema || {});
    const receipt = {
      id: randomUUID(),
      toolId,
      toolRevision: tool.revision,
      adapter: tool.adapter,
      mode: simulated ? "simulated" : tool.mode || mode,
      argsHash: hash,
      resultHash: digest(result),
      startedAt,
      completedAt: new Date().toISOString(),
      ...(execution
        ? { executionId: execution.executionId, nodeId: execution.nodeId }
        : {}),
    };
    if (ledgerKey && writes) {
      next.__toolLedger ||= {};
      next.__toolLedger[ledgerKey] = {
        argsHash: hash,
        result: clone(result),
        receipt,
      };
    }
    if (
      next.__fault?.type === "after-write-timeout" &&
      next.__faultConsumed?.[tool.id] &&
      (!next.__fault.once || !state.__faultConsumed?.[tool.id])
    )
      throw problem(
        "SIMULATED_TIMEOUT_AFTER_WRITE",
        "仿真写入已完成但回执超时，可用相同幂等键恢复",
        504,
        { state: next },
      );
    store.event(workspace, "tool.executed", toolId, receipt);
    return { result, state: next, receipt };
  }

  async function probe(input, workspace = "default") {
    const params =
      typeof input === "string" ? { toolId: input, workspace } : input;
    const tool = store.get(
      "tools",
      params.toolId,
      params.workspace || workspace,
    );
    if (WRITES.has(tool.operation) || tool.config?.writes)
      return {
        ok: false,
        code: "WRITE_PROBE_BLOCKED",
        message: "写工具请在专用评测场景中测试",
      };
    const result = await execute({
      ...params,
      state: params.state || tool.config?.testState || {},
      args: params.args || tool.config?.testArgs || {},
      mode: tool.adapter === "simulation" ? "simulated" : "readonly",
    });
    return { ok: true, ...result };
  }

  return { execute, probe };
}
