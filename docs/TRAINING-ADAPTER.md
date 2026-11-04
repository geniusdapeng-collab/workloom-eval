# 模型权重训练管理与异步适配协议

本平台已经实现训练数据导出、受控 HTTP 训练提交、外部任务轮询、结果模型标识和训练回执管理。实际权重更新由接入的训练提供方执行，平台不把提示词或技能改进标成模型权重训练。本文供模型平台管理员和训练服务集成开发者使用。

## 当前能力与 DeepSeek 边界

默认 DeepSeek 连接用于真实推理、评分、改进以及官方搜索。当前核实的公共 API 文档没有给出可用的 DeepSeek 托管权重微调提交端点，本仓对该能力返回 `FINE_TUNING_UNSUPPORTED`，不会生成一个看似正在训练的外部 ID。“未找到已核实接口”不等于“该提供方永远不支持”；接入新能力前需要核对新的官方接口、权限和实际回执。[DeepSeek API 文档](https://api-docs.deepseek.com/api/deepseek-api/)

这里的 `workloom-async-v1` 是本平台的通用 HTTP 适配契约，不是某个供应商官方 API 的别名。如果训练服务原生接口不同，应在受控网关中转换协议，或实现相应适配器，再进行端到端验证。

| 能力                   | 当前行为                                                                          |
| ---------------------- | --------------------------------------------------------------------------------- |
| 提示词与声明式技能改进 | `optimize/skill_repair` 产生员工候选版本，通过评测比较，不修改基础模型权重        |
| 训练 JSONL             | 只导出非隐藏且有参考答案的 train 数据集                                           |
| 通用权重训练管理       | 对配置了 `workloom-async-v1` endpoint 的提供方实际 POST，再按实际外部 ID GET 轮询 |
| DeepSeek 公共托管微调  | 当前没有已核实端点，明确拒绝；仍可使用导出数据、自建或其他可用训练服务            |
| 权重文件保存           | 本契约记录 `resultModel` 标识，不会凭此声称下载或托管了模型权重文件               |

## 训练数据准备与导出

通过 `POST /api/datasets/import` 创建用途为 train 的数据集，示例使用合成材料：

```json
{
  "name": "合成客服训练集",
  "purpose": "train",
  "description": "已审核的任务与正确回答配对",
  "cases": [
    {
      "name": "缺订单号先澄清",
      "input": "我想退款。",
      "expected": "请先提供订单号，以便核验订单与退款条件。",
      "assertions": []
    },
    {
      "name": "高额退款升级",
      "input": "我的订单已核验，金额600元，能直接退款吗？",
      "expected": "按当前示例政策，超过500元需要主管审批，我会转交处理。",
      "assertions": []
    }
  ]
}
```

返回的数据集 ID 用于导出：

```bash
export EVAL_URL='http://127.0.0.1:4317'
mkdir -p work
curl -sS "$EVAL_URL/api/training/export/TRAIN_DATASET_ID" -o work/training.jsonl
```

将 TRAIN_DATASET_ID 替换为实际 ID，密码模式请求需携带会话 Cookie。输出为 UTF-8 JSONL，每行一个对象，最后保留换行：

```jsonl
{"messages":[{"role":"user","content":"我想退款。"},{"role":"assistant","content":"请先提供订单号，以便核验订单与退款条件。"}]}
{"messages":[{"role":"user","content":"我的订单已核验，金额600元，能直接退款吗？"},{"role":"assistant","content":"按当前示例政策，超过500元需要主管审批，我会转交处理。"}]}
```

场景如含 system 字段，会在对应行加入 system 消息。非文本 input/expected 使用 JSON 字符串表示。字符串内部的换行和引号按 JSON 转义，不能按肉眼显示的换行随意拆记录。

导出会拒绝空数据集、dev/validation/holdout 数据集、隐藏用例、其他数据集成员以及缺少参考答案的场景。优化器失败样本和业务录制输出应先审核，不能直接把未知正确性的输出当成训练标签。

## 配置训练提供方

管理员需要提供一个实际可访问的训练服务地址，并在平台服务启动时配置服务端允许范围：

```bash
export EVAL_ALLOWED_HOSTS='training.example.test'
```

示例域名不是可用的训练商，应替换为真正的服务主机，不要保留占位值。私网 endpoint 另外需要 `EVAL_PRIVATE_HOSTS`；受控开发 HTTP 测试还需要 `EVAL_ALLOW_HTTP=1`。默认策略不接受重定向，应该填写最终地址。凭据由服务端注入，不能放进 URL 或配置对象正文。

管理员通过 `/api/secrets` 配置进程内密钥引用，或在管理界面填写会话密钥。示例形状如下，不含真实凭据：

```json
{ "ref": "training-session", "value": "REPLACE_ONLY_IN_MEMORY" }
```

然后通过模型资源接口创建训练连接：

```json
{
  "name": "受控训练网关",
  "provider": "http-training",
  "baseUrl": "https://training.example.test",
  "model": "provider-base-model-id",
  "contextTokens": 100000,
  "maxOutputTokens": 20000,
  "secretRef": "training-session",
  "status": "configured",
  "training": {
    "protocol": "workloom-async-v1",
    "endpoint": "https://training.example.test/training/jobs"
  }
}
```

baseUrl 需要有效的无 URL 凭据 HTTPS 地址；`training.endpoint` 是训练提交地址。上面的 contextTokens/maxOutputTokens 是合成协议配置示例，不代表任何供应商规格，接入实际服务时必须替换成已核实的限制。仅提供训练接口的连接不应直接绑定为员工推理模型；推理接入要求另有兼容的模型响应接口。模型资源 ID 是下面 `providerModelId` 使用的值。

如果训练与推理使用不同主机，可在 training 中配置 `inferenceBaseUrl`，同样需要服务端主机允许范围；创建权重候选时优先使用该地址。平台在提交时冻结 providerSnapshot 中的推理配置、上限和 secretRef，并记录员工当时的 baselineVersionId。

平台提交时保存训练提供方配置快照和数据摘要。提交、轮询及训练结果采纳均复检当前提供方的 revoked、disabled/revoked 状态与 permissions.denied／permissions.enabled=false；拒绝时不发送请求，轮询拒绝也不覆盖既有训练状态。轮询使用提交快照的 endpoint。修改实时配置不会悄悄把历史训练任务的 ID 发给另一个提供方。

## 提交训练任务

对 `POST /api/jobs` 提交：

```json
{
  "type": "fine_tune",
  "budgetTokens": 300000,
  "payload": {
    "name": "客服标签模型候选",
    "employeeId": "employee-id-from-api",
    "datasetId": "train-dataset-id-from-api",
    "providerModelId": "training-model-resource-id-from-api",
    "configuration": { "epochs": 1 },
    "suffix": "support-candidate"
  }
}
```

configuration 原样传给受控网关；也接受 hyperparameters 作为其别名。epochs 只是此示例的自定义字段，必须由实际网关校验和解释，平台没有声称所有提供方使用同一超参数。

API 返回 202 和平台排队任务。任务运行后会创建 training 记录，再向 endpoint 提交 JSON。平台任务的 token 预算控制自身模型调用，不能据此限制训练提供方的 GPU 时间或训练费用；这部分应由实际提供方和 configuration 共同约束。

## workloom async v1 提供方协议

设 endpoint 为 `https://training.example.test/training/jobs`。

### 提交

请求为 `POST endpoint`。若 secretRef 已配置，则带 `Authorization: Bearer <会话凭据>`，内容类型为 application/json。

```json
{
  "baseModel": "provider-base-model-id",
  "trainingData": [
    {
      "messages": [
        { "role": "user", "content": "合成任务" },
        { "role": "assistant", "content": "经审核的参考回答" }
      ]
    }
  ],
  "configuration": { "epochs": 1 },
  "suffix": "support-candidate",
  "clientRequestId": "platform-training-record-id"
}
```

trainingData 是从导出行解析得到的数组，不是一个本地文件路径，也不是自动可访问的下载 URL。clientRequestId 为平台训练记录 ID，提供方应记录该标识，并用于查询和去重。网关应只在持久受理后返回实际的提供方任务 ID。

成功提交的最小响应：

```json
{ "id": "provider-job-id", "status": "queued" }
```

提交响应允许 status 为 `queued/running/succeeded/failed`。返回 succeeded 时必须同时提供非空的 resultModel；平台不会根据“接口可连通”自行认定训练完成。

### 轮询

平台发送：

```http
GET /training/jobs/provider-job-id
Authorization: Bearer <会话凭据>
```

外部 ID 以 URL 组件编码后追加到 endpoint 路径。响应 ID 必须与提交回执的 ID 相同：

```json
{
  "id": "provider-job-id",
  "status": "running",
  "metrics": { "completedSteps": 20 }
}
```

完成例子：

```json
{
  "id": "provider-job-id",
  "status": "succeeded",
  "resultModel": "provider-trained-model-id",
  "metrics": { "validationLoss": 0.2 }
}
```

失败例子：

```json
{
  "id": "provider-job-id",
  "status": "failed",
  "error": { "code": "DATA_REJECTED", "message": "提供方拒绝了训练数据" }
}
```

轮询允许 `queued/running/succeeded/failed/cancelled`。metrics 是提供方原始指标字段，不假定不同训练商可横向比较。响应 ID 不匹配、未知状态或 succeeded 没有 resultModel 时，平台返回 `TRAINING_INVALID_RECEIPT`，不会用客户端期望值补齐。

### 平台状态与主动拉取

fine_tune 平台任务的结果包含 `trainingId/status/externalJobId`。这里的 job completed 代表提交动作完成，外部训练可能仍为 queued/running。

使用 trainingId 提交轮询任务：

```json
{
  "type": "poll_training",
  "payload": { "trainingId": "training-record-id-from-api" }
}
```

然后读取 `GET /api/resources/training/:id`。记录包含数据摘要、提供方快照、externalJobId、status、resultModel、metrics，以及 `{id,status,observedAt}` 回执。当前实现是主动轮询，没有把持续自动轮询、供应商计费查询或外部取消操作伪装成已经接通。

取消平台队列任务只能取消平台当前的执行或请求，不保证提供方已受理的训练随之终止。需要取消外部训练时，使用实际提供方的已授权管理方式并核对终态。

## 训练错误与结果采纳

| 情况                       | 行为                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| DeepSeek 公共连接          | 返回 `FINE_TUNING_UNSUPPORTED`，不创建虚构训练记录或 ID                  |
| 没有 endpoint 或协议不匹配 | 返回 `FINE_TUNING_CAPABILITY_REQUIRED`                                   |
| 提供方授权被撤销           | 返回 `TRAINING_PROVIDER_REVOKED`，不继续提交或轮询                       |
| 数据集不合格               | 在提交前拒绝导出和训练                                                   |
| 提交缺少有效 id/status     | `TRAINING_INVALID_RECEIPT`，本地提交记录失败                             |
| 结果或网络不明             | 记录实际提交错误；先按 clientRequestId 与提供方核对，不自动重复训练 POST |
| 轮询暂时失败               | 保留已有外部 ID 和状态，不用模拟终态替代                                 |

提交传输失败后的本地 failed 只表示没有取得可接受回执，不足以证明提供方未受理或未计费。再次创建训练前应核对原 clientRequestId。平台没有声称已自动查询供应商账单。

### 采纳为待测权重版本

获得真实 succeeded 回执和 resultModel 后，管理员调用以下端点，无需请求体：

```http
POST /api/training/TRAINING_RECORD_ID/create-version
```

成功返回 201：

```json
{
  "trainingId": "training-record-id",
  "modelId": "new-model-resource-id",
  "candidateVersionId": "new-frozen-version-id",
  "baselineVersionId": "submission-baseline-version-id",
  "promoted": false
}
```

采纳操作校验真实外部任务 ID、succeeded 回执和结果模型标识，并复检当前提供方与基线授权。它根据提交时 providerSnapshot 注册非默认、待测推理模型，复用冻结 secretRef 和推理限制，基于提交时 baselineVersionId 创建新的员工候选，保留非模型知识、工具、技能和策略快照。重复调用返回同一候选，不反复注册模型，也不改变默认 DeepSeek 连接或员工在用指针。

未成功、回执不匹配、缺少提交基线或冻结推理配置时拒绝创建候选。旧记录缺少这些信息时，不能把后续修改的实时配置当作训练时的证明。新候选需要执行真实模型连通测试，在同一测试集和固定评分条件下比较，并通过独立验收。

比较基线与训练权重时，在两次 evaluate 的 payload 中指定同一 judgeModelId，或预先配置数据集 judgeModelId／工作区 settings.defaultJudgeModelId。选择优先级为任务、数据集、工作区；均未设置时，兼容使用各员工版本的模型，跨权重比较便可能同时改变裁判。manifest 将 workerModelConfigHash 与 judgeModelConfigHash 分别记录；被测权重可以不同，数据集、裁判配置及其他评分条件相同后，comparisonHash 才可比较。训练候选既不会自动成为创建员工时的默认模型，也不会自动修改默认裁判。

训练完成和创建候选均不会自动获得生产部署资格。真实部署的 POST、独立 GET 回读与 uncertain 核对规则见 [API 文档的部署部分](API.md#部署回退与核对)。

## 可执行协议验收

仓库测试使用真实本地 HTTP 参考提供方验证：POST 接收实际导出的训练消息、返回外部测试 ID，再由 GET 返回匹配 ID 的终态和结果模型；它验证协议管理链路，不声称进行了一次实际权重训练。

```bash
pnpm exec node --test --test-name-pattern='训练JSONL|DeepSeek微调|通用异步微调' tests/advanced.test.mjs
```

接入一个真实供应商时，另外验证其数据授权、持久任务 ID、失败和取消状态、结果模型推理端点与实际费用边界。验收结果应保存供应商回执与评测报告，不能把上述参考服务测试当作该供应商已经训练成功的证明。
