# 在 Codex 与 Qoder 对话中使用 秀吉系统

这条入口面向要实际创建、评测、改进和管理数字员工的使用者。Agent 把自然语言请求转换为平台公开操作，平台负责工作区隔离、预算、冻结证据和业务门禁。用户可以在对话中完成工作，不必逐页操作前端；已有前端仍可查看相同的任务与报告。

本文的命令、操作 Schema 和后端路径分别对应 [CLI](../scripts/cli.mjs)、[共享操作目录](../client/operations.mjs)、[MCP 服务](../scripts/mcp-server.mjs) 和 [HTTP API](API.md)。平台能力与已验证边界见 [功能矩阵](FEATURE-MATRIX.md)。例子中的资源 ID、预算和幂等键需按实际工作区及本次请求替换；示例没有执行真实模型，也没有预先给定分数。

## 选择接入方式

| 方式                             | 适用场景                                             | 运行路径与边界                                                                                 |
| -------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 本机 stdio MCP，推荐作为对话入口 | Codex/Qoder 自动发现业务工具，连续完成任务           | Agent 启动本仓连接器，业务操作经过平台 HTTP API，未提供直接数据库操作工具                      |
| CLI                              | 脚本、终端、MCP 不可用时，或需要检查原始 JSON        | 与 MCP 共用闭合的 operation 目录、参数校验和客户端；stdout 为 JSON，错误走 stderr 和非零退出码 |
| 本机连接器访问远端 HTTPS 平台    | 平台部署在服务器上，Agent 运行在本地或另一台可达机器 | stdio 仍在 Agent 所在机器运行，`EVAL_URL` 指向真实远端 HTTPS 根地址，使用平台 Bearer 认证      |

