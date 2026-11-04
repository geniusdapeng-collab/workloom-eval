# WorkLoom Eval HTTP API

本文供平台前端、集成开发者和工作区管理员使用。接口路径与请求字段对应当前 `server/index.mjs`、`server/engine.mjs` 和 `server/advanced.mjs`。平台默认地址为 `http://127.0.0.1:4317`，请求和响应均使用 UTF-8；除文件上传、导出和运行器接口外，请求体使用 `application/json`。

## 会话、权限和工作区

默认 `EVAL_AUTH_MODE=local` 仅允许服务绑定回环地址，每个本机请求使用 `default` 工作区的本地管理员身份。需要实际区分管理员、编辑者和查看者时，使用密码模式；本地模式不会因为创建了一个查看者账号就切换到查看者权限。

密码模式首次启动需要 `EVAL_ADMIN_PASSWORD`，可选 `EVAL_ADMIN_EMAIL`。登录返回 HTTP-only、SameSite Strict 的 `eval_session` Cookie；HTTPS 请求的 Cookie 带 Secure 属性。后续业务请求通过该 Cookie 认证。私有运行器使用独立 Bearer token，见 [私有执行器](PRIVATE-RUNNER.md)。

工作区由当前会话决定。客户端不能通过 JSON 中的 `workspace` 参数切换工作区；跨区资源 ID 按无访问权或不存在处理。修改请求需同源，local 模式还检查本机 Host。

| 权限   | 允许的操作                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| viewer | 读取本工作区允许展示的资源、报告和事件                                                                                                |
| editor | viewer 能力，以及普通资源维护、创建版本、提交评测与改进任务、取消或继续符合条件的任务、导入知识和测试集、提交人工复核                 |
| admin  | editor 能力，以及模型、工具和设置维护、密钥配置、模型/工具连通测试、用户与节点注册和停用/轮换、训练结果采纳、部署/回退/核对、经验导入 |

历史版本、运行、报告、模型回执和检查点不可原地修改。运行状态、训练状态、部署记录及执行器内部记录由专用流程维护。管理员权限也不能通过通用 PUT 覆盖这些证据。

## 路径总表

返回结构中未注明包装对象的列表接口直接返回 JSON 数组，详情接口直接返回资源对象。

