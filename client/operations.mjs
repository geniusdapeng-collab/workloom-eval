// Shared, closed operation catalogue for the CLI and MCP transports.
// Paths and methods are code-owned; callers never supply a request URL or headers.
const string = (description, extra = {}) => ({
  type: "string",
  description,
  ...extra,
});
const text = (description) => string(description, { maxLength: 5000000 });
const identifier = (
  description = "Resource ID in the authenticated workspace",
) => string(description, { minLength: 1, maxLength: 512 });
const integer = (description, minimum, maximum) => ({
  type: "integer",
  description,
  minimum,
  maximum,
});
const number = (description, minimum, maximum) => ({
  type: "number",
  description,
  minimum,
  maximum,
});
const boolean = (description) => ({ type: "boolean", description });
const enumeration = (values, description) => ({
  type: "string",
  enum: values,
  description,
});
const object = (properties = {}, required = [], extra = {}) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
  ...extra,
});
const array = (items, maxItems = 1000, extra = {}) => ({
  type: "array",
  items,
  maxItems,
  ...extra,
});
const dictionary = (description) => ({
  type: "object",
  description,
  additionalProperties: true,
});
const jsonValue = {
  description: "JSON business value; credentials are forbidden",
};
const ids = (description, maxItems = 100) =>
  array(identifier(description), maxItems, { uniqueItems: true });