本项目提供 stdio 服务，不把普通 `/api/*` REST 地址冒充 Streamable HTTP MCP endpoint。Codex 和 Qoder 支持的其他 MCP transport 不代表本项目已部署相应远端 MCP 服务。云端 Agent 若无法运行本机进程或访问该网络，需要在其执行环境安装连接器并配置可达的 HTTPS 平台；本机配置不会自动出现在云端。Qoder 官方也明确本地 stdio 不属于其云 Connector 同步范围。[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Qoder Connectors](https://docs.qoder.com/qoder/connectors)

## 安装与最小连接检查

先按[项目启动说明](../README.md#本地启动)安装本仓依赖并构建。Node 路径与仓库路径必须属于运行 Agent 的机器；不要把作者机器的路径原样复制到其他机器。

在仓库根目录生成本机配置：

```sh
node scripts/setup-agent.mjs --client codex
node scripts/setup-agent.mjs --client qoder
```

默认只输出生成片段，便于先检查实际 Node/仓库绝对路径。授权安装时使用：

```sh
node scripts/setup-agent.mjs --client all --install
```

安装器合并指定 MCP server，保留其他服务与 provider 配置，并安装本项目 runtime skill。可用 `--home DIR` 指定待配置用户目录；远端平台使用 `--url https://YOUR-ACTUAL-EVAL-HOST`。这些参数不接收实际 token，安装器不保存凭据。模板也可手动合并，见 [Codex TOML](../integrations/codex/config.toml.example) 与 [Qoder JSON](../integrations/qoder/mcp.json.example)。

默认 MCP 配置启动：

```sh
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/agent-launcher.mjs
```

连接器先检查目标的 `/api/health` 产品身份与 Agent 接口版本，复用健康实例。仅在指定回环 HTTP 地址确实未监听、端口不低于 1024 时启动本机平台；不同产品、旧版本、错误响应或远端 HTTPS 故障均明确失败，不停止未知进程，也不偷偷改连其他平台。平台缺模型配置时仍需由管理员在服务端配置，连接成功不会生成模型调用回执。

已经单独管理服务生命周期的部署可直接使用 `scripts/mcp-server.mjs`。直接 CLI 也不自动启动平台：

```sh
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs doctor
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs capabilities
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs call capabilities
```

`doctor` 只读检查 health/session/status/capabilities，不发送模型请求。核对 checks 中的产品标识为 workloom-eval、已认证工作区和角色符合本次目标，并检查模型配置。裸 `capabilities` 返回本地操作目录及 Schema，不联网；`call capabilities` 读取目标平台的能力、工作区及角色。三者应先于业务写入；HTTP 200 本身不证明目标正确或员工合格。

## Codex 配置与发现

将模板中的 Node 和仓库路径替换为真实绝对路径，然后合并到 `~/.codex/config.toml`。可信项目也可用 `.codex/config.toml`。`command/args` 启动 stdio 连接器，`env_vars` 只传环境变量名称，`env.EVAL_URL` 设目标；不要把 `EVAL_API_TOKEN` 的值写进 TOML。配置位置和字段来自 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

修改后在对应本地 Codex 客户端刷新/重启 MCP，或新开会话，再运行 `codex mcp list` 或对话中的 `/mcp`，检查 `workloom_eval` 实际连接及工具清单。已经运行的聊天不因文件落盘就必然获得新工具。桌面设置的 MCP 页面也支持保存后 Restart；托管 ChatGPT 网页不直接读取本机 Codex 配置。[OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

本项目技能文件为 [SKILL.md](../integrations/skills/workloom-eval/SKILL.md)。Codex 当前官方本地发现位置是用户 `~/.agents/skills/workloom-eval/SKILL.md` 或消费项目 `.agents/skills/workloom-eval/SKILL.md`。可用 `$workloom-eval` 或 `/skills` 选择；未出现时重启或新开本地会话检查。[OpenAI 官方 Build skills](https://learn.chatgpt.com/docs/build-skills)

## Qoder 配置、Skills 与 Rules

Qoder 桌面端可在 Extensions → Connectors → Add Connector → Add custom MCP 的 JSON 入口合并 [模板](../integrations/qoder/mcp.json.example)。用户级配置保存在 `~/.qoder/settings.json` 的 `mcpServers`。保留已有设置，不用模板整体覆盖文件。不要设置跳过所有工具确认的 `trust/alwaysAllow`，按正常宿主权限工作。[Qoder Connectors](https://docs.qoder.com/qoder/connectors)

Qoder CLI 同样读取用户级 `~/.qoder/settings.json`；还支持本项目的 `.qoder/settings.local.json`、共享 `.mcp.json` 等范围。项目/本地配置受目录信任与批准影响。CLI 的 MCP 配置更新需要 `/mcp reload` 或新会话，`qoder mcp list` 可查看配置；实际是否可调用还应在对话中运行只读 doctor。[Qoder MCP reference](https://docs.qoder.com/cli/mcp-reference)、[Qoder 配置层次](https://docs.qoder.com/cli/settings)

模板只包含 `EVAL_URL`，不写 token 字段，也不依赖未验证的字符串插值语法。让启动 Qoder 的进程通过受控环境携带 `EVAL_API_TOKEN`；从桌面图标启动的进程未必拥有终端环境，须用 doctor 核对身份，不能把“终端已 export”当作桌面已认证。

Qoder CLI 的技能可放在 `~/.qoder/skills/workloom-eval/SKILL.md` 或消费项目 `.qoder/skills/workloom-eval/SKILL.md`，使用 `/skills reload` 后检查 `/skills` 或 `/workloom-eval`。Qoder 桌面端支持 Extensions → Skills → Upload Skill 上传本文件，并发现 `~/.agents/skills`；同名时 Qoder 用户管理目录优先，新 task 中用 `/` 选择验证。[Qoder CLI Skills](https://docs.qoder.com/cli/Skills)、[Qoder 桌面 Skills](https://docs.qoder.com/qoder/skills)

[运营 Agent 指引](../integrations/agent-guide/AGENTS.md) 用于消费平台的项目。把条款合并到消费项目已有指令，保留当地规则；不要替换本仓的开发 AGENTS。Codex 在会话开始按目录层次读取 AGENTS；Qoder IDE 官方支持根 AGENTS.md，并有 `.qoder/rules` 及其冲突优先级。它们提供操作方法，不安装网络连接或授予管理员权限。[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Qoder IDE Rules](https://docs.qoder.com/user-guide/rules)

## 凭据与远端平台

默认 `EVAL_URL=http://127.0.0.1:4317`。显式设置时必须是 HTTPS 或本机回环 HTTP 根地址，不含 userinfo、查询、fragment 或业务 API 路径。远端例子里的域名只作说明：

```sh
export EVAL_URL='https://YOUR-ACTUAL-EVAL-HOST'
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs doctor
```

实际 `EVAL_API_TOKEN` 由密码管理器、部署秘密管理或启动器的受控进程环境注入；不要复制到上述命令、终端历史、配置或聊天。`EVAL_SESSION_TOKEN`（eval_session 值）与 `EVAL_SESSION_COOKIE` 为已有受控会话的兼容入口，同样不落盘。客户端没有持久化登录、命令行 token 参数或偷偷请求管理员密码的功能。

管理员通过受控管理员会话管理平台访问凭据：

| API                            | 行为                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `GET /api/agent/tokens`        | 列出当前工作区凭据元数据，无 token 明文                                      |
| `POST /api/agent/tokens`       | `{name,role?,expiresInSeconds?}`，一次返回 `{credential,token,oneTime:true}` |
| `DELETE /api/agent/tokens/:id` | 撤销该凭据                                                                   |

默认 role 为 editor、有效期 7 天；可显式选 viewer/editor/admin，有效期 1 小时至 90 天。数据库只保存 hash。有效角色受凭据角色和所属账号当前角色共同限制，过期/撤销后拒绝。即使 admin Bearer 也不能签发、列出或撤销其他访问凭据，应使用管理员会话。平台访问凭据与 `/api/runner/*` 的节点令牌不同，不可混用。凭据申请和撤销不作为普通对话 MCP 工具公开。

| 角色   | 典型对话能力                                                                             |
| ------ | ---------------------------------------------------------------------------------------- |
| viewer | 查允许展示的工作区资源、任务、报告、版本与事件                                           |
| editor | 上述读取，以及普通资产维护、版本创建、评测/迭代/恢复、知识与数据集导入、人工复核         |
| admin  | 加上模型/工具/设置维护及探测、训练采纳、经验导入、部署/回退/核对和未决模型核对等管理动作 |

403 应按具体缺少的授权处理，不能自动升级角色、换身份或关闭门禁。配置管理操作、密钥注入、用户管理、节点签发与 runner 原语没有随通用业务工具全部暴露；完整 HTTP 能力见 [API](API.md)。

## CLI 与 MCP 操作约定

CLI 调用格式：

```sh
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs call OP --json '{"field":"value"}'
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs call OP --input request.json
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs call OP --input -
```

`--input -` 从 stdin 读取；`--json` 和 `--input` 二选一。请求文件只能保存已授权业务数据，不放凭据或盲测答案。请求大小、Schema 与敏感字段受客户端和服务端检查。普通请求可设置 `--url`、`--timeout-ms`，不能传任意 endpoint、header 或凭据参数。客户端不自动重试写入。

MCP 工具名为 `workloom_eval_` 加 operation 名，包括 `workloom_eval_doctor`；例如 `workloom_eval_job_submit`、`workloom_eval_job_wait`、`workloom_eval_report_export`。宿主可能显示自己的 MCP 命名空间包装，以实际 tools/list 为准。MCP 的资源/提示词用于能力发现和工作流说明，不能替代服务器回执或扩大权限。

CLI 的业务返回为原 JSON 或导出文本包装；MCP 的 `structuredContent` 为 `{ok,operation,result,...}`。后台任务还含 `jobId/jobStatus/terminal/completed/timedOut/nextActions`，业务字段位于 result 中。检查 `ok`、`isError` 和原始业务状态，不能只看到工具响应就认为操作成功。doctor 聚合结果中的 `authenticated/modelConfigured/modelProbeExecuted` 分别表示认证、配置和实际探测状态。

| 常用 operation                                                       | 输入要点                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `resource_list` / `resource_get`                                     | `{kind}` / `{kind,id}`；不接受自报 workspace                       |
| `resource_create`                                                    | `{kind,data,idempotencyKey?}`                                      |
| `resource_update`                                                    | `{kind,id,expectedRevision,data,idempotencyKey?}`                  |
| `knowledge_import` / `dataset_import`                                | 文字知识草案 / 指定不可变 purpose 的场景集合                       |
| `version_create`                                                     | `{employeeId,parentId?,...配置,idempotencyKey?}`，冻结候选，不晋级 |
| `job_submit`                                                         | `{type,payload,budgetTokens?,idempotencyKey?}`                     |
| `job_get` / `job_checkpoints`                                        | `{id}`                                                             |
| `job_wait`                                                           | `{id,timeoutMs?,pollIntervalMs?}`，最长 60000 毫秒                 |
| `job_cancel` / `job_resume`                                          | `{id,idempotencyKey?}`，受状态与恢复条件约束                       |
| `report_export`                                                      | `{id,format:"json"或"markdown"或"html"}`                           |
| `version_export` / `training_export`                                 | `{id}` / `{datasetId}`                                             |
| `training_adopt`                                                     | `{id,idempotencyKey?}`，管理员采纳已成功训练结果为待测候选         |
| `portfolio_get`                                                      | `{employeeId}`，读取可比较的推荐                                   |
| `deployment_submit` / `deployment_rollback` / `deployment_reconcile` | 专用管理员部署动作；reconcile 不重发外部写入                       |
| `model_attempts_list` / `model_attempt_reconcile`                    | 管理员读取未决尝试 / 登记真实供应商核对依据                        |

报告的 Markdown/HTML 及训练 JSONL 导出在 CLI 中封装为 `{format,content,contentType}`；将 `content` 保存为对应文本文件。JSON 报告/版本包保持 JSON。导出仍遵守权限、盲测脱敏和大小限制，不能因是文件而绕过封存。

## 14 种后台任务

下面的 type 都通过 `job_submit` 提交；每种字段以 capabilities 中的严格 Schema 为准，详见 [API 的完整表](API.md#员工版本与评测任务)。

| type                   | 核心输入 / 结果边界                                                     |
| ---------------------- | ----------------------------------------------------------------------- |
| `create_employee`      | requirements 及授权资产 ID；返回员工、冻结初版、开发集、缺口            |
| `evaluate`             | versionId/datasetId，repeats/mode/judgeModelId；保存运行及报告          |
| `optimize`             | train/dev 版本与数据集，有限轮次/候选/预算，可加 validation；不自动部署 |
| `team_evaluate`        | teamId 与 input 或 datasetId；明确顺序的交接                            |
| `memory_evaluate`      | versionId/inputs/scope；岗位记忆候选与隔离                              |
| `long_horizon`         | versionId/inputs/scope；最多 100 步时序测试，不是无限期调度器           |
| `shadow_evaluate`      | versionId 与录制输入或回放数据集；业务工具强制仿真                      |
| `knowledge_regression` | knowledgeId，可指定 datasetId/versionIds；仅刷新目标知识，父子比较      |
| `skill_repair`         | versionId、绑定技能、train/dev 集或开发失败 run；声明式候选             |
| `benchmark_portfolio`  | employeeId/datasetId，可给最多 20 个同员工版本；同条件多目标组合        |
| `browser_evaluate`     | 已绑定工具或管理员注册 task/node/url；不接受任意宿主代码                |
| `fine_tune`            | employeeId/train dataset/providerModelId；必须有真实训练商能力          |
| `poll_training`        | trainingId；主动查询真实提供方，不等于已训练完成                        |
| `reconcile_deployment` | deploymentId，管理员只读远端核对                                        |

回退使用 `deployment_rollback` 专用 operation，不是额外 job type。服务端未核实的供应商能力必须明确拒绝；当前默认 DeepSeek 的通用适配器不证明存在公开托管微调接口。[训练适配边界](TRAINING-ADAPTER.md)

## 对话场景一：从用人要求到可检查的初版

用户可以说：

> 帮我创建一个售后员工，只使用已授权政策和工具；身份核验后可在仿真里处理 500 元以下退款，超额转主管。本次创建预算 40000 tokens，先生成初版和能力缺口，不上线。

Agent 先 doctor/capabilities，再列出知识、工具、技能及模型；只选择实际存在且授权满足要求的 ID。然后提交：

```json
{
  "type": "create_employee",
  "budgetTokens": 40000,
  "idempotencyKey": "aftersale-initial-2026-11-05-request-1",
  "payload": {
    "name": "售后试岗员工",
    "requirements": "根据已授权售后政策处理请求；先核验身份与订单，500元以下只在仿真环境退款，超额交主管，回执不明先核对，不重复退款。",
    "knowledgeIds": ["ACTUAL_AUTHORIZED_KNOWLEDGE_ID"],
    "toolIds": ["ACTUAL_QUERY_TOOL_ID", "ACTUAL_SIMULATED_REFUND_TOOL_ID"],
    "skillIds": ["ACTUAL_BOUND_SKILL_ID"],
    "modelId": "ACTUAL_MODEL_ID",
    "autoEvaluate": false
  }
}
```

通过 `job_submit` 调用后保存实际 job ID，`job_wait` 等待。完成时读取 `employeeId/versionId/datasetId/gaps`，保留缺失身份核验、主管通道等真实缺口；没有合适资产时不创建假资产 ID。

用户随后授权评测时，以返回的真实版本/开发集、固定裁判和新的有限预算提交 `evaluate`。例如：

```sh
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs call job_submit --json '{"type":"evaluate","budgetTokens":60000,"idempotencyKey":"aftersale-eval-2026-11-05-request-1","payload":{"versionId":"ACTUAL_VERSION_ID","datasetId":"ACTUAL_DEV_DATASET_ID","mode":"simulated","repeats":1,"judgeModelId":"ACTUAL_JUDGE_MODEL_ID"}}'
```

结果不只是一句话“创建成功”：交付实际员工/版本/任务 ID、能力缺口、运行/报告 ID、有效与未完成场景、违规及用量。模型为真实调用，业务退款为仿真；生成的开发集不授予生产资格。

## 对话场景二：有限预算迭代并导出比较依据

用户可以说：

> 把这个版本在开发集上改进，最多 2 轮、每轮 1 个候选，总预算 120000 tokens，固定同一裁判；用独立 validation 复核。比基线差就保留基线，导出实际比较报告，不自动发布。

Agent 读取版本、开发集 purpose、验证集及裁判资源，核对当前授权。提交 `job_submit`：

```json
{
  "type": "optimize",
  "budgetTokens": 120000,
  "idempotencyKey": "aftersale-optimize-2026-11-05-request-1",
  "payload": {
    "versionId": "ACTUAL_BASELINE_VERSION_ID",
    "datasetId": "ACTUAL_TRAIN_OR_DEV_DATASET_ID",
    "validationDatasetId": "ACTUAL_VALIDATION_DATASET_ID",
    "judgeModelId": "ACTUAL_FIXED_JUDGE_MODEL_ID",
    "maxRounds": 2,
    "candidatesPerRound": 1,
    "repeats": 1,
    "patience": 2
  }
}
```

用实际 ID 等待：

```sh
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs jobs wait ACTUAL_JOB_ID --timeout-ms 60000 --poll-interval-ms 500
```

等待超时后继续查询该 ID。完成后读取 optimization、baseline/candidate runs 及关联报告，检查 `comparisonHash`、场景退化、违规、tokens/已知费用估算和时延。只有同条件证据才比较；没有改善就交付基线和停止原因。通过 `report_export` 导出实际 report ID；通过 `version_export` 导出选定冻结版本。优化模型写的解释与最终业务状态断言分别报告，不把解释当因果证明。

## 对话场景三：知识更新后定向回归

用户可以说：

> 我批准这份已脱敏的退款政策更新，并允许它发给当前模型。更新知识后只验证绑定员工的受影响版本，用现有回归集和 80000 tokens 比较父子，保留原在用版本。

Agent 在发布前先读取工作区 `autoKnowledgeRegression/defaultBudgetTokens`。本例按默认未开启自动回归处理；若已开启且默认自动任务预算超过 80000，本次发布将与用户预算冲突，先保留草稿/现状，明确冲突并由管理员按用户授权处理，不擅改全局设置或触发超预算任务。自动预算符合本次授权时使用原自动任务，不额外手工提交。

接着读取目标知识及当前 revision，确认用户确实授权发布和模型外发，再执行 `resource_update`，包装为 `{kind:"knowledge",id,expectedRevision,data:{content,published:true,allowedModelEgress:true},idempotencyKey}`。CAS 冲突先重读并合并，不使用过期 revision 强行覆盖。

按已核实的开关执行：已开启时，知识更新会排队，从任务/事件找到对应 sourceRevision 的原任务，不另行重复提交；未开启时，使用 `knowledge_regression`：

```json
{
  "type": "knowledge_regression",
  "budgetTokens": 80000,
  "idempotencyKey": "policy-regression-2026-11-05-revision-N",
  "payload": {
    "knowledgeId": "ACTUAL_UPDATED_KNOWLEDGE_ID",
    "sourceRevision": 2,
    "datasetId": "ACTUAL_REGRESSION_DATASET_ID",
    "versionIds": ["ACTUAL_BOUND_PARENT_VERSION_ID"],
    "mode": "simulated",
    "repeats": 1
  }
}
```

示例 sourceRevision 应替换为更新返回的真实 revision。跟踪同一 job，读取每组 baseline/candidate run、report、comparison 和 gaps。知识更新可能使成绩下降；缺回归数据就报告 gap，不标通过。候选不更新员工在用指针。需要进一步选型时，单独授权 `benchmark_portfolio` 对同员工候选使用相同数据集、裁判条件和有限预算，再读 `portfolio_get`；没有可比较证据时不生成推荐。

## 对话场景四：超时之后核对，不重复扣费或发布

用户可以说：

> 刚才任务等待超时了，查清它的实际状态。不要重新发送模型请求，也不要重复发布。

Agent 对原 job ID 调用 `job_get`；`queued/running` 继续等，终态读取 result/error 与已有 run/report。`job_wait` 返回 `terminal:false/timeout:true` 或 MCP 等待被宿主取消，都不证明服务端任务结束；只有用户要停止业务任务时才调用 `job_cancel`。取消也不证明提供方已撤销已接收的请求。

如果存在未决模型尝试，管理员用 `model_attempts_list` 查原 attempt，并根据供应商真实工单/响应记录执行 `model_attempt_reconcile`。completed 核对需要实际 `responseId` 及完整真实 usage；not_executed 需要确切来源。Agent 不能编造这些字段，不能以新任务或新幂等键绕过预算预留。

部署 `uncertain` 时先读取原 deployment，然后 `deployment_reconcile`，只做远端状态 GET。只有目标版本和原 receiptId/requestId 匹配才补交本地状态；不明确则继续保持 uncertain。不得重新调用 deployment_submit 代替核对。

## 预算、幂等、封存与生产门禁

提交业务前选择显式有限 `budgetTokens`，不要为省略配置而直接使用最大值。token 预算覆盖任务模型链路，不是搜索、外部工具或训练商账单上限；`costUSD` 是已知费率与用量的估算，无法完整估算时不得补零。新生成的候选与自动知识回归都可能消耗真实模型额度。

同一有意操作使用稳定 `idempotencyKey`，仅在请求完全相同时复用。写入超时不代表未发生；先查任务/事件/部署记录，客户端不自动重试。不通过换键、重新建任务、改 revision 绕过不确定状态。

train/dev 可用于优化，validation 用于阶段验证；holdout 的隐藏输入、答案及详细轨迹不能给优化器或对话 Agent。普通导出、报告、检查点仍脱敏。不能把 holdout 改成 dev、复制隐藏题、直接读 SQLite 或改分数来满足门槛。

生产工具写入与员工部署是独立门禁：普通 `evaluate` 不支持 production；真实工具写需要精确、未过期、一次性审批。真实员工部署/回退需要用户对目标和版本的明确授权、管理员角色、当前资产授权、独立 holdout 资格及真实适配器。独立场景数和 Wilson 下界门槛由平台执行，重复同一道题不增加独立样本；本地演示不能替代这些证据。模拟部署真实改变本地指针，但必须标为 simulated；外部生产成功须独立读回版本及回执并保存 `receipt.synced:true`。[API 部署协议](API.md#部署回退与核对)

## 失败处理与验收

| 现象                               | 下一步                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| MCP 未出现                         | 检查实际用户配置、绝对路径、Node 版本；刷新/重启对应本地客户端并核对工具目录，不声称已安装进当前聊天 |
| 端口是其他产品或旧版本             | 修正目标或更新并重启已知平台；连接器不停止未知进程，不偷偷换端口                                     |
| doctor 的 user/role/workspace 不符 | 停止业务写，检查进程环境及凭据归属，不以本机匿名 admin 代替显式失败的 Bearer                         |
| 401                                | 检查 token 是否已注入、过期、撤销；由管理员会话处理，不把 token 发给模型                             |
| 403                                | 按具体角色、资产、出域或生产门禁处理；保留原错误，不自动扩大权限                                     |
| REVISION_CONFLICT                  | 重读当前资源，再按用户意图合并，保留 expectedRevision                                                |
| 等待超时                           | 继续读原 job；CLI wait 退出码 3 表示等待超时，不取消、不重提                                         |
| failed/cancelled/interrupted       | 查原 job/error/run；CLI wait 退出码 2，不报告业务成功                                                |
| 未决模型 / uncertain 部署          | 查原记录并核对证据；不重发外部写入                                                                   |
| 429 / 预算不足                     | 报告已经使用和未完成范围；不自动增加预算或重建任务                                                   |

推荐从只读的 doctor、服务端 capabilities、session、资源列表开始验证，再用有明确范围和预算的正式业务任务验收。没有真实模型/外部生产回执的测试，只证明工具契约、权限和调用链。交付时提供实际 job/run/report/version IDs、终态、完整性、费用口径及限制，不能只展示“工具被调用”。

官方配置核验日期：2026-11-05。平台与宿主后续版本可能改变设置位置或发现方式；升级时先核实上述官方来源，再执行本仓 doctor/capabilities。工具连通、真实模型质量、外部训练能力与客户生产授权分别验收。
