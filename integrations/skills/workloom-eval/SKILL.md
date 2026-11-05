---
name: workloom-eval
description: 使用 秀吉系统 的 MCP 工具或 CLI，从岗位需求创建数字员工、装配授权资产、评测与迭代候选、读取报告和核对运行状态。用于要求在该平台实际完成员工试岗、对比或受控交付的对话；不用于直接改数据库、伪造分数或开发平台源码。
---

# 秀吉系统

通过已安装的 `workloom_eval_*` MCP 工具完成用户授权的业务目标。工具不可用时，使用实际安装目录中的 `scripts/cli.mjs`；不要猜测服务器路径、自动启动另一个平台或改用数据库。

## 发现与调用

先运行 `workloom_eval_doctor`，再运行 `workloom_eval_capabilities`，核对服务身份、当前工作区、角色、能力及模型配置。CLI 等价入口：

```sh
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs doctor
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs capabilities
node /ABSOLUTE/PATH/TO/workloom-eval/scripts/cli.mjs call capabilities
```

CLI 的裸 `capabilities` 是本地操作 Schema，`call capabilities` 是远端平台能力；二者不证明模型已调用。业务调用使用 `call OP --json '{...}'` 或 `call OP --input FILE`；`--input -` 从 stdin 读 JSON。字段以当前 Schema 为准，operation 名前加 `workloom_eval_` 即为对应 MCP 工具名。

默认 `EVAL_URL=http://127.0.0.1:4317`；远端平台使用实际 HTTPS 地址。凭据从 `EVAL_API_TOKEN` 环境注入；兼容的受控会话环境为 `EVAL_SESSION_TOKEN` / `EVAL_SESSION_COOKIE`。不要向用户索要把秘密粘贴到聊天，不把秘密写进文件、业务 JSON、URL、报告或日志。服务端模型密钥与平台 Agent 访问令牌是两种不同凭据。

## 常用业务流程

- **从需求到初版**：读取已授权知识/工具/技能/模型，用 `job_submit` 提交 `create_employee`，payload 含具体 requirements 及选定资产 ID；预算显式、有限。保存返回 ID，等待完成；读取实际 `employeeId/versionId/datasetId/gaps`，不把缺失能力编造成已具备。自动生成集只作开发证据。
- **评测并改进**：读取冻结版本和测试集。提交 `evaluate`，使用 `simulated/test/readonly`。读取 run/report 的完整性、失败和违规；用 train/dev 提交有限轮次 `optimize`，可另设 validation。固定裁判和比较条件；候选未更好时保留基线，不自动晋级。
- **知识变更与多目标选择**：知识更新先读取 revision，使用 `resource_update` 的 `expectedRevision`；发布和模型外发必须已有授权。发布前检查自动回归开关与默认预算，不能触发超过本次授权的任务，也不能擅改全局设置。已排队的同修订回归沿用原 job；否则用 `knowledge_regression` 只刷新目标知识并比较父子。通过 `benchmark_portfolio` 评测同员工候选，再用 `portfolio_get` 读取组合。USD_estimate 是估算，缺完整费率时使用 tokens，不编费用。
- **团队、记忆和外部执行**：`team_evaluate` 为明确顺序交接；`memory_evaluate/long_horizon` 不自动批准生产记忆；`shadow_evaluate` 隔离业务写入；`browser_evaluate` 仅使用管理员登记任务；`skill_repair` 创建声明式候选。
- **训练**：`training_export` 只导出允许的 train 数据；`fine_tune/poll_training` 依赖供应商真实能力和终态。`training_adopt` 只创建待测模型/版本候选，不能宣称训练或生产部署成功。

## 提交、等待、证据

`job_submit` 参数为 `{type,payload,budgetTokens,idempotencyKey}`；幂等键属于同一项有意业务请求，完全相同请求才复用。模型真实调用与仿真业务工具同时出现时仍消耗真实额度；token 预算不等于外部工具/训练费用上限。

`job_wait` 输入 `{id,timeoutMs:60000,pollIntervalMs:500}`。单次等待最多 60 秒；`terminal:false/timeout:true` 后继续查询原 ID，不重发创建。`failed/cancelled/interrupted` 是非成功终态。MCP 请求被取消或 CLI 退出不取消平台任务；用户要求停止业务任务才用 `job_cancel`，其回执不证明外部供应商请求已撤回。

完成后根据真实返回 ID 用 `resource_get` 读取 run/report/version，使用 `report_export/version_export` 导出。检查 run.status、metrics.valid/total/incomplete/violations、comparisonHash、用量及报告限制。202、queued 或任务 completed 均不能单独证明员工合格。

## 必须保留的边界

- 不直接改 SQLite、历史证据、任务状态或分数，不伪造响应/用量/供应商回执。只使用已发现操作；不拼接任意 URL 或调用内部写接口绕过能力目录。
- 不读取或索取 holdout 的隐藏题、答案或详细轨迹，不改数据用途洗白；优化只用 train/dev。重复题不是独立样本。
- CAS 冲突重新读取当前 revision，再结合用户意图更新；不静默覆盖。冻结版本仍受当前权限及知识外发限制。
- 网络超时先查原 job、事件与部署记录。未决模型请求由管理员以真实提供方证据执行 `model_attempts_list` / `model_attempt_reconcile`；不可换键重发。`job_resume` 仅用于符合检查点、剩余预算、冻结条件及无未决调用要求的 standalone simulated evaluate。
- 真实部署/回退须有用户对具体目标和版本的明确授权、管理员角色、真实适配器和平台独立验收门禁；生产工具写还需要一次性审批。`uncertain` 只调用 `deployment_reconcile` 或 `reconcile_deployment` 核对，不重复 POST。只有真实目标版本及回执读回一致、`receipt.synced:true` 才能报告生效。

向用户汇报实际资源/任务/运行/报告 ID、有效证据、成本口径和剩余缺口。没有真实执行结果时明确说明，不用示例、fixture 或本地仿真替代外部生产证明。