| 方法和路径                                    | 用途、主要参数及返回                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/health`                             | 健康检查，返回 `ok/product/version`；不需要业务会话                          |
| `GET /api/session`                            | 当前 `user/workspace/role/localMode`，未登录时 `user:null`                   |
| `POST /api/auth/login`                        | `{email,password}`；返回 `{user}` 并设置 Cookie                              |
| `POST /api/auth/logout`                       | 删除会话并返回 `{ok:true}`                                                   |
| `GET /api/status`                             | 模型是否已配置、模型注册表、活动任务数与事件账本校验结果                     |
| `GET /api/bootstrap`                          | 前端启动数据：资源数组、`settings` 和 `overview`；封存数据会脱敏             |
| `GET /api/resources/:kind`                    | 列出可公开的本工作区资源                                                     |
| `GET /api/resources/:kind/:id`                | 资源详情；封存用例及报告按对应规则脱敏                                       |
| `POST /api/resources/:kind`                   | 创建允许维护的资源；成功返回 201                                             |
| `PUT /api/resources/:kind/:id`                | 合并修订，必须提供 `expectedRevision`                                        |
| `DELETE /api/resources/:kind/:id`             | 删除未被受控引用占用的可维护资源                                             |
| `POST /api/versions`                          | `{employeeId,...版本配置}`；冻结能力快照并返回 201                           |
| `POST /api/jobs`                              | `{type,payload,budgetTokens?}`；返回 202 和任务对象                          |
| `GET /api/jobs/:id`                           | 任务进度、状态、结果或错误                                                   |
| `GET /api/jobs/:id/checkpoints`               | 已完成场景的检查点；封存场景只返回聚合字段                                   |
| `POST /api/jobs/:id/cancel`                   | 取消排队或执行中的任务；历史完成证据保留                                     |
| `POST /api/jobs/:id/resume`                   | 对满足恢复条件的中断仿真评测创建新任务，返回 202                             |
| `POST /api/secrets`                           | 管理员提交 `{ref,value}`；值只保存在服务进程内存                             |
| `POST /api/models/:id/test`                   | 实际模型连通与结构化输出断言；返回用量和回执 ID                              |
| `POST /api/tools/:id/test`                    | 可传 `{args,state}`；写工具拒绝直接探测，使用专用评测场景测试                |
| `POST /api/import/knowledge`                  | JSON `{name,content,source}` 或 multipart `file/name`；返回知识草稿 201      |
| `POST /api/datasets/import`                   | `{name,purpose,description?,cases:[...]}`；原子导入并返回数据集 201          |
| `GET /api/reports/:id/export?format=markdown` | 导出报告；也支持 `json`、`html`                                              |
| `GET /api/versions/:id/export`                | 导出冻结的员工版本 JSON                                                      |
| `GET /api/training/export/:id`                | 导出训练集 JSONL，`:id` 是数据集 ID                                          |
| `POST /api/training/:id/create-version`       | 管理员把真实成功训练回执采纳为待测模型和员工候选，返回 201；不覆盖在用版本   |
| `GET /api/portfolio/:id`                      | 该员工可比较运行的 Pareto 前沿与推荐，`:id` 是员工 ID                        |
| `POST /api/deployments`                       | 管理员提交部署，返回 201；详见后文                                           |
| `POST /api/deployments/:id/rollback`          | 管理员回退活动部署                                                           |
| `POST /api/deployments/:id/reconcile`         | 管理员对不确定部署只读核对；无需请求体                                       |
| `POST /api/experiences/:id/import`            | 管理员复用本工作区已审核且允许共享的经验，生成待审核知识草稿                 |
| `POST /api/reviews`                           | `{runId,caseId?,decision,reason}`；返回人工复核记录和新增报告 ID，201        |
| `GET /api/model-attempts`                     | 管理员查询结果或用量尚未核对的模型尝试                                       |
| `POST /api/model-attempts/:id/reconcile`      | 管理员登记供应商核对依据；`:id` 为 `attemptId`                               |
| `GET /api/events?subjectId=...`               | 查询事件；最多返回最后 1000 条                                               |
| `POST /api/users`                             | 管理员创建 `{email,password,role}`；密码至少 12 字符，工作区继承管理员会话   |
| `POST /api/nodes/register`                    | 管理员创建 `{name,capabilities}`；返回节点和仅展示一次的 token               |
| `POST /api/nodes/:id/revoke`                  | 管理员停用节点；原 token 不能再领取、续租或提交结果                          |
| `POST /api/nodes/:id/rotate`                  | 管理员轮换并重新注册节点认证；返回仅展示一次的新 token，旧 token 失效        |
| `POST /api/runner/claim`                      | Bearer 节点认证，返回 `{task:execution对象或null}`                           |
| `POST /api/runner/heartbeat`                  | Bearer 节点认证；任务续租 `{taskId,leaseId}`，无 taskId 时只更新节点在线时间 |
| `POST /api/runner/result`                     | Bearer 节点认证；`{taskId,leaseId,result?,error?}`                           |

通用资源列表禁止访问 `receipts/executions/approvals/settings/checkpoints`。其中模型回执和设置的指定 ID 详情仍可读取；执行器、审批和检查点的指定 ID 通用详情接口也被拒绝。设置通过 `bootstrap.settings` 展示，检查点和执行器采用专用路径。

## 资源与并发修订

可通过通用接口维护的 kind 为 `employees`、`knowledge`、`tools`、`skills`、`models`、`datasets`、`cases`、`teams`、`memories`、`experiences`、`settings`。模型、工具和设置维护要求管理员，其余要求编辑者。除设置外，资源需要不超过 160 字的 `name`。

每个资源带 `id/workspace/revision/createdAt/updatedAt`。PUT 接收部分业务字段，服务端与原对象合并；`expectedRevision` 不匹配返回 `REVISION_CONFLICT`，客户端应重新读取，不能覆盖其他人的修改。

```json
{
  "expectedRevision": 1,
  "name": "更新后的政策名称",
  "content": "经审核的新政策正文"
}
```

员工的 `currentVersionId` 由部署流程维护，不能通过通用创建或更新任意指定。测试集 `caseIds` 由场景接口维护。场景不能在不同数据集间移动；数据集的用途与来源不能重写。封存用例不能通过通用接口修改、删除或解除隐藏。删除有场景的数据集、被版本引用的资产或被任务占用的资源会被拒绝。

知识导入支持文本、Markdown、JSON、CSV 和文字型 PDF，单个上传文件上限 8 MiB；扫描型 PDF 需要先做 OCR。导入结果为 `draft`，`published:false`、`allowedModelEgress:false`。工作区审核并明确允许模型外发后，才可绑定给远程模型员工。

## 员工版本与评测任务

创建版本需要员工、岗位指令、模型，以及可选的知识、工具和技能 ID。下例 ID 使用默认合成场景资源；生产集成应先从 bootstrap 或资源列表取得实际 ID。

```json
{
  "employeeId": "employee-aftersale",
  "parentId": "version-aftersale-01",
  "label": "V0.2 人工修订",
  "prompt": "依据授权政策处理售后任务，先核验订单与身份，再执行额度内动作。",
  "knowledgeIds": ["kb-aftersale"],
  "toolIds": ["tool-order-query", "tool-order-refund"],
  "skillIds": ["skill-aftersale"],
  "modelId": "model-deepseek",
  "policy": { "maxSteps": 8, "allowWrites": true, "approvalLimit": 500 },
  "retrieval": { "topK": 8, "chunkSize": 1400, "overlap": 300, "minScore": 0 },
  "changeSummary": "增加异常回执核对步骤"
}
```

版本冻结知识、工具、技能、模型配置、策略和检索参数，并保存清单摘要。retrieval 默认值如上；topK 为 1–30，chunkSize 为 256–8000，overlap 为 0–2000 且小于 chunkSize，minScore 为 0–1000。参数实际控制文本分块和命中筛选，不能借调整参数改写知识事实。执行时仍核对当前授权：撤销资产、收紧权限或禁止知识外发后，旧快照不能恢复这些权限。`allowWrites:true` 表示岗位允许相应工作，不代表获得生产写审批。

需求生成员工的模型选择依次为 payload.modelId、工作区 settings.defaultModelId、当前获准的内置 model-deepseek；没有这些配置且仅存在一个获准模型时才使用该模型。多个模型而无明确默认时返回 `DEFAULT_MODEL_REQUIRED`，不会按资源列表顺序选择新训练模型。训练结果采纳不改写默认模型设置或员工在用版本。

提交一个实际模型加仿真业务工具的评测：

```bash
export EVAL_URL='http://127.0.0.1:4317'
curl -sS "$EVAL_URL/api/jobs" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: aftersale-eval-example-1' \
  -d '{"type":"evaluate","budgetTokens":300000,"payload":{"versionId":"version-aftersale-01","datasetId":"dataset-aftersale-dev","repeats":1,"mode":"simulated"}}'
