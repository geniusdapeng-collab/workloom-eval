import { useState } from "react";
import { History, Radar, RefreshCw, Rocket } from "lucide-react";
import { post, pretty, statuses } from "../api";
import { Badge, Button, ErrorBox, Section, Tabs, Table } from "../components";
import { fields, options } from "../forms";
import { matches, recordName } from "../view-utils";
import { JobList } from "./JobList";

export function Deployments({ ctx }) {
  const [tab, setTab] = useState("deployments");
  const [reconciling, setReconciling] = useState("");
  const [reconcileError, setReconcileError] = useState(null);
  async function reconcile(deployment) {
    setReconciling(deployment.id);
    setReconcileError(null);
    try {
      const result = await ctx.action(
        "deployment-reconcile-" + deployment.id,
        () =>
          post(
            "/api/deployments/" +
              encodeURIComponent(deployment.id) +
              "/reconcile",
            {},
          ),
      );
      ctx.notify(
        result.status === "uncertain"
          ? "已读取远端状态，证据仍未匹配；部署继续等待核对。"
          : "远端回执与目标版本已核对，部署状态已更新。",
      );
    } catch (failure) {
      setReconcileError(failure);
    } finally {
      setReconciling("");
    }
  }
  function deployForm() {
    ctx.setForm({
      title: "交付经过评测的员工版本",
      subtitle: "版本推荐和部署状态分别记录；真实外部目标需要明确连接与策略。",
      fields: [
        {
          key: "employeeId",
          label: "员工",
          type: "select",
          options: options(ctx.data.employees),
          required: true,
        },
        {
          key: "versionId",
          label: "交付版本",
          type: "select",
          options: ctx.data.versions.map((v) => ({
            value: v.id,
            label:
              recordName("employees", v.employeeId, ctx.data) + " · " + v.label,
          })),
          required: true,
        },
        {
          key: "target",
          label: "目标适配器／地址",
          default: "local",
          required: true,
          help: "本地版本指针使用 local；外部目标使用已获准的部署连接。",
        },
        {
          key: "mode",
          label: "部署方式",
          type: "select",
          options: [
            { value: "shadow", label: "影子模式" },
            { value: "canary", label: "灰度模式" },
            { value: "managed", label: "正式托管" },
          ],
          default: "shadow",
          required: true,
        },
        {
          key: "policy",
          label: "部署策略",
          type: "json",
          default: { requireEvaluation: true, allowProductionWrites: false },
        },
      ],
      submitLabel: "创建部署",
      submit: async (body) => {
        const d = await ctx.action(
          "deploy",
          () => post("/api/deployments", body),
          "部署状态已记录，请查看实际回执",
        );
        ctx.open("deployments", d.id || d.deployment?.id);
      },
    });
  }
  return (
    <>
      <Tabs
        tabs={[
          {
            id: "deployments",
            label: "部署与回退",
            count: ctx.data.deployments.length,
          },
          { id: "shadow", label: "生产输入影子评测" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "deployments" && (
        <Section
          title="版本交付记录"
          sub="以实际目标回执为准。核对远端状态仅执行读取，不重发部署请求。"
          action={
            <Button
              primary
              icon={Rocket}
              disabled={
                ctx.session?.role !== "admin" || !ctx.data.versions.length
              }
              onClick={deployForm}
            >
              交付版本
            </Button>
          }
        >
          {reconcileError && <ErrorBox error={reconcileError} />}
          <Table
            rows={ctx.data.deployments
              .filter((d) => matches(d, ctx.query))
              .slice()
              .reverse()}
            onRow={(d) => ctx.open("deployments", d.id)}
            columns={[
              {
                key: "employeeId",
                label: "员工",
                render: (d) => recordName("employees", d.employeeId, ctx.data),
              },
              {
                key: "versionId",
                label: "版本",
                render: (d) => recordName("versions", d.versionId, ctx.data),
              },
              {
                key: "target",
                label: "目标",
                render: (d) =>
                  typeof d.target === "string" ? d.target : pretty(d.target),
              },
              {
                key: "mode",
                label: "方式",
                render: (d) => statuses[d.mode] || d.mode,
              },
              {
                key: "status",
                label: "状态",
                render: (d) => <Badge value={d.status} />,
              },
              {
                key: "action",
                label: "",
                render: (d) =>
                  d.status === "uncertain" ? (
                    <Button
                      icon={RefreshCw}
                      busy={reconciling === d.id}
                      disabled={
                        ctx.session?.role !== "admin" || Boolean(reconciling)
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        reconcile(d);
                      }}
                    >
                      核对远端状态
                    </Button>
                  ) : (
                    <Button
                      icon={History}
                      disabled={
                        ctx.session?.role !== "admin" ||
                        !d.previousVersionId ||
                        d.status !== "active"
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        ctx.setForm({
                          title: "回退部署版本",
                          subtitle:
                            "恢复至部署记录中的上一版本，保留新的回退回执。",
                          fields: [
                            {
                              key: "reason",
                              label: "回退原因",
                              type: "textarea",
                              required: true,
                            },
                          ],
                          submitLabel: "执行回退",
                          submit: (body) =>
                            ctx.action(
                              "rollback",
                              () =>
                                post(
                                  "/api/deployments/" + d.id + "/rollback",
                                  body,
                                ),
                              "回退操作已执行，请核对回执",
                            ),
                        });
                      }}
                    >
                      回退
                    </Button>
                  ),
              },
            ]}
          />
        </Section>
      )}
      {tab === "shadow" && (
        <Section
          title="真实输入，隔离执行"
          sub="将脱敏后的生产输入重放到测试或仿真工具，检查环境差异。"
        >
          <div className="feature-intro">
            <Radar size={38} />
            <h3>观察员工在实际任务分布下的表现</h3>
            <p>
              影子评测保存输入来源与执行模式。生产用户不会收到影子输出，生产写工具不会随重放自动执行。
            </p>
            <Button
              primary
              disabled={!ctx.canEdit || !ctx.data.versions.length}
              onClick={() => ctx.jobForm("shadow_evaluate")}
            >
              启动影子评测
            </Button>
          </div>
          <JobList ctx={ctx} types={["shadow_evaluate"]} />
        </Section>
      )}
    </>
  );
}
