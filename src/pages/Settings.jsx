import { useEffect, useState } from "react";
import {
  Activity,
  Cpu,
  History,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { request, post, update, num, statuses } from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Section,
  Json,
  FactList,
} from "../components";
import { fields, options } from "../forms";
import { ModelAttempts } from "./ModelAttempts";

export function Settings({ ctx }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [testErrors, setTestErrors] = useState({});
  const [regressionSaving, setRegressionSaving] = useState(false);
  const [regressionError, setRegressionError] = useState(null);
  const [regressionDraft, setRegressionDraft] = useState(null);
  useEffect(() => {
    request("/api/status").then(setStatus).catch(setStatusError);
  }, []);
  function credential(model) {
    ctx.setForm({
      title: "配置运行凭据",
      subtitle:
        "密钥仅保存在当前服务进程内，不写入资源记录、仓库或报告；服务重启后请重新注入或使用环境变量。",
      fields: [
        {
          key: "ref",
          label: "凭据引用名",
          default: model?.secretRef || "DEEPSEEK_API_KEY",
          required: true,
        },
        { key: "value", label: "API Key", type: "password", required: true },
      ],
      submitLabel: "保存到运行进程",
      submit: (body) =>
        ctx.action(
          "secret",
          () => post("/api/secrets", body),
          "凭据已注入运行进程",
        ),
    });
  }
  return (
    <>
      <Section
        title="真实模型连接"
        sub="生成、评分与优化统一经过模型路由，记录实际模型与调用用量。"
        action={
          <div className="inline-actions">
            <Button
              icon={ShieldCheck}
              disabled={!ctx.canEdit}
              onClick={() => credential()}
            >
              配置凭据
            </Button>
            <Button
              primary
              icon={Plus}
              disabled={!ctx.canEdit}
              onClick={() => ctx.editResource("models")}
            >
              添加模型
            </Button>
          </div>
        }
      >
        <div className="model-cards">
          {ctx.data.models.map((m) => (
            <div className="model-card" key={m.id}>
              <div className="model-card-header">
                <span className="model-logo">
                  <Cpu size={25} />
                </span>
                <div>
                  <h3>{m.name}</h3>
                  <code>{m.model}</code>
                </div>
                <Badge
                  value={
                    m.secretConfigured
                      ? "connected"
                      : m.status || "unconfigured"
                  }
                >
                  {m.secretConfigured
                    ? "凭据已就绪"
                    : statuses[m.status] || "待连接"}
                </Badge>
              </div>
              <FactList
                entries={[
                  ["供应商", m.provider],
                  ["API 地址", m.baseUrl],
                  ["上下文上限", num(m.contextTokens)],
                  ["输出上限", num(m.maxOutputTokens)],
                  ["凭据引用", m.secretRef],
                  ["搜索", m.search ? "允许官方搜索工具桥接" : "关闭"],
                ]}
              />
              {testErrors[m.id] && <ErrorBox error={testErrors[m.id]} />}
              <div className="model-card-actions">
                <Button disabled={!ctx.canEdit} onClick={() => credential(m)}>
                  配置密钥
                </Button>
                <Button
                  disabled={!ctx.canEdit}
                  onClick={() => ctx.editResource("models", m)}
                >
                  编辑
                </Button>
                <Button
                  primary
                  icon={Activity}
                  busy={ctx.actionBusy === m.id}
                  disabled={!ctx.canEdit}
                  onClick={async () => {
                    setTestErrors((previous) => ({
                      ...previous,
                      [m.id]: null,
                    }));
                    try {
                      const r = await ctx.action(
                        m.id,
                        () => post("/api/models/" + m.id + "/test", {}),
                        "模型连通测试已完成",
                      );
                      ctx.setDialog({
                        type: "result",
                        title: "模型连通测试",
                        value: r,
                      });
                    } catch (failure) {
                      setTestErrors((previous) => ({
                        ...previous,
                        [m.id]: failure,
                      }));
                    }
                  }}
                >
                  真实调用测试
                </Button>
              </div>
            </div>
          ))}
        </div>
        {!ctx.data.models.length && (
          <Empty
            title="添加第一个模型连接"
            text="配置供应商、实际模型标识和凭据引用后，进行真实调用测试。"
          />
        )}
      </Section>
      <div className="notice">
        <Search size={18} />
        <p>
          DeepSeek Flash 的搜索通过官方 Search / Fetch API
          工具桥接。模型身份、搜索调用和模型用量各自留痕，不将未调用的能力显示为已执行。
        </p>
      </div>
      <Section
        title="知识更新回归"
        sub="知识发布后，按工作区策略对受影响员工启动回归任务。"
      >
        {regressionError && <ErrorBox error={regressionError} />}
        <div className="form-body">
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={
                regressionDraft ??
                Boolean(ctx.data.settings?.autoKnowledgeRegression)
              }
              disabled={
                ctx.session?.role !== "admin" ||
                regressionSaving ||
                !ctx.data.settings?.id
              }
              onChange={async (event) => {
                const enabled = event.target.checked;
                setRegressionDraft(enabled);
                const settings = ctx.data.settings;
                setRegressionSaving(true);
                setRegressionError(null);
                try {
                  await ctx.action(
                    "knowledge-regression-setting",
                    () =>
                      update("settings", settings.id, {
                        autoKnowledgeRegression: enabled,
                        expectedRevision: settings.revision,
                      }),
                    enabled
                      ? "已启用知识发布后的受影响员工自动回归。"
                      : "已关闭知识发布后的自动回归，仍可手动启动。",
                  );
                } catch (failure) {
                  setRegressionError(failure);
                } finally {
                  setRegressionDraft(null);
                  setRegressionSaving(false);
                }
              }}
            />
            <span>
              知识发布后自动启动受影响员工回归
              <small>
                仅发布的知识触发。新知识生成候选并接受回归，冻结历史版本和生产指针不会因此自动改写。
              </small>
            </span>
          </label>
          {regressionSaving && <p className="muted">正在保存工作区策略…</p>}
          {!ctx.data.settings?.id && (
            <p className="muted">工作区设置尚未加载，暂不能更改策略。</p>
          )}
        </div>
      </Section>
      <ModelAttempts ctx={ctx} />
      <Section title="工作区与运行状态">
        {statusError && <ErrorBox error={statusError} />}
        <FactList
          entries={[
            ["工作区", ctx.session?.workspace],
            ["角色", ctx.session?.role],
            [
              "会话模式",
              ctx.session?.localMode ? "本机可信会话" : "身份认证会话",
            ],
            [
              "服务状态",
              status?.status || (status?.ok && "正常") || "等待状态查询",
            ],
            ["数据存储", "服务端持久化"],
            ["平台版本", status?.version || "1.0.0"],
          ]}
        />
        <Json value={status || {}} label="健康检查详情" />
        <div className="settings-actions">
          <Button
            icon={RefreshCw}
            onClick={async () => {
              try {
                setStatus(await request("/api/status"));
                setStatusError(null);
                ctx.notify("健康状态已刷新");
              } catch (e) {
                setStatusError(e);
                ctx.notify(e.message, "error");
              }
            }}
          >
            检查服务状态
          </Button>
          <Button
            icon={History}
            onClick={() => ctx.setDialog({ type: "audit" })}
          >
            查看审计事件
          </Button>
          <Button
            icon={UsersRound}
            disabled={ctx.session?.role !== "admin"}
            onClick={() =>
              ctx.setForm({
                title: "添加工作区成员",
                subtitle:
                  "成员仅访问当前工作区；密码通过认证接口处理，不进入资源记录。",
                fields: [
                  { key: "email", label: "登录邮箱", required: true },
                  {
                    key: "password",
                    label: "初始密码",
                    type: "password",
                    required: true,
                  },
                  {
                    key: "role",
                    label: "角色",
                    type: "select",
                    options: [
                      { value: "editor", label: "编辑成员" },
                      { value: "viewer", label: "只读成员" },
                      { value: "admin", label: "管理员" },
                    ],
                    default: "viewer",
                    required: true,
                  },
                ],
                submit: (body) =>
                  ctx.action(
                    "user",
                    () => post("/api/users", body),
                    "工作区成员已创建",
                  ),
              })
            }
          >
            添加成员
          </Button>
        </div>
      </Section>
    </>
  );
}
