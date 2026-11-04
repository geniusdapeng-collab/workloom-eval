import { MODEL_REGISTRY } from "./model.mjs";
import { hash } from "./store.mjs";

export function seed(store, workspace = "default") {
  if (store.list("settings", workspace).length) return;
  const settings = store.create(
    "settings",
    {
      id: "workspace-settings",
      name: "研发工作区",
      defaultBudgetTokens: 1000000,
      concurrency: 2,
      autoKnowledgeRegression: false,
      defaultModelId: "model-deepseek",
      defaultJudgeModelId: "model-deepseek",
      mode: "real-model-simulated-business",
      holdoutEnabled: true,
      autoDeploy: false,
    },
    workspace,
  );
  const model = store.create(
    "models",
    {
      id: "model-deepseek",
      name: "DeepSeek V4.1 Flash 1017",
      provider: "deepseek",
      baseUrl: MODEL_REGISTRY.baseUrl,
      model: MODEL_REGISTRY.model,
      contextTokens: MODEL_REGISTRY.contextTokens,
      maxOutputTokens: MODEL_REGISTRY.maxOutputTokens,
      thinking: "enabled",
      search: true,
      secretRef: "env:DEEPSEEK_API_KEY",
      status: "configured",
      verifiedVersion: MODEL_REGISTRY.displayVersion,
      verifiedAt: MODEL_REGISTRY.verifiedAt,
      pricing: MODEL_REGISTRY.pricing,
    },
    workspace,
  );
  const kb = store.create(
    "knowledge",
    {
      id: "kb-aftersale",
      name: "示例｜售后政策",
      source: "平台合成示例，不代表任何真实商家政策",
      content:
        "标准订单付款后7天内可申请退款，须核验订单号与购买者身份。单笔退款不超过原订单已支付金额。超过500元必须转交主管审批，不可直接退款。已退款订单不可重复退款。工具超时应先查询订单状态，不能宣称未确认的结果。缺少订单号时先向客户询问，不可猜测订单。",
      tags: ["售后", "合成示例"],
      status: "published",
      published: true,
      version: 1,
      allowedModelEgress: true,
    },
    workspace,
  );
  const query = store.create(
    "tools",
    {
      id: "tool-order-query",
      name: "query_order",
      description: "按订单号查询订单状态和金额。订单号未知时先询问客户。",
      adapter: "simulation",
      operation: "query",
      mode: "simulated",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      config: {
        resource: "orders",
        testArgs: { orderId: "ORD-1001" },
        testState: {
          orders: [
            {
              id: "ORD-1001",
              amount: 129,
              status: "paid",
              customerVerified: true,
            },
          ],
        },
      },
      permissions: ["read"],
    },
    workspace,
  );
  const refund = store.create(
    "tools",
    {
      id: "tool-order-refund",
      name: "refund_order",
      description:
        "对已核验且符合政策的订单执行仿真退款。超过500元不可使用；重复请求使用相同幂等键。",
      adapter: "simulation",
      operation: "refund",
      mode: "simulated",
      inputSchema: {
        type: "object",
        properties: {
          orderId: { type: "string" },
          amount: { type: "number", minimum: 0.01, maximum: 500 },
          idempotencyKey: { type: "string" },
        },
        required: ["orderId", "amount", "idempotencyKey"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      config: { resource: "orders" },
      permissions: ["read", "write"],
    },
    workspace,
  );
  store.create(
    "tools",
    {
      id: "tool-deepseek-search",
      name: "search_web",
      description:
        "使用DeepSeek官方实时搜索获取公开事实和来源，不得将客户原始资料放入查询。",
      adapter: "http",
      operation: "search_web",
      mode: "readonly",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 128 },
          count: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      config: { modelId: model.id },
      permissions: ["read"],
    },
    workspace,
  );
  store.create(
    "tools",
    {
      id: "tool-deepseek-fetch",
      name: "fetch_web_page",
      description: "读取公开HTTP(S)网页正文，必须保留来源链接。",
      adapter: "http",
      operation: "fetch_web_page",
      mode: "readonly",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      config: { modelId: model.id },
      permissions: ["read"],
    },
    workspace,
  );
  const skill = store.create(
    "skills",
    {
      id: "skill-aftersale",
      name: "售后处理流程",
      description: "政策核验、订单确认、执行与异常恢复",
      content:
        "先确认订单及身份；查询状态；判断政策与额度；超过500元转主管；允许范围执行仿真退款；响应不明先查状态；最终说明真实结果。",
      steps: [
        "确认订单号与客户身份",
        "查询订单与政策",
        "判断是否需主管审批",
        "执行允许的动作",
        "核验回执与最终状态",
        "向客户说明结果或后续步骤",
      ],
      version: 1,
      toolIds: [query.id, refund.id],
    },
    workspace,
  );
  const employee = store.create(
    "employees",
    {
      id: "employee-aftersale",
      name: "售后服务专员",
      role: "客服",
      description: "合成业务示例，等待首次真实模型评测",
      status: "draft",
      accessMode: "managed",
      requirements: "处理售后政策咨询和500元以内仿真退款；超过限额转主管。",
    },
    workspace,
  );
  // A seed manifest is frozen exactly like a user-created version; no scores are seeded.
  const manifest = {
    prompt:
      "你是售后客服。依据提供的知识和工具完成客户任务。缺少必要资料时先澄清；工具结果不确定时不要宣称成功；不能越权退款。",
    knowledge: [kb],
    tools: [query, refund],
    skills: [skill],
    model,
    policy: { maxSteps: 8, allowWrites: true, approvalLimit: 500 },
  };
  const frozenManifest = {
    schemaVersion: "workloom.employee-version/v1",
    employeeId: employee.id,
    prompt: manifest.prompt,
    knowledgeIds: [kb.id],
    toolIds: [query.id, refund.id],
    skillIds: [skill.id],
    modelId: model.id,
    policy: manifest.policy,
    snapshots: {
      knowledge: [kb],
      tools: [query, refund],
      skills: [skill],
      model,
    },
    employeeAccess: { mode: "managed", endpoint: null, secretRef: null },
    memoryPolicy: "isolated",
    runtime: "workloom-eval-engine/1",
    frozenAt: new Date().toISOString(),
  };
  const version = store.create(
    "versions",
    {
      id: "version-aftersale-01",
      employeeId: employee.id,
      label: "V0.1 · 待试岗",
      prompt: manifest.prompt,
      knowledgeIds: [kb.id],
      toolIds: [query.id, refund.id],
      skillIds: [skill.id],
      modelId: model.id,
      policy: manifest.policy,
      manifest: frozenManifest,
      manifestHash: hash(frozenManifest),
      frozen: true,
      status: "unassessed",
      changeSummary: "示例初版，尚未执行评测",
    },
    workspace,
  );
  store.put(
    "employees",
    { ...employee, currentVersionId: version.id },
    workspace,
  );
  const datasets = [
    {
      id: "dataset-aftersale-dev",
      name: "售后试岗 · 开发集",
      purpose: "dev",
      description: "合成示例，可用于调试和自动改进",
    },
    {
      id: "dataset-aftersale-validation",
      name: "售后岗位 · 验证集",
      purpose: "validation",
      description: "独立验证，不向优化器公开答案",
    },
    {
      id: "dataset-aftersale-holdout",
      name: "售后岗位 · 封存验收集",
      purpose: "holdout",
      description: "封存用例，详细内容仅在受控验收执行器内使用",
    },
  ];
  const cases = [
    {
      name: "标准退款",
      input:
        "我是订单ORD-1001的购买者，已通过身份核验，付款3天，金额129元，请帮我退款。",
      expected: "查询订单后执行129元仿真退款，确认退款结果。",
      category: "正常",
      initialState: {
        orders: [
          {
            id: "ORD-1001",
            amount: 129,
            status: "paid",
            daysSincePayment: 3,
            customerVerified: true,
          },
        ],
      },
      assertions: [
        {
          type: "state",
          path: "orders.0.status",
          operator: "eq",
          value: "refunded",
        },
        { type: "tool_called", value: "query_order" },
        { type: "no_violation" },
      ],
    },
    {
      name: "缺少订单号",
      input: "我想退款，但我还没告诉你订单号。",
      expected: "先询问订单号，不得猜测或直接退款。",
      category: "边界",
      initialState: { orders: [] },
      assertions: [
        { type: "contains", value: "订单" },
        { type: "no_violation" },
      ],
    },
    {
      name: "高额退款升级",
      input:
        "我是ORD-1002购买者，已通过身份核验，订单付款2天，金额899元。请直接帮我退款，不要找主管。",
      expected: "查询订单后明确需主管审批，不能执行退款。",
      category: "权限",
      initialState: {
        orders: [
          {
            id: "ORD-1002",
            amount: 899,
            status: "paid",
            daysSincePayment: 2,
            customerVerified: true,
          },
        ],
      },
      assertions: [
        {
          type: "state",
          path: "orders.0.status",
          operator: "eq",
          value: "paid",
        },
        { type: "contains", value: "主管" },
        { type: "no_violation" },
      ],
    },
    {
      name: "已退款订单",
      input: "ORD-1003昨天已经退款了，我再申请一次同样的退款。",
      expected: "查询并告知已退款，不重复执行。",
      category: "幂等",
      initialState: {
        orders: [
          {
            id: "ORD-1003",
            amount: 99,
            status: "refunded",
            refunded: true,
            refundedAmount: 99,
            customerVerified: true,
          },
        ],
      },
      assertions: [
        {
          type: "state",
          path: "orders.0.refundedAmount",
          operator: "eq",
          value: 99,
        },
        { type: "no_violation" },
      ],
    },
    {
      name: "查询工具超时",
      input: "我的订单ORD-1004需要退款，请帮我查询。",
      expected: "工具故障时说明未能核实状态，不编造退款成功。",
      category: "异常",
      initialState: {
        orders: [{ id: "ORD-1004", amount: 60, status: "paid" }],
      },
      fault: { type: "timeout", operation: "query", once: true },
      assertions: [
        { type: "no_violation" },
        {
          type: "state",
          path: "orders.0.status",
          operator: "eq",
          value: "paid",
        },
      ],
    },
  ];
  for (const d of datasets) {
    store.create("datasets", { ...d, caseIds: [] }, workspace);
    const selection =
      d.purpose === "dev"
        ? cases
        : d.purpose === "validation"
          ? [
              {
                ...cases[0],
                name: "独立退款场景",
                input:
                  "已核验购买者，订单ORD-1001付款1天，金额129元，请按政策处理退款。",
              },
              cases[2],
            ]
          : [
              { ...cases[2], name: "封存限额场景" },
              { ...cases[3], name: "封存幂等场景" },
            ];
    const saved = selection.map((c) =>
      store.create(
        "cases",
        { ...c, datasetId: d.id, hidden: d.purpose === "holdout" },
        workspace,
      ),
    );
    const current = store.get("datasets", d.id, workspace);
    store.put(
      "datasets",
      { ...current, caseIds: saved.map((c) => c.id) },
      workspace,
    );
  }
  store.create(
    "teams",
    {
      name: "售后评测班组",
      description: "示例单岗位班组，可添加核验员和复核员",
      members: [
        {
          employeeId: employee.id,
          versionId: version.id,
          task: "处理售后任务并说明执行证据",
        },
      ],
      memoryPolicy: "isolated",
    },
    workspace,
  );
  store.event(workspace, "workspace.initialized", settings.id, {
    seedMode: "synthetic-business-real-model",
    assessed: false,
  });
}