```

密码模式的 curl 请求还需携带已取得的会话 Cookie。示例没有模型密钥；模型调用由服务端分发。202 只代表已入队，应使用返回的任务 ID 轮询 `GET /api/jobs/:id`，然后读取结果里的 `runId/reportId`。相同 `Idempotency-Key` 与相同请求返回同一入队结果；换成不同请求会被拒绝。

任务状态包括 `queued/running/completed/failed/cancelled/interrupted`。任务调度完成与评测合格是两个不同结果：任务可能成功保存一个 `incomplete` 运行。应同时检查 `run.status`、`metrics.valid/total/incomplete/violations` 和报告建议。

| type                   | payload 核心字段与结果                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_employee`      | `requirements`，可选 `name/modelId/knowledgeIds/toolIds/skillIds/autoEvaluate`；生成初版员工、冻结版本、开发集和能力缺口                                      |
| `evaluate`             | `versionId/datasetId`，可选 `repeats/mode/judgeModelId`；结果含 `runId/reportId/metrics`                                                                      |
| `optimize`             | `versionId/datasetId`，可选 `validationDatasetId/maxRounds/candidatesPerRound/repeats/patience/judgeModelId`；只用 train/dev 生成改进，保留每个候选及对比结果 |
| `team_evaluate`        | `teamId`，加 `input` 或 `datasetId`；显式交接并记录各成员贡献                                                                                                 |
| `memory_evaluate`      | `versionId/inputs`，可选 `employeeId/scope`；输入对象可含 `input/expected/remember/advanceMs/assertions`                                                      |
| `long_horizon`         | `versionId/inputs`，可选 `employeeId/scope`；时序输入可含 `input/expected/at/assertions`，记忆候选隔离且不会自动成为生产记忆                                  |
| `shadow_evaluate`      | `versionId`，加专用 dev/validation `datasetId` 或 `recordedInputs`（也接受 `inputs`）；绑定仿真工具，禁止真实业务写入                                         |
| `knowledge_regression` | `knowledgeId`，可选 `datasetId/versionIds`；给受影响在用版本定向刷新该知识，生成候选，父子同条件评测和比较；无测试集返回明确 gap                              |
| `skill_repair`         | `versionId/skillId`，加 train/dev `datasetId` 或开发运行 `sourceRunId`（也接受 `runId`）；可含 `instruction/requirements`，生成声明式技能与版本候选并回归     |
| `benchmark_portfolio`  | `employeeId/datasetId`，可选 `versionIds/repeats/mode/minScore`；同条件评测后计算质量、成本与延迟的非支配组合                                                 |
| `browser_evaluate`     | 已绑定浏览器 `toolId` 与 `args`；或 `versionId/nodeId/url/task`，task 必须是运行器注册任务名；返回实际执行器结果和回执                                        |
| `fine_tune`            | `employeeId/datasetId/providerModelId`，可选 `name/configuration/hyperparameters/suffix`；提交外部训练任务，见 [训练适配器](TRAINING-ADAPTER.md)              |
| `poll_training`        | `trainingId`；主动拉取并校验外部任务状态，不自动定时轮询                                                                                                      |
| `reconcile_deployment` | 管理员动作，`deploymentId`；只读核对不确定部署，与专用核对端点相同                                                                                            |

