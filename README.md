# WorkLoom Eval

数字员工评测与迭代平台。把用人需求转换为员工初版，绑定知识、工具、技能和真实模型，在有状态仿真里试岗，依据失败证据生成下一版本，再比较收益、退化和适用范围。

本项目是独立 WorkLoom 产品，产品标识为 workloom-eval，应用标识为 com.workloom.eval。不会修改或同步其他 WorkLoom 仓库。

项目采用 [Apache License 2.0](LICENSE) 开源，版权声明见 [NOTICE](NOTICE)。前端随附依赖的原始许可与版权声明保存在 [THIRD_PARTY_NOTICES.txt](public/THIRD_PARTY_NOTICES.txt)，构建后可通过 `/THIRD_PARTY_NOTICES.txt` 读取。其他依赖按各自许可证分发。

## 使用路径

1. 打开工作空间，点击“描述你的用人需求”。
2. 输入工作目标、业务范围和边界；平台匹配当前工作区的资产，生成员工、冻结初版、开发用例及缺口清单。
3. 补齐或调整知识、工具、技能，启动评测。示例售后环境使用合成订单和仿真退款，模型为真实调用。
4. 在三栏工作台查看任务输入、检索和工具轨迹、最终业务状态、断言与裁判依据。
5. 启动自动迭代，配置开发集、候选数、轮次和预算。每个候选都保留改动、评测、比较及停止原因。
6. 使用独立验证/盲测建立上岗证据；导出版本包和报告。部署、推荐与评测状态分别管理。

## 本地启动

需要 Node.js 24 或更高版本，以及 pnpm。项目带锁文件。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

默认地址 http://127.0.0.1:4317。默认仅绑定回环地址，使用本机可信会话；不会向局域网公开匿名管理入口。首次运行创建合成示例知识、工具、技能、员工和测试集，不预填评测分数。

Mac 可双击 scripts/start-local.command。脚本会定位 Node，按需构建，隐藏输入模型密钥，启动完整服务。没有密钥时仍可进入界面配置；业务模型调用会明确失败，不使用模拟模型替代。

在“模型与平台设置”录入凭据，当前会话只保存在服务器进程内存。重启后重新录入，或由部署平台受控环境变量注入 DEEPSEEK_API_KEY。密钥不进入 SQLite、版本包、报告、Git、日志或浏览器存储。

## 默认模型与搜索

默认 canonical API 模型为 deepseek-flash。2026-11-04 核实的官方映射为 DeepSeek-V4.1-Flash-1017。请求模型、官方映射与实际响应标识分别记录；别名未来变化后应重新建立基线。

模型生成、评审、优化共用单一分发器。思考模式按场景明确设置，工具循环保留供应商需要的瞬态历史，不保存原始思考过程。结构错误、截断、模型身份不符和缺少有效用量均不算成功。结果不明的请求保留持久预算预留，禁止自动重复发送，管理员可提交供应商核对依据。

Flash 的搜索由平台桥接 DeepSeek 官方 Search/Fetch API，留下真实工具回执；不会把 Responses 的 web_search 字段当作 Flash 已执行搜索。员工版本冻结搜索授权，岗位策略可关闭公开搜索。客户标识、凭据、内部知识原文和私网读取在搜索入口受限。

官方依据：

