# 私有执行器注册与运行

私有执行器把浏览器操作和受限数据脚本放在指定机器执行。平台只提交管理员预先注册的任务名称、JSON 参数和租约，不向执行器下发任意主机程序。本文适用于运行器管理员与集成开发者；服务端接口见 [API 文档](API.md)。

## 准备运行环境

在执行器机器取得本项目并安装锁文件中的依赖，使用项目声明的 Node.js 24 或更新兼容运行时。浏览器任务需要安装与当前项目 Playwright 匹配的二进制；脚本任务不需要浏览器二进制。

以下命令在项目根目录执行。安装和运行时必须使用相同的 `PLAYWRIGHT_BROWSERS_PATH`：

```bash
pnpm install --frozen-lockfile
mkdir -p work
export PLAYWRIGHT_BROWSERS_PATH="$PWD/work/browser-binaries"
pnpm exec playwright install chromium --only-shell
```

Linux 执行器若缺少浏览器系统依赖，使用对应安装选项：

```bash
pnpm exec playwright install chromium --only-shell --with-deps
```

`pnpm exec` 使用项目依赖中的命令；Playwright 的每个版本需要匹配浏览器，`--only-shell` 安装默认无头模式需要的 Chromium Headless Shell。更新依赖后按新锁文件重新执行安装，不依赖旧缓存目录中的其他浏览器。[pnpm exec 官方说明](https://pnpm.io/cli/exec)、[Playwright 浏览器安装说明](https://playwright.dev/docs/browsers)

默认运行器使用项目匹配的 bundled headless shell。注册表可显式设置 `browserChannel:"chrome"` 等 Playwright channel，使用执行器上安装的对应浏览器；不读取用户日常浏览器 profile。系统浏览器与驱动不兼容时应修复环境配置，不将启动失败记录为业务通过。

## 注册节点与注入认证

管理员在平台“私有节点”页面注册节点，或调用：

```bash
export EVAL_URL='http://127.0.0.1:4317'
curl -sS "$EVAL_URL/api/nodes/register" \
  -H 'Content-Type: application/json' \
  -d '{"name":"受控浏览器与数据执行器","capabilities":["browser","script"]}'
```

密码模式需同时携带管理员会话 Cookie。响应形状如下，示例不含真实凭据：

```json
{
  "node": {
    "id": "node-id-from-api",
    "name": "受控浏览器与数据执行器",
    "capabilities": ["browser", "script"],
    "status": "registered"
  },
  "token": "DISPLAYED_ONCE_TOKEN_PLACEHOLDER",
  "oneTime": true
}
```

保存返回的节点 ID，用于将工具绑定到该节点。token 只在注册响应展示一次，服务端保存其哈希。将实际 token 通过执行器进程环境注入；不要写入注册表 JSON、仓库、任务参数或日志。

管理员可 `POST /api/nodes/:id/revoke` 停用节点，或 `POST /api/nodes/:id/rotate` 生成新 token 并重新启用该节点，均无需请求体。轮换响应与注册响应一样只展示一次新 token；旧 token 立即失去领取、续租与提交能力。更新执行器的环境凭据并重启进程。应先核对在途任务，避免将凭据轮换误当作外部业务动作已经取消的证明。

手动运行时可在 Bash/Zsh 中使用不回显的输入，粘贴刚取得的 token 后回车：

```bash
read -r -s EVAL_RUNNER_TOKEN
export EVAL_RUNNER_TOKEN
```

| 环境变量                   | 必需性与作用                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `EVAL_URL`                 | 必填，平台根地址，例如本机 `http://127.0.0.1:4317`；远端应使用 HTTPS |
| `EVAL_RUNNER_TOKEN`        | 必填，该节点注册时取得的 Bearer token                                |
| `EVAL_RUNNER_TASKS`        | 必填，管理员批准的任务注册 JSON 文件路径                             |
| `PLAYWRIGHT_BROWSERS_PATH` | 自定义安装位置时必填，必须与浏览器安装时一致                         |

运行器 API 连接只允许 HTTPS 或本机回环 HTTP。连接平台的允许范围与浏览器访问业务页面的范围分开配置。节点 capability 必须覆盖任务的 `requiredCapability`；登记过 capability 不等于已安装该能力的运行时。本仓运行器实际执行 `browser/script`，权重训练使用独立 HTTP 适配器。

## 编写任务注册表

将下列 JSON 保存到 `work/runner-tasks.json`。文件不含密钥。`health_probe` 访问同一台机器的平台健康端点，`sum_rows` 对传入的合成数据计算金额总和。

```json
{
  "health_probe": {
    "capability": "browser",
    "browserChannel": "bundled",
    "viewport": { "width": 1440, "height": 1000 },
    "timeoutMs": 60000,
    "allowedHosts": ["http://127.0.0.1:4317"],
    "allowPrivateHosts": ["http://127.0.0.1:4317"],
    "allowInsecure": true,
    "allowMutations": false,
    "inputSchema": {
      "type": "object",
      "required": ["url"],
      "additionalProperties": false,
      "properties": {
        "url": { "type": "string", "format": "uri", "maxLength": 8192 },
        "assertions": { "type": "array", "maxItems": 100 }
      }
    },
    "startUrl": "{{url}}",
    "steps": [
      { "action": "assert_text", "selector": "body", "value": "workloom-eval" },
      { "action": "text", "selector": "body" },
      { "action": "screenshot" }
    ],
    "outputSchema": {
      "type": "object",
      "required": ["url", "title", "results", "runtime"]
    }
  },
  "sum_rows": {
    "capability": "script",
    "timeoutMs": 10000,
    "inputSchema": {
      "type": "object",
      "required": ["rows"],
      "additionalProperties": false,
      "properties": {
        "rows": {
          "type": "array",
          "maxItems": 1000,
          "items": {
            "type": "object",
            "required": ["amount"],
            "additionalProperties": false,
            "properties": { "amount": { "type": "number", "minimum": 0 } }
          }
        }
      }
    },
    "steps": [
      { "action": "select", "path": "rows" },
      { "action": "sum", "path": "amount" }
    ],
    "outputSchema": {
      "type": "object",
      "required": ["result", "runtime", "exitCode"]
    }
  }
}
```

如果平台不是执行器本机，将 health_probe 的地址、允许主机和访问 URL 改成执行器实际可以访问的平台地址。注册表中的 task 名称必须与平台工具的 `config.taskName` 完全一致。平台不能通过一次任务提交临时改写 steps、允许域名或脚本代码。注册表在执行器启动时读取，修改后需重启该运行器。

允许列表支持精确主机或 origin，不支持 `*`。应优先使用含协议和端口的精确 origin。业务页面使用的脚本、样式和图片域名也要列入允许范围。访问私网还需在 `allowPrivateHosts` 中明确批准；HTTP 需要显式 `allowInsecure:true`。浏览器请求经过 DNS 检查和固定解析地址的转发，重定向拒绝后应配置最终地址。

## 启动与单次验证

```bash
export EVAL_RUNNER_TASKS="$PWD/work/runner-tasks.json"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/work/browser-binaries"
pnpm runner
```

运行器持续领取任务；没有任务时每两秒再次查询。使用 `pnpm runner --once` 可以只领取并处理一条任务；没有可领任务则退出。启动前确认上一步已注入 EVAL_URL 和 EVAL_RUNNER_TOKEN。

在管理员工具页面创建只读脚本工具，或向 `/api/resources/tools` 提交以下配置。将 nodeId 替换为实际注册响应的 ID：

```json
{
  "name": "approved_sum_rows",
  "description": "由批准的私有执行器对JSON数据求和",
  "adapter": "script",
  "operation": "calculate",
  "mode": "readonly",
  "permissions": ["read"],
  "inputSchema": { "type": "object", "required": ["rows"] },
  "outputSchema": { "type": "object", "required": ["result"] },
  "config": {
    "taskName": "sum_rows",
    "nodeId": "node-id-from-api",
    "timeoutMs": 60000
  }
}
```

用返回的工具 ID 调用 `POST /api/tools/:id/test`，请求体：

```json
{ "args": { "rows": [{ "amount": 2 }, { "amount": 3 }] } }
```

运行器在线且能力、节点、任务名称均匹配时，结果中的 `result.result` 为 5，receipt 含 executionId 和 nodeId。输入和输出同时受工具 Schema 与注册表 Schema 校验。无节点、未知任务或超时会明确失败，不产生虚构结果。

浏览器环境验证可以提交：

```json
{
  "type": "browser_evaluate",
  "budgetTokens": 100000,
  "payload": {
    "versionId": "version-aftersale-01",
    "nodeId": "node-id-from-api",
    "url": "http://127.0.0.1:4317/api/health",
    "task": "health_probe"
  }
}
```

该任务返回实际浏览器结果和工具回执，用于验证执行器环境。要评估数字员工使用浏览器完成工作的能力，应创建 browser 工具、绑定到新的员工版本，并通过普通 `evaluate` 生成完整的员工运行与报告。`task` 是注册任务名，不是可以随意运行的自然语言指令。

## 浏览器动作和边界

| action        | 字段与行为                                                         |
| ------------- | ------------------------------------------------------------------ |
| `goto`        | `url`，校验地址后导航，等待 DOMContentLoaded                       |
| `fill`        | `selector/value`，使用 Playwright locator 填写可编辑元素           |
| `click`       | `selector`，保留可见、启用和稳定性检查后实际点击                   |
| `text`        | `selector`，读取 innerText，单项最多保留 50,000 字符               |
| `assert_text` | `selector/value`，在有界时间内反复读取实际文字，包含预期内容才通过 |
| `screenshot`  | 当前视口 PNG，结果含 MIME 类型和 base64 内容                       |

浏览器的 `startUrl`、步骤 `url/value` 可以通过 `{{argName}}` 或 `{{nested.path}}` 引用参数；只接受文本、数字和布尔值，不执行表达式。selector 来自管理员注册表。运行器没有任意 JavaScript eval 动作。

每条浏览器任务使用新的上下文，默认视口 1440×1000；管理员可在注册表配置 viewport，宽度范围为 320–3840、高度为 240–2160，均须为整数。需要桌面、390 或 320 宽度回归时，注册对应固定视口的任务。任务输入中的 viewport 不会覆盖注册尺寸，结果会记录实际采用的 viewport。

浏览器不加载用户日常 Cookie、持久 profile 或扩展；任务结束关闭上下文和浏览器。Service Worker、WebSocket 与下载不会成为绕过受控访问的通道。readonly 任务当前可转发 GET/HEAD；HTTP 适配器尚不接受 OPTIONS，需要 CORS 预检的页面应先验证适配条件。只有任务 mode 和绑定工具 toolMode **同时为 test**，且注册表显式 `allowMutations:true` 时，运行器才允许写请求。工具为 production 时，不能借一次 mode=test 评测变成测试环境授权；平台还会在生产浏览器调用排队前保守检查绑定参数的审批。

浏览器任务默认 60 秒，单次启动和动作最多各使用 30 秒；注册任务总时限最多 300 秒。每个转发响应上限 4 MiB，汇总浏览器结果上限 1.5 MiB，超过后返回错误。需要更多证据时拆成多个受控任务。

## 声明式脚本范围

脚本运行器处理 JSON 数据，支持：

| action    | 行为                                 |
| --------- | ------------------------------------ |
| `select`  | 按 path 选取当前数据                 |
| `filter`  | 数组中指定字段与 equals 相等的项     |
| `project` | 根据 fields 映射为指定输出字段       |
| `count`   | 当前数组长度                         |
| `sum`     | 当前数字数组或指定数字字段求和       |
| `sort`    | 按 path 排序，descending 可选        |
| `assert`  | 对当前数据或 path 值进行 equals 断言 |
| `format`  | 在 template 中插入当前数据字段       |

它不是任意 Python、shell 或 Node.js 用户源码执行服务。运行时只启动仓库固定的 worker 文件，不解释任务中的 exec、command 或代码字符串。子进程使用 Node 权限模式、64 MiB JS 堆上限和空环境，脚本输入及输出各不超过 1 MiB，步骤不超过 100，默认 10 秒超时后终止。`constructor/prototype/__proto__` 路径被拒绝。

Schema 校验支持基础类型、properties、required、additionalProperties、enum/const、数组与长度/数值约束、allOf/anyOf/oneOf/not，以及 uri/email/date-time/uuid 格式。不支持的关键字（例如 `$ref/$defs/pattern`）会返回明确的能力错误，不会静默忽略。需要复杂结构时转换为受支持的显式 Schema。

## 领取、续租、完成与失联

服务端领取记录的状态流为 `queued → leased → completed/failed`。claim 根据工作区、节点能力及可选 nodeId 筛选，并返回一次租约的 `leaseId`，租约时长 30 秒。

运行器在任务期间每 10 秒发送 `{taskId,leaseId}` 续租。结果提交也必须携带相同的有效租约。节点不符、旧租约、已结束任务或过期租约均返回 `STALE_LEASE`，不会覆盖新结果。平台取消或工具超时会取消相应执行记录；迟到结果不能让任务复活。

租约过期时记录失败，结果可能不明的外部动作不会自动重放。运行器认证失败或续租失败时应先检查节点 token、服务地址、网络和租约；需要重新运行时创建新的受控评测任务，保留原执行记录作为证据。

## 验证与常见问题

在已安装对应浏览器的环境运行：

```bash
export PLAYWRIGHT_BROWSERS_PATH="$PWD/work/browser-binaries"
pnpm exec node --test tests/advanced.test.mjs
```

测试包含真实本地 HTTP 领取和结果提交、权限子进程计算、独立浏览器填写/点击/文字断言/截图、只读与生产 POST 阻断、仅显式测试环境允许写，以及 320/390/1440 固定视口渲染；不依赖真实模型账户。

| 错误                                                   | 核对事项                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `RUNNER_AUTH_REQUIRED/RUNNER_AUTH`                     | EVAL_URL、token 及平台密码/节点认证方式不要混淆                        |
| `RUNNER_REVOKED`                                       | 节点已停用，使用管理员批准的新注册或轮换流程恢复，不能继续使用旧 token |
| `RUNNER_TASK_UNREGISTERED`                             | taskName、capability 和实际加载的注册表是否一致                        |
| `BROWSER_RUNTIME_UNAVAILABLE` 或浏览器可执行文件不存在 | 依赖是否安装、浏览器是否匹配、安装与启动路径是否一致                   |
| `HOST_NOT_ALLOWED/PRIVATE_NETWORK_DENIED`              | 当前页面及子资源 origin、私网允许范围、HTTP 标记                       |
| `BROWSER_NETWORK_POLICY`                               | 任务是否尝试只读 POST 或其他未批准访问，不要用放开全部域名掩盖问题     |
| `BROWSER_ASSERTION_FAILED`                             | 实际页面和预期是否一致，先读取文字和截图核实                           |
| `RUNNER_TIMEOUT/SCRIPT_TIMEOUT/BROWSER_TIMEOUT`        | 节点是否在线，任务是否耗时超过注册上限                                 |
| `STALE_LEASE`                                          | 结果已迟到或不属于当前租约，保留旧记录，不强行覆盖                     |