`evaluate` 的 mode 为 `simulated/test/readonly`，普通评测不允许生产写模式。重复执行次数上限 10；重复同一道题不会增加独立样本数。模型、仿真用户、评分和改进调用都计入任务的 token 用量。默认任务预算 1,000,000 tokens；API 接受 1 至 50,000,000 的整数上限。搜索和正文读取按供应商请求计费，与 token 计数不同。

长期记忆评测的员工与裁判获得相同的冻结岗位指令、政策、知识和技能，并分别看到当前 scope 未过期的记忆。岗位知识不需要先写入临时记忆才能作为事实依据。未在 payload 单独指定预算时，高级任务继承根任务 budgetTokens；长期记忆评测没有另设 32K 的隐含上限，最终仍受模型窗口、合法输出上限和分发器总预算约束。

只有 `evaluate` 的 `interrupted/failed/cancelled` 仿真任务、有可用检查点且仍有剩余预算时允许 resume。存在未核对模型请求时先核对原尝试；实际业务写任务不会自动重放。

### 知识发布后的定向回归

手动提交：

```json
{
  "type": "knowledge_regression",
  "budgetTokens": 1000000,
  "payload": {
    "knowledgeId": "published-knowledge-id",
    "datasetId": "existing-regression-dataset-id"
  }
}
```

不传 versionIds 时，查找当前在用且绑定该知识的员工版本；显式 versionIds 只能选择已绑定该知识的版本。不传 datasetId 时，选择各父版本最近的 train/dev 运行数据集。每个候选通过 `preserveParentSnapshots:true` 与 `refreshKnowledgeIds` 仅更新指定知识，其余知识、工具、技能、模型和策略保留父快照。分别评测父版本和候选，保存 baselineRunId/candidateRunId/reportId/comparison，不更新员工指针。

缺少可用测试集时返回 `NO_REGRESSION_DATASET` gap 和候选 ID，不把未测候选标为通过。知识必须已发布并保持当前授权，远程模型还需要允许知识外发。自动排队任务如果携带的 sourceRevision 已被后续修订替代，会返回 `KNOWLEDGE_REVISION_CHANGED`，不会把新内容冒充旧发布版本的回归。

工作区 `settings.autoKnowledgeRegression` 默认 false。管理员打开后，经 PUT 首次发布草稿或更新已发布知识正文会按该工作区默认预算排队；返回仍为知识资源，任务从 jobs 列表读取。该开关触发真实模型评测，但不代表允许自动生产部署。

