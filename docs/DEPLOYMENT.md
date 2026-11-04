# WorkLoom Eval 部署

## 本机工作台

Node 24+，pnpm 安装锁定依赖，运行 pnpm build、pnpm start。默认 HOST=127.0.0.1、PORT=4317、EVAL_AUTH_MODE=local。回环可信模式只允许本地主机名，拒绝外站写请求；不能配合0.0.0.0使用。

Mac 的 scripts/start-local.command 隐藏读取密钥，不写配置文件。进程内录入的 API key 在重启后失效，可再次在设置页录入。持久数据位于 .runtime/eval.sqlite；密钥不在库里。

## 私有服务器

启动前由宿主机秘密管理注入：

| 变量                | 含义                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| HOST                | 服务器监听地址；远端可设0.0.0.0                                                          |
| PORT                | 默认4317                                                                                 |
| EVAL_PUBLIC_ORIGIN  | HTTPS反向代理的实际公开origin，例如https://eval.example.com，影响来源校验与Secure Cookie |
| EVAL_AUTH_MODE      | 远端必须password                                                                         |
| EVAL_ADMIN_EMAIL    | 首次管理员邮箱，默认admin@workloom.local                                                 |
| EVAL_ADMIN_PASSWORD | 首次管理员密码，至少12位，之后只保留加盐hash                                             |
| EVAL_DB_PATH        | 持久SQLite路径                                                                           |
| DEEPSEEK_API_KEY    | 默认模型的受控环境密钥                                                                   |
| EVAL_ALLOWED_HOSTS  | 允许工具/模型连接的精确主机或origin列表，逗号分隔                                        |
| EVAL_PRIVATE_HOSTS  | 明确许可的私网主机，默认空                                                               |
| EVAL_ALLOW_HTTP     | 仅专用测试环境需要时设1；生产使用HTTPS                                                   |

默认外连主机为api.deepseek.com。新增自建工具/训练/部署端点，需要管理员在服务启动环境中加入允许范围；工具资源自身配置只能收紧范围。

使用HTTPS反向代理转发到4317，保留Host及Origin，并设置EVAL_PUBLIC_ORIGIN为实际HTTPS站点；不要通过跨站匿名前端访问本机管理接口。生产Cookie使用HttpOnly和SameSite，HTTPS请求下启用Secure。登录凭据和会话不写日志。

## 容器

Dockerfile 使用Node24 Debian镜像构建前端和完整服务，默认password鉴权、端口4317，持久卷/data。运行时通过受控环境传入管理员初始凭据与模型密钥；不要将密钥写到Dockerfile、镜像或Git。容器仅运行控制平台；浏览器/脚本由独立私有节点执行。

本机未提供Docker引擎时，不能据Dockerfile存在声称镜像已经构建通过。以CI、目标主机容器实际构建和健康检查为准。

## 数据备份和恢复

停止写入后备份SQLite主文件，或使用SQLite在线备份接口生成一致快照；不要仅复制WAL仍活跃时的主文件。恢复到新路径后，用EVAL_DB_PATH启动，检查/api/health、设置页的事件链状态及历史任务。API key按秘密管理重新注入。

启动会将运行中任务标记interrupted，保留检查点，不自动重发模型或工具。真实在途部署变为uncertain，保留排他状态，管理员执行“核对远端状态”；该动作只GET读回，不重复POST。

## 升级

使用GitHub main的已验证提交安装锁定依赖并构建，先备份库，再重启服务。旧员工版本和证据不静默迁移为新能力。模型或评分条件更新后重新评测。每次代码集成与实际目标部署分别保存提交和回执，不把PR创建当成完成。
