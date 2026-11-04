import {
  Activity,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { post, date } from "../api";
import { Badge, Button, Section, Table } from "../components";
import { asArray } from "../view-utils";

export function Nodes({ ctx }) {
  const isAdmin = ctx.session?.role === "admin";
  function showCredential(result, rotated) {
    if (typeof result.token !== "string" || !result.token)
      throw new Error(
        "服务端未返回可用的一次性节点凭据，请核对节点状态后再操作。",
      );
    ctx.setDialog({
      type: "token",
      token: result.token,
      node: result.node || {},
      rotated,
    });
  }
  function register() {
    ctx.setForm({
      title: "登记私有执行节点",
      subtitle: "获得一次性展示的节点令牌，用于节点认证和执行租约。",
      fields: [
        { key: "name", label: "节点名称", required: true },
        {
          key: "capabilities",
          label: "执行能力",
          type: "multi",
          options: [
            { value: "browser", label: "浏览器自动化" },
            { value: "script", label: "受控脚本" },
            { value: "training", label: "受控训练任务" },
          ],
          required: true,
        },
      ],
      submitLabel: "登记节点",
      submit: async (body) => {
        const result = await post("/api/nodes/register", body);
        await ctx.reload(true);
        showCredential(result, false);
      },
    });
  }
  function manageNode(node, operation) {
    const rotating = operation === "rotate";
    ctx.setForm({
      title: rotating ? "轮换节点凭据" : "停用私有执行节点",
      subtitle: rotating
        ? "旧凭据立即失效，新令牌只展示一次。请准备更新节点的运行环境；不会显示或保存旧令牌。"
        : "停用后，此节点的现有凭据不能继续认证。需要重新启用时，可由管理员轮换并更新节点凭据。",
      fields: [
        {
          key: "acknowledged",
          label: "确认操作",
          type: "checkbox",
          required: true,
          checkLabel: rotating
            ? "已准备好更新节点凭据，并了解旧凭据立即失效"
            : "确认停用“" + node.name + "”",
        },
      ],
      submitLabel: rotating ? "轮换并显示新凭据" : "停用节点",
      submit: async (body) => {
        if (!body.acknowledged)
          throw new Error(
            rotating ? "请确认已准备好更新节点凭据。" : "请确认停用节点。",
          );
        const result = await ctx.action(
          "node-" + operation + "-" + node.id,
          () =>
            post(
              "/api/nodes/" + encodeURIComponent(node.id) + "/" + operation,
              {},
            ),
          rotating ? undefined : "节点已停用，旧凭据不能继续认证。",
        );
        if (rotating) showCredential(result, true);
      },
    });
  }
  return (
    <>
      <div className="section-toolbar">
        <span className="muted">认证执行 · 任务租约 · 心跳与回执</span>
        <div>
          <Button
            icon={Activity}
            disabled={
              !ctx.canEdit ||
              !ctx.data.nodes.some((node) => node.status !== "revoked")
            }
            onClick={() => ctx.jobForm("browser_evaluate")}
          >
            浏览器评测
          </Button>
          <Button primary icon={Plus} disabled={!isAdmin} onClick={register}>
            登记节点
          </Button>
        </div>
      </div>
      <Section
        title="私有执行节点"
        sub="节点执行发生在你的环境中；停用或轮换凭据后，旧凭据立即失效。"
      >
        <Table
          rows={ctx.data.nodes}
          onRow={(node) => ctx.open("nodes", node.id)}
          columns={[
            {
              key: "name",
              label: "节点",
              render: (node) => (
                <div className="name-cell">
                  <Network size={19} />
                  <div>
                    <strong>{node.name}</strong>
                    <small>{node.id}</small>
                  </div>
                </div>
              ),
            },
            {
              key: "capabilities",
              label: "能力",
              render: (node) => asArray(node.capabilities).join(" / "),
            },
            {
              key: "status",
              label: "状态",
              render: (node) => <Badge value={node.status || "offline"} />,
            },
            {
              key: "lastSeen",
              label: "最近心跳",
              render: (node) => date(node.lastSeen),
            },
            {
              key: "actions",
              label: "",
              render: (node) => (
                <div className="inline-actions">
                  <Button
                    icon={RefreshCw}
                    disabled={!isAdmin || Boolean(ctx.actionBusy)}
                    onClick={(event) => {
                      event.stopPropagation();
                      manageNode(node, "rotate");
                    }}
                  >
                    轮换凭据
                  </Button>
                  <Button
                    danger
                    icon={ShieldCheck}
                    disabled={
                      !isAdmin ||
                      node.status === "revoked" ||
                      Boolean(ctx.actionBusy)
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      manageNode(node, "revoke");
                    }}
                  >
                    {node.status === "revoked" ? "已停用" : "停用"}
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Section>
      <Section title="连接节点">
        <div className="runner-guide">
          <Terminal size={24} />
          <div>
            <h3>在私有执行环境运行节点客户端</h3>
            <p>
              仓库包含
              scripts/runner.mjs。通过运行环境传入平台地址与节点令牌后启动；浏览器或脚本能力需要相应节点配置和允许清单。
            </p>
            <pre>
              EVAL_URL=http://127.0.0.1:4317{"\n"}EVAL_RUNNER_TOKEN=你的节点令牌
              {"\n"}EVAL_RUNNER_TASKS=允许的任务注册表.json{"\n"}npm run runner
            </pre>
            <small>
              将变量设置为进程环境；不要提交真实令牌。节点心跳和执行回执会更新上方记录。
              轮换后需将新令牌注入节点进程，平台页面关闭后不会再次提供该令牌。
            </small>
          </div>
        </div>
      </Section>
    </>
  );
}