## 场景、规则与报告

数据用途为 `train/dev/validation/holdout`。自动改进只用 train/dev；validation 只用于阶段验证；holdout 的输入、答案和详细执行轨迹不向普通读取或导出暴露，也不能借改进任务重新读取。

导入例子：

```json
{
  "name": "合成客服开发集",
  "purpose": "dev",
  "description": "仅用于开发，不授予生产资格",
  "cases": [
    {
      "name": "核验退款",
      "input": "我已核验身份，订单EXAMPLE-1金额100元，请按政策退款。",
      "expected": "先查询，再执行符合政策的退款并核验回执。",
      "category": "正常",
      "initialState": {
        "orders": [
          {
            "id": "EXAMPLE-1",
            "amount": 100,
            "status": "paid",
            "customerVerified": true
          }
        ]
      },
      "assertions": [
        {
          "type": "state",
          "path": "orders.0.status",
          "operator": "eq",
          "value": "refunded"
        },
        { "type": "tool_called", "value": "query_order" },
        { "type": "no_violation" }
      ]
    }
  ]
}
```

规则类型为 `state/contains/not_contains/tool_called/no_violation/artifact`。状态规则支持相等、不等、存在、包含、大小比较和 `one_of` 等运算。外部员工端点自报的状态不会替代独立业务状态。评分缺失、执行失败、用量异常或输出截断不会被默认为成功。

每个报告关联冻结版本和运行。普通 evaluate 的裁判选择依次为 payload.judgeModelId、数据集 judgeModelId、工作区 settings.defaultJudgeModelId；均未配置时，兼容使用被测员工的冻结模型。选定裁判仍须通过当前模型授权检查，远程裁判也不能接收禁止外发的岗位知识。optimize 在开始时固定同一裁判配置，基线、所有候选和阶段 validation 都使用该快照。

运行 manifest 分别记录 `workerModelConfigHash`、`judgeModelConfigHash` 和 `judgeSelection`。comparisonHash 绑定数据集、裁判配置、评分规则、重复次数和模式，不要求被测 worker 权重相同；比较新训练权重时应显式配置同一裁判，避免兼容默认随 worker 改变。裁判配置变化的运行不能直接当作同条件改进。比较候选时应使用相同 `manifest.comparisonHash` 的运行，检查逐例回归、违规、成本和延迟。

已知的模型调用费用保留在 usage.costUSD 和报告 metrics.costUSD；它按冻结费率和供应商用量估算，不等于供应商账单。无法完整估算时不补零，组合计算使用 `costBasis:"tokens"`。组合接口缺少可比较运行时返回空前沿和 `recommendation:null`。

`POST /api/reviews` 的 decision 接受 `pass/fail/uncertain/approved/rejected`，需填写 reason；它新增人工意见和报告，不会改写原运行分数或自动赋予发布资格。

## 模型凭据与不确定调用

密钥资源请求体为 `{ "ref":"my-model-session", "value":"REPLACE_ONLY_IN_MEMORY" }`。这里只展示占位值。实际值应在管理界面或受控调用中提交；不要写进版本、知识、工具配置、URL 或仓库。`secretRef` 是连接资源引用，不是密钥本身。通过密钥接口配置的值在服务进程重启后需要重新注入。