const name = string("Display name", { minLength: 1, maxLength: 160 });
const idempotencyKey = string(
  "Optional stable request key. Reuse only for the identical request; the client never retries a write.",
  { minLength: 1, maxLength: 160 },
);
const budget = integer(
  "Token budget; does not limit external training or tool charges",
  1,
  50000000,
);
const purpose = enumeration(
  ["train", "dev", "validation", "holdout"],
  "Immutable dataset purpose; holdout details stay sealed",
);
const mode = enumeration(
  ["simulated", "test", "readonly"],
  "Business tool mode; production writes are not an evaluation mode",
);
const policy = object({
  maxSteps: integer("Maximum employee model/tool steps", 1, 40),
  allowWrites: boolean(
    "Permit eligible business writes; does not grant production approval",
  ),
  allowSearch: boolean(
    "Permit public search within the frozen model authorization",
  ),
  approvalLimit: number("Employee amount ceiling", 0, Number.MAX_SAFE_INTEGER),
});
const retrieval = object({
  topK: integer("Maximum returned knowledge chunks", 1, 30),
  chunkSize: integer("Characters in each chunk", 256, 8000),
  overlap: integer("Overlap; must also be smaller than chunkSize", 0, 2000),
  minScore: number("Minimum lexical retrieval score", 0, 1000),
});
const assertion = object(
  {
    type: enumeration(
      [
        "state",
        "contains",
        "not_contains",
        "tool_called",
        "no_violation",
        "artifact",
      ],
      "Deterministic assertion type",
    ),
    path: string("Safe dotted state/artifact path", { maxLength: 512 }),
    operator: string(
      "equals/eq, not_equals/ne, exists/not_exists, contains/not_contains, gt/gte/lt/lte or one_of",
      { maxLength: 40 },
    ),
    value: jsonValue,
  },
  ["type"],
);
const assertions = array(assertion, 1000);
const caseFields = {
  name,
  input: jsonValue,
  expected: jsonValue,
  category: string("Case category", { maxLength: 120 }),
  initialState: dictionary("Isolated synthetic business state"),
  assertions,
  fault: dictionary("Explicit simulated fault configuration"),
  hidden: boolean("Seal the case; cannot subsequently unseal it"),
  system: text("Optional training system instruction"),
};
const scenario = object(caseFields, ["name", "input", "assertions"]);
const step = object(
  {
    input: string("Task input", { minLength: 1, maxLength: 200000 }),
    name,
    expected: jsonValue,
    initialState: dictionary("Isolated synthetic business state"),
    assertions,
    remember: array(
      {
        anyOf: [
          text("Explicit simulated memory"),
          object(
            {
              content: text("Simulated memory content"),
              ttlMs: integer("Memory lifetime", 1, Number.MAX_SAFE_INTEGER),
              expiresAt: string("ISO expiry time"),
            },
            ["content"],
          ),
        ],
      },
      100,
    ),
    advanceMs: integer(
      "Advance the simulated memory clock",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    at: string("ISO observation time for a long-horizon step"),
  },
  ["input"],
);
const sequence = array(
  { anyOf: [string("Task input", { minLength: 1, maxLength: 200000 }), step] },
  100,
  { minItems: 1 },
);
const permissionFields = {
  enabled: boolean("Current permission switch"),
  denied: boolean("Explicitly deny this asset"),
  read: boolean("Permit reads"),
  write: boolean("Permit writes"),
  maxAmount: number(
    "Current operation amount ceiling",
    0,
    Number.MAX_SAFE_INTEGER,
  ),
  allowedOperations: array(string("Allowed operation"), 100),
};
const permissions = {
  anyOf: [array(string("Granted capability"), 100), object(permissionFields)],
};
const common = {
  name,
  description: text("Description"),
  status: string("Lifecycle status", { maxLength: 120 }),
  revoked: boolean("Revoke current authorization"),
  permissions,
};
export const MUTABLE_RESOURCE_KINDS = [
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
];
export const READABLE_RESOURCE_KINDS = [
  "employees",
  "versions",
  "knowledge",
  "tools",
  "skills",
  "models",
  "datasets",
  "cases",
  "jobs",
  "runs",
  "optimizations",
  "reports",
  "teams",
  "memories",
  "deployments",
  "training",
  "nodes",
  "experiences",
  "reviews",
];
const resourceFields = {
  employees: {
    ...common,
    role: text("Employee role"),
    requirements: text("Original staffing requirements"),
    accessMode: enumeration(["managed", "http"], "Employee execution adapter"),
    endpoint: string("Authorized external employee endpoint"),
    secretRef: identifier(
      "Separately provisioned external employee credential reference; never a credential value",
    ),
    gaps: array(text("Missing dependency"), 100),
  },
  knowledge: {
    ...common,
    content: text("Knowledge text"),
    source: text("Source/provenance"),
    tags: array(string("Tag"), 100),
    published: boolean("Explicitly publish reviewed knowledge"),
    version: jsonValue,
    allowedModelEgress: boolean(
      "Explicit authorization to send knowledge to remote models",
    ),
  },
  tools: {
    ...common,
    adapter: enumeration(
      ["simulation", "http", "mcp", "browser", "script"],
      "Registered tool adapter",
    ),
    operation: string("Registered business operation"),
    inputSchema: dictionary("Tool input JSON Schema"),
    outputSchema: dictionary("Tool output JSON Schema"),
    mode: enumeration(
      ["simulated", "test", "readonly", "production"],
      "Tool environment",
    ),
    config: dictionary(
      "Registered adapter configuration, without credential values",
    ),
    secretRef: identifier(
      "Reference to a separately provisioned credential; never the credential value",
    ),
  },
  skills: {
    ...common,
    content: text("Declarative skill method"),
    steps: array(jsonValue, 100),
    version: jsonValue,
    toolIds: ids("Existing bound tool ID"),
  },
  models: {
    ...common,
    provider: string("Inference/training provider"),
    baseUrl: string("Credential-free HTTPS inference base URL"),
    model: identifier("Provider model identifier"),
    contextTokens: integer(
      "Verified model context window",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxOutputTokens: integer(
      "Verified maximum model output",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    thinking: {
      anyOf: [
        boolean("Thinking enabled"),
        enumeration(["enabled", "disabled"], "Thinking policy"),
      ],
    },
    search: boolean("Authorize public search"),
    secretRef: identifier("Separately provisioned credential reference"),
    pricing: dictionary("Verified or configured pricing metadata"),
    training: dictionary(
      "Registered asynchronous training adapter configuration",
    ),
    verifiedVersion: string("Verified model mapping"),
    verifiedAt: string("Verification date"),
  },
  datasets: {
    ...common,
    purpose,
    judgeModelId: identifier("Fixed independent judge model resource"),
  },
  cases: {
    ...common,
    ...caseFields,
    datasetId: identifier("Owning dataset; cannot be moved after creation"),
  },
  teams: {
    ...common,
    members: array(
      object(
        {
          employeeId: identifier(),
          versionId: identifier(),
          task: text("Member assignment"),
        },
        ["employeeId"],
      ),
      100,
      { minItems: 1 },
    ),
    memoryPolicy: enumeration(
      ["isolated", "shared"],
      "Explicit team memory policy",
    ),
    expected: text("Expected team outcome"),
  },
  memories: {
    ...common,
    employeeId: identifier(),
    scope: identifier("Explicit memory scope"),
    content: text("Approved memory content"),
    source: text("Memory source"),
    expiresAt: string("ISO expiry"),
    approved: boolean("Human approval state"),
  },
  experiences: {
    ...common,
    summary: text("Reviewed reusable summary"),
    sourceRunId: identifier(),
    tags: array(string("Tag"), 100),
    approved: boolean("Review approval"),
    visibility: enumeration(["private", "shared"], "Sharing boundary"),
  },
  settings: {
    name,
    concurrency: integer("Concurrent jobs", 1, 5),
    defaultBudgetTokens: budget,
    defaultModelId: identifier(),
    defaultJudgeModelId: identifier(),
    autoKnowledgeRegression: boolean(
      "Queue real regression when knowledge is published or updated",
    ),
    mode: string("Workspace display mode"),
    holdoutEnabled: boolean("Sealed validation display setting"),
    autoDeploy: boolean(
      "Stored configuration; does not bypass deployment gates",
    ),
  },
};
const resourceRequired = {
  employees: ["name"],
  knowledge: ["name", "content"],
  tools: ["name"],
  skills: ["name"],
  models: ["name", "model", "baseUrl", "secretRef"],
  datasets: ["name", "purpose"],
  cases: ["name", "datasetId", "input", "assertions"],
  teams: ["name"],
  memories: ["name"],
  experiences: ["name"],
  settings: ["concurrency"],
};
function resourceMutationSchema(update) {
  return object(
    {
      kind: enumeration(
        MUTABLE_RESOURCE_KINDS,
        "Mutable business resource kind; models/tools/settings require admin",
      ),
      ...(update
        ? {
            id: identifier(),
            expectedRevision: integer(
              "Required compare-and-swap revision read from the current resource",
              1,
              Number.MAX_SAFE_INTEGER,
            ),
          }
        : {}),
      data: dictionary(
        "Business fields, constrained by the selected kind below",
      ),
      idempotencyKey,
    },
    update ? ["kind", "id", "expectedRevision", "data"] : ["kind", "data"],
    {
      oneOf: MUTABLE_RESOURCE_KINDS.map((kind) => ({
        properties: {
          kind: { const: kind },
          data: object(
            resourceFields[kind],
            update ? [] : resourceRequired[kind],
          ),
        },
      })),
    },
  );
}
const versionFields = {
  employeeId: identifier(),
  parentId: identifier("Optional same-employee parent version"),
  label: name,
  prompt: text("Employee job instruction"),
  knowledgeIds: ids(),
  toolIds: ids(),
  skillIds: ids(),
  modelId: identifier(),
  policy,
  retrieval,
  memoryPolicy: string("Declared memory policy; defaults to isolated", {
    maxLength: 1000,
  }),
  changeSummary: text("Changes and intended effect"),
  status: string("Candidate status"),
  preserveParentSnapshots: boolean(
    "Preserve parent assets except explicitly refreshed knowledge",
  ),
  refreshKnowledgeIds: ids("Published parent knowledge to refresh"),
  skillOverrides: array(
    object(
      {
        id: identifier(),
        content: text("Replacement declarative method"),
        steps: array(jsonValue, 100),
      },
      ["id"],
    ),
    100,
  ),
};
export const JOB_PAYLOAD_SCHEMAS = {
  create_employee: object(
    {
      requirements: string("Staffing requirements", {
        minLength: 5,
        maxLength: 200000,
      }),
      name,
      modelId: identifier(),
      knowledgeIds: ids(),
      toolIds: ids(),
      skillIds: ids(),
      autoEvaluate: boolean("Also run the generated developmental cases"),
    },
    ["requirements"],
  ),
  evaluate: object(
    {
      versionId: identifier(),
      datasetId: identifier(),
      repeats: integer("Repeats per case; not independent sample count", 1, 10),
      mode,
      judgeModelId: identifier(),
    },
    ["versionId", "datasetId"],
  ),
  optimize: object(
    {
      versionId: identifier(),
      datasetId: identifier("Train/dev dataset only"),
      validationDatasetId: identifier("Independent validation dataset"),
      maxRounds: integer("Maximum optimization rounds", 1, 12),
      candidatesPerRound: integer("Candidates per round", 1, 5),
      repeats: integer("Repeats per case", 1, 10),
      patience: integer("Stop after this many unimproved rounds", 1, 5),
      minimumScoreGain: number(
        "Required score gain when pass rate ties",
        0,
        100,
      ),
      targetScore: number("Development score target", 0, 100),
      judgeModelId: identifier(),
    },
    ["versionId", "datasetId"],
  ),
  team_evaluate: object(
    {
      teamId: identifier(),
      input: text("Overall team assignment"),
      datasetId: identifier(),
    },
    ["teamId"],
    { anyOf: [{ required: ["input"] }, { required: ["datasetId"] }] },
  ),
  memory_evaluate: object(
    {
      versionId: identifier(),
      employeeId: identifier(),
      scope: identifier(),
      inputs: sequence,
    },
    ["versionId", "inputs"],
  ),
  long_horizon: object(
    {
      versionId: identifier(),
      employeeId: identifier(),
      scope: identifier(),
      inputs: sequence,
    },
    ["versionId", "inputs"],
  ),
  shadow_evaluate: object(
    {
      versionId: identifier(),
      datasetId: identifier("Dev/validation replay dataset"),
      recordedInputs: array(jsonValue, 1000, { minItems: 1 }),
      inputs: array(jsonValue, 1000, { minItems: 1 }),
      repeats: integer("Repeats per case", 1, 10),
    },
    ["versionId"],
    {
      anyOf: [
        { required: ["datasetId"] },
        { required: ["recordedInputs"] },
        { required: ["inputs"] },
      ],
    },
  ),
  knowledge_regression: object(
    {
      knowledgeId: identifier(),
      datasetId: identifier(),
      versionIds: ids(),
      sourceRevision: integer(
        "Expected published knowledge revision",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      repeats: integer("Repeats per case", 1, 10),
      mode,
    },
    ["knowledgeId"],
  ),
  skill_repair: object(
    {
      versionId: identifier(),
      skillId: identifier(
        "Optional bound skill, defaulting to the first bound skill",
      ),
      datasetId: identifier("Train/dev dataset"),
      sourceRunId: identifier("Optional existing train/dev baseline run"),
      runId: identifier("Alias of sourceRunId"),
      instruction: text("Repair objective"),
      requirements: text("Alias of instruction"),
      mode,
    },
    ["versionId"],
  ),
  benchmark_portfolio: object(
    {
      employeeId: identifier(),
      datasetId: identifier(),
      versionIds: ids("Same employee candidate version", 20),
      repeats: integer("Repeats per case", 1, 10),
      mode,
      minScore: number("Portfolio quality threshold", 0, 100),
    },
    ["employeeId", "datasetId"],
  ),
  browser_evaluate: object(
    {
      toolId: identifier("Bound browser tool"),
      versionId: identifier(),
      nodeId: identifier(),
      task: identifier("Administrator-registered task name, never host code"),
      url: string("Registered task navigation URL"),
      args: dictionary("Registered browser task arguments"),
      assertions: array(jsonValue, 100),
    },
    [],
    {
      anyOf: [
        { required: ["toolId"] },
        { required: ["versionId"] },
        { required: ["task", "nodeId", "url"] },
      ],
    },
  ),
  fine_tune: object(
    {
      employeeId: identifier(),
      datasetId: identifier("Train dataset"),
      providerModelId: identifier("Configured training provider"),
      name,
      configuration: dictionary("Provider-validated training options"),
      hyperparameters: dictionary("Alias of configuration"),
      suffix: string("Provider-validated model suffix", { maxLength: 160 }),
    },
    ["employeeId", "datasetId", "providerModelId"],
  ),
  poll_training: object(
    { trainingId: identifier("Existing external training record") },
    ["trainingId"],
  ),
  reconcile_deployment: object(
    {
      deploymentId: identifier(
        "Uncertain deployment to read back without resubmitting",
      ),
    },
    ["deploymentId"],
  ),
};
export const JOB_TYPES = Object.keys(JOB_PAYLOAD_SCHEMAS);
const pathPart = (value) => encodeURIComponent(value);
const withoutKey = (args) =>
  Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "idempotencyKey"),
  );
const post = (path, body) => ({ method: "POST", path, body });
const entry = (name, description, inputSchema, request, metadata = {}) => ({
  name,
  description,
  inputSchema,
  readOnly: false,
  destructive: false,
  admin: false,
  ...metadata,
  request,
});
const byId =
  (path, verb = "GET") =>
  (args) => ({ method: verb, path: `${path}/${pathPart(args.id)}` });
const empty = object();
const idSchema = object({ id: identifier() }, ["id"]);
const jobSubmitSchema = object(
  {
    type: enumeration(JOB_TYPES, "Platform job type"),
    payload: dictionary(
      "Job input, strictly constrained by the selected type below",
    ),
    budgetTokens: budget,
    idempotencyKey,
  },
  ["type", "payload"],
  {
    oneOf: JOB_TYPES.map((type) => ({
      properties: { type: { const: type }, payload: JOB_PAYLOAD_SCHEMAS[type] },
    })),
  },
);

export const OPERATIONS = [
  entry(
    "doctor",
    "Read health, identity, model availability and server capabilities together, preserving partial failures. Makes no model probe and never falls back to another identity.",
    empty,
    null,
    { readOnly: true, local: "doctor" },
  ),
  entry(
    "health",
    "Read public service health. This does not prove model configuration or employee quality.",
    empty,
    () => ({ method: "GET", path: "/api/health" }),
    { readOnly: true },
  ),
  entry(
    "capabilities",
    "Read the running server's supported workflows, job types and roles.",
    empty,
    () => ({ method: "GET", path: "/api/agent/capabilities" }),
    { readOnly: true },
  ),
  entry(
    "status",
    "Read model availability, active jobs and ledger validity without making a model call.",
    empty,
    () => ({ method: "GET", path: "/api/status" }),
    { readOnly: true },
  ),
  entry(
    "session",
    "Read the authenticated identity, workspace and role. Does not log in or persist credentials.",
    empty,
    () => ({ method: "GET", path: "/api/session" }),
    { readOnly: true },
  ),
  entry(
    "bootstrap",
    "Read public workspace resources, settings and overview. Sealed evidence remains redacted.",
    empty,
    () => ({ method: "GET", path: "/api/bootstrap" }),
    { readOnly: true },
  ),
  entry(
    "resource_list",
    "List a public resource kind in the authenticated workspace. Private credentials, approvals and execution records are excluded.",
    object(
      {
        kind: enumeration(
          READABLE_RESOURCE_KINDS,
          "Public listable resource kind",
        ),
      },
      ["kind"],
    ),
    (a) => ({ method: "GET", path: `/api/resources/${pathPart(a.kind)}` }),
    { readOnly: true },
  ),
  entry(
    "resource_get",
    "Read one resource or settings record by ID. Sealed evidence stays redacted.",
    object(
      {
        kind: enumeration(
          [...READABLE_RESOURCE_KINDS, "settings"],
          "Readable business resource kind",
        ),
        id: identifier(),
      },
      ["kind", "id"],
    ),
    (a) => ({
      method: "GET",
      path: `/api/resources/${pathPart(a.kind)}/${pathPart(a.id)}`,
    }),
    { readOnly: true },
  ),
  entry(
    "resource_create",
    "Create a mutable business resource. Models/tools/settings require admin. Use dedicated workflows for versions, jobs, evidence and deployment; credentials are never accepted here.",
    resourceMutationSchema(false),
    (a) => post(`/api/resources/${pathPart(a.kind)}`, a.data),
    { adminForKinds: ["models", "tools", "settings"] },
  ),
  entry(
    "resource_update",
    "Merge business fields with a required expectedRevision. Re-read after REVISION_CONFLICT; never silently overwrite. Employee pointers and dataset partitions remain managed.",
    resourceMutationSchema(true),
    (a) => ({
      method: "PUT",
      path: `/api/resources/${pathPart(a.kind)}/${pathPart(a.id)}`,
      body: { ...a.data, expectedRevision: a.expectedRevision },
    }),
    { adminForKinds: ["models", "tools", "settings"] },
  ),
  entry(
    "resource_delete",
    "Delete an unreferenced mutable resource. Historical evidence, sealed cases and referenced assets are protected by the API. Models/tools/settings require admin.",
    object(
      {
        kind: enumeration(MUTABLE_RESOURCE_KINDS, "Mutable resource kind"),
        id: identifier(),
        idempotencyKey,
      },
      ["kind", "id"],
    ),
    (a) => ({
      method: "DELETE",
      path: `/api/resources/${pathPart(a.kind)}/${pathPart(a.id)}`,
    }),
    { destructive: true, adminForKinds: ["models", "tools", "settings"] },
  ),
  entry(
    "knowledge_import",
    "Import JSON text knowledge as a draft with model egress disabled. This operation does not publish it.",
    object(
      {
        name,
        content: string("Text knowledge", { minLength: 1, maxLength: 8000000 }),
        source: text("Provenance"),
        idempotencyKey,
      },
      ["content"],
    ),
    (a) => post("/api/import/knowledge", withoutKey(a)),
  ),
  entry(
    "dataset_import",
    "Atomically import 1–1000 cases. Dataset purpose is immutable and holdout details remain sealed.",
    object(
      {
        name,
        purpose,
        description: text("Dataset scope and provenance"),
        cases: array(scenario, 1000, { minItems: 1 }),
        idempotencyKey,
      },
      ["name", "purpose", "cases"],
    ),
    (a) => post("/api/datasets/import", withoutKey(a)),
  ),
  entry(
    "version_create",
    "Freeze an employee candidate and its authorized assets. Parent versions may supply omitted configuration; creation never promotes the employee.",
    object({ ...versionFields, idempotencyKey }, ["employeeId"], {
      anyOf: [{ required: ["parentId"] }, { required: ["prompt", "modelId"] }],
    }),
    (a) => post("/api/versions", withoutKey(a)),
  ),
  entry(
    "job_submit",
    "Queue one of 14 workflows with an explicit payload and optional budget. 202/queued is not completion. Jobs can incur real provider/tool costs; poll with job_wait and inspect result evidence.",
    jobSubmitSchema,
    (a) => post("/api/jobs", withoutKey(a)),
    { adminForJobTypes: ["reconcile_deployment"] },
  ),
  entry(
    "job_get",
    "Read a job's current status, progress, result or error. Completed scheduling alone does not prove an employee or training passed.",
    idSchema,
    byId("/api/jobs"),
    { readOnly: true },
  ),
  entry(
    "job_wait",
    "Wait at most 60 seconds without resubmitting. Returns terminal/timeout plus the last job; timeout never means completion or cancellation. failed/cancelled/interrupted are terminal failures.",
    object(
      {
        id: identifier(),
        timeoutMs: integer("Total wait deadline in milliseconds", 1, 60000),
        pollIntervalMs: integer(
          "Read-only poll interval in milliseconds",
          100,
          10000,
        ),
      },
      ["id"],
    ),
    null,
    { readOnly: true, local: "job_wait" },
  ),
  entry(
    "job_cancel",
    "Request cancellation of a queued/running platform job. Does not prove an external provider has cancelled an already accepted request.",
    object({ id: identifier(), idempotencyKey }, ["id"]),
    (a) => post(`/api/jobs/${pathPart(a.id)}/cancel`, {}),
    { destructive: true },
  ),
  entry(
    "job_resume",
    "Create a continuation only for eligible interrupted/failed/cancelled simulated evaluations with checkpoints, unchanged conditions, remaining budget and no unresolved provider attempt.",
    object({ id: identifier(), idempotencyKey }, ["id"]),
    (a) => post(`/api/jobs/${pathPart(a.id)}/resume`, {}),
  ),
  entry(
    "job_checkpoints",
    "Read immutable completed case checkpoints. Holdout details are redacted; this is not permission to replay real writes.",
    idSchema,
    (a) => ({ method: "GET", path: `/api/jobs/${pathPart(a.id)}/checkpoints` }),
    { readOnly: true },
  ),
  entry(
    "report_export",
    "Export a report as JSON or bounded Markdown/HTML text. Sealed evidence stays redacted.",
    object(
      {
        id: identifier(),
        format: enumeration(
          ["json", "markdown", "html"],
          "Export format; default json",
        ),
      },
      ["id"],
    ),
    (a) => ({
      method: "GET",
      path: `/api/reports/${pathPart(a.id)}/export?format=${pathPart(a.format || "json")}`,
      format: a.format || "json",
    }),
    { readOnly: true },
  ),
  entry(
    "version_export",
    "Export a frozen employee version JSON package, without credential values.",
    idSchema,
    (a) => ({ method: "GET", path: `/api/versions/${pathPart(a.id)}/export` }),
    { readOnly: true },
  ),
  entry(
    "training_export",
    "Export reviewed non-hidden train cases as JSONL text. Other partitions and missing reference answers are refused.",
    object({ datasetId: identifier() }, ["datasetId"]),
    (a) => ({
      method: "GET",
      path: `/api/training/export/${pathPart(a.datasetId)}`,
      format: "jsonl",
    }),
    { readOnly: true },
  ),
  entry(
    "training_adopt",
    "Adopt a verified succeeded provider receipt into a model and employee candidate. Does not promote it, configure a new default, or fabricate weights.",
    object({ id: identifier("Training record ID"), idempotencyKey }, ["id"]),
    (a) => post(`/api/training/${pathPart(a.id)}/create-version`, {}),
    { admin: true },
  ),
  entry(
    "portfolio_get",
    "Read comparable quality/cost/latency recommendations for one employee. Empty evidence gives no recommendation.",
    object({ employeeId: identifier() }, ["employeeId"]),
    (a) => ({
      method: "GET",
      path: `/api/portfolio/${pathPart(a.employeeId)}`,
    }),
    { readOnly: true },
  ),
  entry(
    "model_test",
    "Make a real, billable model connection and structured-output probe. Requires administrator authorization.",
    idSchema,
    (a) => post(`/api/models/${pathPart(a.id)}/test`, {}),
    { admin: true },
  ),
  entry(
    "tool_test",
    "Probe a registered read tool with explicit arguments/state. Write probes are refused; external read requests may occur.",
    object(
      {
        id: identifier(),
        args: dictionary("Probe arguments"),
        state: dictionary("Isolated synthetic probe state"),
      },
      ["id"],
    ),
    (a) =>
      post(`/api/tools/${pathPart(a.id)}/test`, {
        ...(a.args === undefined ? {} : { args: a.args }),
        ...(a.state === undefined ? {} : { state: a.state }),
      }),
    { admin: true },
  ),
  entry(
    "deployment_submit",
    "Submit an explicitly simulated or real deployment. Real deployment needs independent holdout qualification and provider POST plus GET readback; uncertain results must be reconciled, never retried.",
    object(
      {
        employeeId: identifier(),
        versionId: identifier(),
        target: string(
          "local for explicit simulation, otherwise an allowed provider HTTPS endpoint",
          { minLength: 1, maxLength: 8192 },
        ),
        mode: enumeration(
          ["simulated", "real"],
          "Deployment mode; no silent fallback",
        ),
        secretRef: identifier(
          "Separately provisioned deployment credential reference",
        ),
        policy: object({
          runId: identifier("Independent holdout run"),
          minScore: number("Minimum observed score", 0, 100),
          minPassRate: number("Minimum observed pass rate", 0, 1),
          minConfidencePassRate: number(
            "Minimum 95% Wilson lower bound for real deployment",
            0.9,
            1,
          ),
        }),
        idempotencyKey,
      },
      ["employeeId", "versionId", "target", "mode"],
    ),
    (a) => post("/api/deployments", withoutKey(a)),
    { admin: true, destructive: true },
  ),
  entry(
    "deployment_rollback",
    "Rollback an active deployment to its previous authorized version, with the same real-provider receipt/readback safeguards.",
    object({ id: identifier(), idempotencyKey }, ["id"]),
    (a) => post(`/api/deployments/${pathPart(a.id)}/rollback`, {}),
    { admin: true, destructive: true },
  ),
  entry(
    "deployment_reconcile",
    "Read back an uncertain deployment without resubmitting the external write. The local record may be reconciled only when evidence matches.",
    idSchema,
    (a) => post(`/api/deployments/${pathPart(a.id)}/reconcile`, {}),
    { admin: true },
  ),
  entry(
    "review_submit",
    "Append a reasoned human review and a new report; never rewrite the original run or bypass hard assertions/redlines.",
    object(
      {
        runId: identifier(),
        caseId: identifier(),
        decision: enumeration(
          ["pass", "fail", "uncertain", "approved", "rejected"],
          "Human review decision",
        ),
        reason: string("Evidence-based review reason", {
          minLength: 1,
          maxLength: 30000,
        }),
        idempotencyKey,
      },
      ["runId", "decision", "reason"],
    ),
    (a) => post("/api/reviews", withoutKey(a)),
  ),
  entry(
    "events_list",
    "Read at most the latest 1000 workspace events, optionally filtered by subject ID.",
    object({ subjectId: identifier() }),
    (a) => ({
      method: "GET",
      path: `/api/events${a.subjectId ? `?subjectId=${pathPart(a.subjectId)}` : ""}`,
    }),
    { readOnly: true },
  ),
  entry(
    "experience_import",
    "Reuse a reviewed, shared experience into an unapproved knowledge draft in the same workspace; raw traces and credentials are not copied.",
    object({ id: identifier(), idempotencyKey }, ["id"]),
    (a) => post(`/api/experiences/${pathPart(a.id)}/import`, {}),
    { admin: true },
  ),
  entry(
    "model_attempts_list",
    "Read unresolved provider requests and held reservations. Do not repeat an ambiguous request before reconciliation.",
    empty,
    () => ({ method: "GET", path: "/api/model-attempts" }),
    { admin: true, readOnly: true },
  ),
  entry(
    "model_attempt_reconcile",
    "Record administrator-provided provider evidence for an unresolved attempt. Does not pretend to query provider billing or resend the original request.",
    object(
      {
        id: identifier("attemptId"),
        source: string("Provider evidence reference", {
          minLength: 1,
          maxLength: 30000,
        }),
        outcome: enumeration(
          ["not_executed", "completed"],
          "Provider-verified outcome",
        ),
        responseId: identifier(
          "Actual provider response ID for completed attempts",
        ),
        usage: object(
          {
            prompt_tokens: integer(
              "Actual provider input tokens",
              0,
              Number.MAX_SAFE_INTEGER,
            ),
            completion_tokens: integer(
              "Actual provider output tokens",
              0,
              Number.MAX_SAFE_INTEGER,
            ),
            total_tokens: integer(
              "Actual total; at least input plus output",
              1,
              Number.MAX_SAFE_INTEGER,
            ),
          },
          ["prompt_tokens", "completion_tokens", "total_tokens"],
        ),
        idempotencyKey,
      },
      ["id", "source", "outcome"],
      {
        oneOf: [
          { properties: { outcome: { const: "not_executed" } } },
          {
            properties: { outcome: { const: "completed" } },
            required: ["responseId", "usage"],
          },
        ],
      },
    ),
    (a) => {
      const { id, ...body } = withoutKey(a);
      return post(`/api/model-attempts/${pathPart(id)}/reconcile`, body);
    },
    { admin: true },
  ),
];

// Freeze both metadata and schemas so one transport cannot change another's contract.
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
freeze(OPERATIONS);
export const OPERATION_MAP = Object.freeze(
  Object.fromEntries(
    OPERATIONS.map((operation) => [operation.name, operation]),
  ),
);
export const getOperation = (name) =>
  Object.hasOwn(OPERATION_MAP, name) ? OPERATION_MAP[name] : undefined;
export const operationMetadata = () =>
  OPERATIONS.map(({ request, local, ...metadata }) => metadata);
