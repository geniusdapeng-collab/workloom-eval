# 使用 秀吉系统 的运营 Agent 指引

本文件面向消费 秀吉系统 服务的项目。它指导对话 Agent 调用已安装的工具或 CLI，不是 秀吉系统 仓库的开发规则。将所需条款合并到消费项目已有指引，保留该项目原有约束；不要用本文件替换本仓根目录的 AGENTS.md。

## 先建立真实连接

优先使用已发现的 `workloom_eval_*` MCP 工具。先调用 `workloom_eval_doctor` 与 `workloom_eval_capabilities`，核对平台身份、工作区、角色、模型可用性与任务类型。工具未出现时先检查安装/刷新，不要声称已连接。

CLI 是同一能力目录的备用入口。使用实际安装路径：

```sh
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs doctor
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs capabilities
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs call capabilities
```

裸 `capabilities` 展示本地客户端 Schema；`call capabilities` 读取正在运行的平台。直接 CLI 不自动启动服务；安装配置使用的 `agent-launcher.mjs` 会复用已通过身份与版本检查的平台，只在指定回环 HTTP 地址未监听时启动本机平台，远端 HTTPS 失败不在本机另开替代服务。远端平台使用真实 HTTPS 地址作为 `EVAL_URL`，本机默认 `http://127.0.0.1:4317`。凭据仅通过进程环境 `EVAL_API_TOKEN` 或受控会话注入；不要写进指令、业务 JSON、日志、提交或聊天。

## 把自然语言目标转换成受控任务

1. 明确岗位目标、已有员工/版本、数据范围、允许动作和预算。能从用户授权及资源目录确定的条件直接采用；缺少预算时先读取设置，说明将采用的有限预算，不把沉默当作生产发布授权。
2. 通过 `resource_list` / `resource_get` 取得真实 ID 和修订。检查知识发布及模型外发授权，工具模式、技能绑定和模型可用性；缺口如实保留。
3. 用 `job_submit` 提交准确类型及 payload，显式设置 `budgetTokens`，为同一业务请求保存稳定的 `idempotencyKey`。模型真实调用即使配仿真工具也会消耗供应商额度。
4. 保存返回的 job ID。用 `job_wait` / `job_get` 跟踪原任务；单次等待最多 60 秒，超时继续查询同一 ID。
5. 从任务实际返回的 `runId/reportId/versionId` 读取证据并导出报告。引用实际分数、有效/计划场景、违规、未完成数、用量和局限；没有结果就说明没有结果。

MCP 工具名在 operation（如 `job_submit`、`resource_get`）前加 `workloom_eval_`；CLI 使用 `call OP --json '{...}'` 或 `call OP --input FILE`。下表的后台任务类型应放进 `job_submit.type`，不是独立的 MCP 工具名。完整字段以当前 `capabilities` 的 Schema 为准。

## 任务选择

| 用户目标                         | 任务或操作                                       |
| -------------------------------- | ------------------------------------------------ |
| 从用人需求生成初版及依赖缺口     | `create_employee`                                |
| 测试冻结版本，保存逐场景证据     | `evaluate`                                       |
| 根据开发失败生成候选并比较       | `optimize`                                       |
| 评测班组顺序交接                 | `team_evaluate`                                  |
| 测试岗位记忆或多步时序记忆       | `memory_evaluate` / `long_horizon`               |
| 回放记录的生产输入，隔离业务写入 | `shadow_evaluate`                                |
| 更新知识后定向比较父子版本       | `knowledge_regression`                           |
| 生成声明式技能候选并回归         | `skill_repair`                                   |
| 在同条件下比较质量、成本、时延   | `benchmark_portfolio`，读取用 `portfolio_get`    |
| 执行管理员登记的浏览器任务       | `browser_evaluate`                               |
| 提交或查询有真实能力的外部训练商 | `fine_tune` / `poll_training`                    |
| 对不确定部署只读核对             | `reconcile_deployment` 或 `deployment_reconcile` |

回退是 `deployment_rollback` 专用操作，不是第 15 种后台任务。训练结果通过 `training_adopt` 形成待测候选，不能把导出 JSONL、提交训练任务或候选创建当作权重已训练/员工已上线。

## 保护证据和并发

- 只通过公开 MCP 工具/CLI 操作；不直接修改 SQLite、任务终态、模型回执、历史版本或分数，不调用本地模块伪造运行。
- train/dev 用于改进，validation 用于阶段验证。holdout 只能按平台封存流程评测，不索取隐藏输入、答案、逐题轨迹，不通过日志、导出、检查点或修改用途绕过隔离。
- 更新资源先读取当前 `revision`，传 `expectedRevision`。遇 `REVISION_CONFLICT` 重新读取并合并用户意图，不盲目覆盖。
- 同一幂等键只用于完全相同的请求；请求内容改变则是新的有意操作。网络错误不证明写入未发生，先读原任务/事件/部署记录，不自动换键重发。
- 同条件比较检查冻结清单和 `comparisonHash`；固定独立裁判、测试集、重复次数与模式。重复同一题不会增加独立场景数，开发集好成绩不等于生产资格。
- 知识发布也可能触发真实计费回归。发布前读取 `autoKnowledgeRegression/defaultBudgetTokens`；自动任务预算超过本次授权时先处理具体预算冲突，不直接发布触发超额任务，也不擅自改全局设置。已经排队的同修订回归沿用原 job，不重复手工提交。

## 状态不明时

`queued` 是受理，`completed` 是任务调度结束，还要检查 run 完整性和报告。`failed/cancelled/interrupted` 是非成功终态；`job_wait` 的 `terminal:false/timeout:true` 是等待未结束，不是失败或取消。

MCP 调用取消或 CLI 进程退出不等于服务端任务取消。只有用户要求停止该业务任务时调用 `job_cancel`；它也不能证明已被供应商接收的请求已撤回。恢复仅适用于平台允许的中断/失败/取消 standalone simulated evaluate，有检查点、剩余预算和一致条件且无未决模型请求。

存在未决供应商请求时，管理员先查 `model_attempts_list`，按真实供应商证明调用 `model_attempt_reconcile`；不得编造 `responseId/usage/source`，也不得以重建任务绕过预算预留。部署 `uncertain` 使用 `deployment_reconcile`，只核对远端状态，不重发发布 POST。

## 生产边界与汇报

普通评测只使用 `simulated/test/readonly`。真实部署/回退要求用户对目标、版本和范围的明确授权、管理员角色、真实目标适配器及平台独立 holdout 门禁；工具生产写入还需精确、未过期、一次性审批。角色或审批不足时保留已完成结果和具体阻塞，不扩大权限或改用其他身份。

只有版本与回执独立读回匹配，且部署记录的 `receipt.synced` 为真，才能报告对应目标已生效；`simulated` 部署只能报告本地仿真指针已更新。汇报包含实际 IDs、状态、证据来源、指标口径和未覆盖范围，不用“调用已提交”替代交付结果。