- [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)
- [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [Search](https://api-docs.deepseek.com/api/search/)
- [Fetch](https://api-docs.deepseek.com/api/fetch/)
- [Responses 兼容性](https://api-docs.deepseek.com/guides/responses_api/)

## 产品范围

P0：需求生成初版、资产装配、不可变版本、有状态仿真、批量评测、逐场景检查点、规则与语义裁判、自动迭代、报告、角色权限与预算。

P1：班组交接、浏览器/声明式脚本私有节点、技能修复、影子回放、真实部署回执与回退、人工复核、受限恢复。

P2：训练集 JSONL 导出及供应商异步微调任务管理、长期记忆评测、审核经验复用、质量/成本代理/时延的 Pareto 版本组合。

权重微调管理具有可执行的供应商适配器；当前没有已核实的 DeepSeek 公共托管微调端点，因此默认 DeepSeek 配置会明确返回能力不支持。通用训练接口的本地 HTTP 合约测试不代表已经训练了 DeepSeek 模型。接入具备实际训练能力的服务后，训练任务和结果模型来自该服务真实回执。

浏览器只运行管理员注册的步骤；脚本当前为受限声明式数据处理，在 Node 权限子进程执行，不支持任意生成的 Python/宿主代码。MCP 适配器当前执行 HTTP initialize、initialized 和 tools/call，接受配置的 2025-06-18 或 2025-11-25 协议标识，读取 JSON 或有界 SSE 响应；没有提供 stdio 子进程、工具目录自动发现或任意 MCP 能力兼容承诺。外部接入仍需网络允许列表、Schema、权限和实际目标验证。

## 运行与数据

- SQLite WAL 持久化工作区资源、任务、版本、评测及事件，默认 .runtime/eval.sqlite。
- 关键事件追加并形成摘要链；版本、报告、运行、检查点和模型收据不可覆盖。
- 历史快照与当前授权共同约束执行。撤销权限不会被历史版本绕过。
- 数据集用途和来源不能通过通用编辑改写；盲测详情不出现在通用 API、报告或检查点视图中。
- 每场景立即保存证据；中断仿真任务可在条件一致且无未决请求时复用完成场景，继续剩余任务。
- 工具模式、模型模式和数据来源分别标记，仿真回执不代表真实业务执行成功。

## 验证

```sh
pnpm check
pnpm test
pnpm build
```

测试包含实际 SQLite 持久化、租户/角色权限、预算异常、冻结依赖、盲测、断点恢复、HTTP/MCP、私有脚本与浏览器、训练适配、并发部署和回退核对。测试模型 stub 仅用于隔离逻辑；真实 DeepSeek 验收单独记录。

浏览器测试需匹配的 Playwright Chromium，可安装：

```sh
pnpm exec playwright install chromium
```

测试使用独立上下文，不连接用户已登录浏览器。受资源限制或无浏览器运行时时，失败会明确报告，不静默跳过。

## 文档

- [功能与证据矩阵](docs/FEATURE-MATRIX.md)
- [架构与数据边界](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [部署](docs/DEPLOYMENT.md)
- [私有执行器](docs/PRIVATE-RUNNER.md)
- [训练适配协议](docs/TRAINING-ADAPTER.md)
- [验收记录](docs/ACCEPTANCE.md)
- [界面说明](docs/UI-NOTES.md)

## 交付边界

代码仓库、可运行本地服务与前端构建是本次交付面。公网生产域名、云主机、组织身份源和外部训练商账号需目标环境配置，不由“代码已构建”推断已经上线。生产部署必须启用密码/会话鉴权并配置受控秘密、网络允许列表与持久卷，见部署文档。

## 通过 Codex / Qoder 对话使用

平台提供 35 个共享操作的 JSON CLI 和 stdio MCP 服务端。Agent 可以发现能力、配置授权资产、提交并跟踪评测/迭代、读取报告，无需在网页中逐项操作。

```sh
pnpm cli capabilities
pnpm cli doctor
pnpm agent:setup --client codex --install
```

安装器将本机 MCP 连接和运行 Skill 合并至用户配置，保留其他模型提供方与连接器；新聊天或重载后调用 `workloom_eval_doctor` 验证。MCP launcher 会复用已运行的平台，或在需要时启动本机服务。远端平台通过 HTTPS 和受限 Bearer 凭据连接；凭据只从受控环境读取。

完整安装、Qoder 配置、认证、对话示例及恢复边界见 [Agent 集成指南](docs/AGENT-INTEGRATION.md)。消费项目可参考 [运营 Agent 指引](integrations/agent-guide/AGENTS.md)；本仓开发仍遵循根 AGENTS.md。
