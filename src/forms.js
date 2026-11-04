export const options = (rows) =>
  rows.map((r) => ({ value: r.id, label: r.name || r.label || r.id }));
const text = (key, label, extra = {}) => ({ key, label, ...extra });
const area = (key, label, extra = {}) =>
  text(key, label, { type: "textarea", wide: true, ...extra });
const json = (key, label, defaultValue = {}, extra = {}) =>
  text(key, label, {
    type: "json",
    wide: true,
    default: defaultValue,
    ...extra,
  });
const select = (key, label, list, extra = {}) =>
  text(key, label, {
    type: "select",
    options: list.map((v) =>
      typeof v === "string" ? { value: v, label: v } : v,
    ),
    ...extra,
  });
const multi = (key, label, rows, extra = {}) =>
  text(key, label, { type: "multi", options: options(rows), ...extra });
export function fields(kind, data, selected = {}) {
  const d = (k) => data[k] || [];
  switch (kind) {
    case "employees":
      return [
        text("name", "员工名称", { required: true }),
        text("role", "岗位名称", { required: true }),
        area("description", "岗位说明"),
        area("requirements", "用人需求"),
        select(
          "accessMode",
          "接入方式",
          [
            { value: "managed", label: "平台托管员工" },
            { value: "http", label: "外部 HTTP 员工" },
          ],
          { default: "managed" },
        ),
        text("endpoint", "外部员工 API 地址", { type: "url" }),
        text("secretRef", "外部连接凭据引用"),
      ];
    case "knowledge":
      return [
        text("name", "知识库名称", { required: true }),
        text("source", "资料来源"),
        area("content", "知识正文", {
          required: true,
          rows: 12,
          help: "填写有依据的业务资料；原文与来源一并保存。",
        }),
        text("tags", "标签", {
          type: "tags",
          default: (selected.tags || []).join("，"),
        }),
        text("allowedModelEgress", "允许发送到所绑定的模型", {
          type: "checkbox",
          default: true,
          help: "关闭后，涉及该资料的外部模型调用将受限制。",
        }),
        text("published", "发布为可引用知识", {
          type: "checkbox",
          default: true,
        }),
      ];
    case "tools":
      return [
        text("name", "工具名称", { required: true }),
        text("description", "用途说明", { required: true }),
        select(
          "adapter",
          "接入方式",
          ["simulation", "http", "mcp", "browser", "script"],
          { default: "simulation", required: true },
        ),
        select(
          "mode",
          "执行环境",
          [
            { value: "simulated", label: "业务仿真" },
            { value: "test", label: "真实测试环境" },
            { value: "readonly", label: "生产只读" },
            { value: "production", label: "生产写入" },
          ],
          { default: "simulated", required: true },
        ),
        text("operation", "业务动作", {
          default: "query",
          help: "仿真支持 query / read / update / refund / publish / list / calculate。",
        }),
        text("secretRef", "凭据引用", {
          help: "仅保存引用名，密钥在模型与连接设置中录入。",
        }),
        json("inputSchema", "输入结构", {
          type: "object",
          properties: {},
          additionalProperties: true,
        }),
        json("outputSchema", "输出结构", { type: "object" }),
        json(
          "config",
          "连接与执行配置",
          {},
          {
            help: "HTTP 配置 url；MCP 配置 url；浏览器和脚本使用已登记私有节点。",
          },
        ),
        json("permissions", "权限声明", { write: false }),
      ];
    case "skills":
      return [
        text("name", "技能名称", { required: true }),
        text("description", "技能用途", { required: true }),
        area("content", "工作方法与异常处理", { required: true }),
        json("steps", "执行步骤", [], {
          array: true,
          help: "每步写明动作、条件、完成要求。",
        }),
        multi("toolIds", "依赖工具", d("tools")),
        text("version", "技能修订", { default: "1" }),
      ];
    case "models":
      return [
        text("name", "显示名称", {
          required: true,
          default: "DeepSeek V4.1 Flash 1017",
        }),
        select("provider", "供应商", ["deepseek", "openai-compatible"], {
          required: true,
          default: "deepseek",
        }),
        text("baseUrl", "API 地址", {
          type: "url",
          required: true,
          default: "https://api.deepseek.com",
        }),
        text("model", "实际模型标识", {
          required: true,
          default: "deepseek-flash",
        }),
        text("secretRef", "运行凭据引用", {
          required: true,
          default: "env:DEEPSEEK_API_KEY",
        }),
        text("contextTokens", "上下文上限", {
          type: "number",
          default: 1048576,
          min: 1,
        }),
        text("maxOutputTokens", "输出上限", {
          type: "number",
          default: 393216,
          min: 1,
        }),
        select(
          "thinking",
          "思考策略",
          [
            { value: "disabled", label: "关闭思考" },
            { value: "enabled", label: "启用思考" },
          ],
          { default: "enabled" },
        ),
        text("search", "允许搜索工具桥接", { type: "checkbox", default: true }),
        json(
          "pricing",
          "可选：模型调用成本估算",
          data.settings?.registry?.pricing || {},
          {
            help: "字段 currency、unitTokens、input、cachedInput、output、method。默认 DeepSeek 按已核实官方峰值费率估算，不代表供应商账单；其他模型需配置实际适用费率。",
          },
        ),
        json(
          "training",
          "可选：模型权重训练适配器",
          {},
          {
            help: '支持微调的供应商可配置 {"protocol":"workloom-async-v1","endpoint":"https://…"}；DeepSeek 默认不支持托管微调。',
          },
        ),
      ];
    case "datasets":
      return [
        text("name", "测试集名称", { required: true }),
        select(
          "purpose",
          "数据用途",
          [
            { value: "train", label: "训练集" },
            { value: "dev", label: "开发集" },
            { value: "validation", label: "验证集" },
            { value: "holdout", label: "隔离盲测集" },
          ],
          {
            required: true,
            default: "dev",
            disabled: Boolean(selected.id),
            help: selected.id
              ? "用途分区创建后固定；需要其他用途时，请新建测试集。"
              : "训练、开发、验证与盲测用途隔离。",
          },
        ),
        area("description", "范围与来源"),
      ];
    case "cases":
      return [
        select("datasetId", "所属测试集", options(d("datasets")), {
          required: true,
          disabled: Boolean(selected.id),
          help: selected.id
            ? "用例不能移动到其他用途分区；请在目标测试集中新建。"
            : undefined,
        }),
        text("name", "用例名称", { required: true }),
        select(
          "category",
          "场景类型",
          ["正常", "边界", "异常", "权限", "回归"],
          { default: "正常" },
        ),
        area("input", "用户输入／任务", { required: true }),
        area("expected", "预期行为", { required: true }),
        json("initialState", "初始业务状态", {}),
        json("assertions", "验收断言", [{ type: "no_violation" }], {
          array: true,
          help: "支持 state、contains、not_contains、tool_called、no_violation、artifact。",
        }),
        json("fault", "故障注入", {}),
        text("hidden", "隐藏用例详情", {
          type: "checkbox",
          help: "盲测细节不提供给优化器。",
        }),
      ];
    case "memories":
      return [
        select("employeeId", "所属员工", options(d("employees")), {
          required: true,
        }),
        text("scope", "记忆作用域", { required: true, default: "evaluation" }),
        area("content", "记忆内容", { required: true }),
        text("source", "来源与依据"),
        text("expiresAt", "失效时间", { placeholder: "2026-12-01T00:00:00Z" }),
        text("approved", "已核验", { type: "checkbox" }),
      ];
    case "experiences":
      return [
        text("name", "经验名称", { required: true }),
        area("summary", "可复用经验与适用条件", { required: true }),
        select("sourceRunId", "来源评测", options(d("runs"))),
        text("tags", "标签", {
          type: "tags",
          default: (selected.tags || []).join("，"),
        }),
        select("visibility", "可见范围", ["workspace", "shared"], {
          default: "workspace",
        }),
        text("approved", "已核验", {
          type: "checkbox",
          help: "仅在已核验且获准的范围内复用，不包含原始客户数据。",
        }),
      ];
    case "teams":
      return [
        text("name", "班组名称", { required: true }),
        area("description", "共同目标与交付要求", { required: true }),
        select(
          "memoryPolicy",
          "记忆策略",
          [
            { value: "isolated", label: "各成员隔离，仅显式交接" },
            { value: "shared", label: "班组任务内共享" },
          ],
          { default: "isolated" },
        ),
        json("members", "成员及交接职责", [], {
          array: true,
          help: '成员格式：{"employeeId":"…","versionId":"…","task":"负责的步骤"}。员工与版本可在下方列表复制标识。',
        }),
      ];
    default:
      return [
        text("name", "名称", { required: true }),
        area("description", "说明"),
      ];
  }
}
export function versionFields(data) {
  return [
    select("employeeId", "所属员工", options(data.employees || []), {
      required: true,
    }),
    text("label", "版本标签", { required: true, default: "V0.1" }),
    text("parentId", "父版本标识"),
    area("prompt", "岗位指令", { required: true, rows: 9 }),
    select("modelId", "真实模型", options(data.models || []), {
      required: true,
    }),
    multi("knowledgeIds", "知识库", data.knowledge || []),
    multi("toolIds", "工具", data.tools || []),
    multi("skillIds", "技能", data.skills || []),
    json(
      "retrieval",
      "知识检索配置",
      { topK: 8, chunkSize: 1400, overlap: 300, minScore: 0 },
      {
        help: "检索结果数、分块大小、重叠与最低相关分数将随员工版本冻结。",
      },
    ),
    json("policy", "执行策略", {
      maxSteps: 8,
      allowWrites: false,
      approvalLimit: 500,
    }),
    area("changeSummary", "本次变更说明", { required: true }),
  ];
}
export function jobFields(type, data) {
  const d = (k) => data[k] || [];
  const versions = d("versions").map((v) => ({
    value: v.id,
    label:
      (d("employees").find((e) => e.id === v.employeeId)?.name || "员工") +
      " · " +
      v.label,
  }));
  const datasets = d("datasets").map((v) => ({
    value: v.id,
    label:
      v.name +
      " · " +
      ({ dev: "开发", train: "训练", validation: "验证", holdout: "盲测" }[
        v.purpose
      ] || v.purpose),
  }));
  const base = [
    select("versionId", "被测员工版本", versions, { required: true }),
    select("datasetId", "测试集", datasets, { required: true }),
  ];
  if (type === "evaluate")
    return [
      ...base,
      select(
        "mode",
        "工具执行模式",
        [
          { value: "simulated", label: "有状态业务仿真" },
          { value: "test", label: "真实测试环境" },
        ],
        { default: "simulated", required: true },
      ),
      text("repeats", "每题重复次数", {
        type: "number",
        min: 1,
        max: 20,
        default: 1,
      }),
      text("budgetTokens", "Token 预算上限", {
        type: "number",
        min: 1000,
        default: 1000000,
      }),
    ];
  if (type === "optimize")
    return [
      ...base.map((f) =>
        f.key === "datasetId"
          ? {
              ...f,
              options: datasets.filter((o) =>
                ["train", "dev"].includes(
                  d("datasets").find((x) => x.id === o.value)?.purpose,
                ),
              ),
            }
          : f,
      ),
      select(
        "validationDatasetId",
        "独立验证集",
        datasets.filter(
          (o) =>
            d("datasets").find((x) => x.id === o.value)?.purpose ===
            "validation",
        ),
      ),
      text("maxRounds", "最多迭代轮数", {
        type: "number",
        min: 1,
        max: 10,
        default: 3,
      }),
      text("candidatesPerRound", "每轮候选数量", {
        type: "number",
        min: 1,
        max: 5,
        default: 2,
      }),
      text("budgetTokens", "本轮总 Token 预算", {
        type: "number",
        min: 1000,
        default: 2000000,
      }),
    ];
  if (type === "memory_evaluate" || type === "long_horizon")
    return [
      select("employeeId", "员工", options(d("employees")), { required: true }),
      base[0],
      text("scope", "隔离记忆作用域", {
        default: "evaluation",
        required: true,
      }),
      json(
        "inputs",
        "顺序任务输入",
        ["请记录本次任务的目标。", "请按当前资料完成任务，并标明依据。"],
        { array: true },
      ),
      text("budgetTokens", "Token 预算", {
        type: "number",
        min: 1000,
        default: 1000000,
      }),
    ];
  if (type === "team_evaluate")
    return [
      select("teamId", "被测班组", options(d("teams")), { required: true }),
      area("input", "共同任务", { required: true }),
      select("datasetId", "参考测试集", datasets),
      text("budgetTokens", "Token 预算", {
        type: "number",
        min: 1000,
        default: 2000000,
      }),
    ];
  if (type === "fine_tune")
    return [
      text("name", "微调任务名称", { required: true }),
      select("employeeId", "目标员工", options(d("employees")), {
        required: true,
      }),
      select(
        "datasetId",
        "训练数据集",
        datasets.filter(
          (o) =>
            d("datasets").find((x) => x.id === o.value)?.purpose === "train",
        ),
        { required: true },
      ),
      select("providerModelId", "支持微调的供应商配置", options(d("models")), {
        required: true,
      }),
      json("hyperparameters", "训练参数", {}),
      text("suffix", "模型后缀", { default: "workloom-eval" }),
    ];
  if (type === "skill_repair")
    return [
      select("skillId", "待改进技能", options(d("skills")), { required: true }),
      base[0],
      select("runId", "失败证据", options(d("runs")), { required: true }),
      area("requirements", "修复目标", {
        required: true,
        help: "生成受限技能候选，保留原技能；不直接执行任意宿主脚本。",
      }),
    ];
  if (type === "shadow_evaluate")
    return [
      base[0],
      { ...base[1], required: false },
      json("inputs", "生产记录输入（脱敏）", [], {
        array: true,
        help: "仅重放到仿真或测试工具，不执行生产写入。",
      }),
      text("budgetTokens", "Token 预算", {
        type: "number",
        min: 1000,
        default: 1000000,
      }),
    ];
  if (type === "browser_evaluate")
    return [
      base[0],
      select("nodeId", "私有执行节点", options(d("nodes")), { required: true }),
      text("url", "测试页面 URL", { type: "url", required: true }),
      text("task", "节点中已登记的浏览器任务名", {
        required: true,
        help: "与私有节点任务注册表中的名称一致，不能执行任意未登记操作。",
      }),
      json("args", "任务参数", {}),
      json("assertions", "页面验收条件", [], { array: true }),
    ];
  return base;
}