当前默认模型注册表记录 `deepseek-flash` 对应已核验的 DeepSeek V4.1 Flash 1017 映射，具体核验日期见 `/api/status.registry`。模型别名与实际响应的模型名、后端 fingerprint 分别记录。Flash 的搜索通过独立官方 Search/Fetch 接口桥接，不能用一个静默忽略的内置搜索开关代替工具回执。[DeepSeek 模型说明](https://api-docs.deepseek.com/quick_start/pricing/)、[Search & Fetch](https://api-docs.deepseek.com/guides/search/)

模型请求发送前先写入调用记录并预留预算。结果或供应商用量不明时保持待核对状态，相同语义请求不会因为重新建任务或重启分发器就自动再次发送。

管理员登记已完成供应商请求的核对依据示例：

```json
{
  "source": "供应商控制台工单或实际响应记录的标识",
  "outcome": "completed",
  "responseId": "provider-response-example",
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}
```

供应商明确证明未执行时使用 `outcome:"not_executed"` 并提供 source。该接口记录管理员提供的证明，不冒充已从供应商自动查询到扣费或终态。

## 部署、回退与核对

管理员提交：

```json
{
  "employeeId": "employee-id-from-api",
  "versionId": "version-id-from-api",
  "target": "https://deployment.example.test/employees",
  "mode": "real",
  "secretRef": "deployment-session",
  "policy": {
    "runId": "approved-holdout-run-id",
    "minScore": 80,
    "minPassRate": 0.9
  }
}
```

示例域名需要替换为实际可用且列入服务端 `EVAL_ALLOWED_HOSTS` 的适配器地址。私网还需 `EVAL_PRIVATE_HOSTS`，测试 HTTP 还需 `EVAL_ALLOW_HTTP=1`。工具自己的 allowedHosts 不能扩大这些管理员范围。

部署资格来自运行中的冻结 manifest，而非事后可编辑的数据集用途。要求完整、无违规的独立 holdout 证据；默认最低分 80、观察通过率 1。显式 policy 可设观察通过率，真实发布的 95% Wilson 下界仍至少为 0.9，并要求至少 30 个独立场景。30 道题即使全过，下界也可能不够；增加同题重复次数不能替代增加独立场景。还会复检当前知识、工具、技能和模型授权。少样本只能满足模拟展示等较小范围，不能自动绕过真实门槛。

外部协议的 target 是完整提交地址。例如 target 为 `https://deployment.example.test/employees`：

1. 平台向 target 发送 `POST`：`{action:"deploy",employeeId,versionId,requestId}`；回退时 action 为 `rollback`，versionId 为前版本。
2. 提供方成功返回 `{receiptId:"provider-receipt-example"}`。
3. 平台独立 `GET /employees/status?employeeId=...`，必须返回同一 `versionId` 和 `receiptId`。建议同时返回提交时的 `requestId`，用于提交响应丢失后的核对。
4. 回读匹配后，才原子更新本地员工指针，并记录 `receipt.synced:true`。

target 的路径后会追加 `/status`；查询参数重新设置为 employeeId。提供方应持久保存 requestId、回执与生效状态，并对同一 requestId 做幂等处理。平台的协议不会上传源代码、模型权重或自行部署 Kubernetes；实际发布动作由目标适配器执行。

同一工作区、同一员工的 `deploying/rolling_back/uncertain` 记录形成持久排他状态。已发送后的超时、缺回执、读回失败、版本不匹配或本地提交冲突会保留 `uncertain`，阻止再次提交。此时读取部署记录，再调用 reconcile；核对只执行 GET，不重发 POST。已知 receiptId 或原 requestId、目标版本匹配时才补交本地状态；否则保持 uncertain。服务重启也不会自动重发遗留真实部署。

模拟部署使用 `target:"local",mode:"simulated"`，会真实更新本地生效指针，回执明确标记 simulated；它不代表外部生产系统已经更新。`mode:"real"` 不能以 local 目标静默降级。活动部署有前版本且当前指针仍匹配时才允许 rollback，回退目标也需要保持当前授权。

## 错误约定

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "资源已更新，请刷新后重试",
    "details": {}
  }
}
```

| HTTP 状态   | 常见原因与处理                                                         |
| ----------- | ---------------------------------------------------------------------- |
| 401         | 未登录、运行器 Bearer 缺失或无效                                       |
| 403         | 角色不足、封存访问、资产撤销、权限收紧、知识外发或网络策略拒绝         |
| 404         | 本工作区资源不存在、无访问权或 kind 不存在                             |
| 409         | 修订冲突、证据不可变、资源被引用、部署互斥、待核对调用、恢复条件不满足 |
| 413         | 请求、文件、工具或执行器结果超过大小限制                               |
| 422         | JSON、字段、预算、任务类型、Schema 或能力配置不合法                    |
| 429         | token 预算、登录尝试次数或供应商限额达到限制                           |
| 502/503/504 | 上游响应异常、服务未配置、环境错误或超时；先查看任务、回执和不确定状态 |

不要仅根据 HTTP 200/202 或任务 completed 判断员工合格、权重训练完成或生产发布成功。判断依据分别是运行与报告、提供方训练终态，以及部署同步回执。
