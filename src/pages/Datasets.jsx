import { useState } from "react";
import {
  ChevronRight,
  Download,
  FlaskConical,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { post, create, purposes } from "../api";
import { Button, Empty, Section, Table } from "../components";
import { fields, options } from "../forms";
import { matches } from "../view-utils";

export function Datasets({ ctx }) {
  const { data, query } = ctx;
  const [selected, setSelected] = useState("");
  const dataset =
    data.datasets.find((d) => d.id === selected) || data.datasets[0];
  const cases = data.cases.filter(
    (c) => c.datasetId === dataset?.id && matches(c, query),
  );
  return (
    <>
      <div className="section-toolbar">
        <span className="muted">训练、开发、验证、盲测用途隔离</span>
        <div>
          <Button
            icon={Download}
            disabled={!ctx.canEdit}
            onClick={() =>
              ctx.setForm({
                title: "导入测试集",
                wide: true,
                fields: [
                  { key: "name", label: "测试集名称", required: true },
                  {
                    key: "purpose",
                    label: "用途",
                    type: "select",
                    options: Object.entries(purposes).map(([value, label]) => ({
                      value,
                      label,
                    })),
                    default: "dev",
                    required: true,
                  },
                  {
                    key: "cases",
                    label: "场景用例 JSON",
                    type: "json",
                    array: true,
                    default: [],
                    help: "每条包含 name、input、expected、initialState 和 assertions。",
                  },
                ],
                submit: async (body) => {
                  await ctx.action(
                    "import",
                    () => post("/api/datasets/import", body),
                    "测试集已导入",
                  );
                },
              })
            }
          >
            批量导入
          </Button>
          <Button
            primary
            icon={Plus}
            disabled={!ctx.canEdit}
            onClick={() => ctx.editResource("datasets")}
          >
            新建测试集
          </Button>
        </div>
      </div>
      <div className="master-layout">
        <aside className="master-list">
          {data.datasets
            .filter((d) => matches(d, query))
            .map((d) => (
              <button
                className={dataset?.id === d.id ? "active" : ""}
                key={d.id}
                onClick={() => setSelected(d.id)}
              >
                <span className="table-icon">
                  <FlaskConical size={18} />
                </span>
                <span>
                  <strong>{d.name}</strong>
                  <small>
                    {purposes[d.purpose] || d.purpose} ·{" "}
                    {data.cases.filter((c) => c.datasetId === d.id).length}{" "}
                    个场景
                  </small>
                </span>
                {d.purpose === "holdout" && <ShieldCheck size={15} />}
              </button>
            ))}
          {!data.datasets.length && (
            <Empty title="暂无测试集" text="先创建一个有明确用途的测试集。" />
          )}
        </aside>
        <Section
          title={dataset?.name || "场景用例"}
          sub={dataset?.description || "配置初始业务状态、工具行为与验收断言。"}
          action={
            dataset && (
              <div className="inline-actions">
                <Button
                  disabled={!ctx.canEdit}
                  onClick={() => ctx.editResource("datasets", dataset)}
                >
                  编辑
                </Button>
                <Button
                  primary
                  icon={Plus}
                  disabled={!ctx.canEdit}
                  onClick={() =>
                    ctx.setForm({
                      title: "添加场景用例",
                      fields: fields("cases", data),
                      initial: { datasetId: dataset.id },
                      wide: true,
                      submit: (body) =>
                        ctx.action(
                          "case",
                          () => create("cases", body),
                          "场景已添加",
                        ),
                    })
                  }
                >
                  添加用例
                </Button>
              </div>
            )
          }
        >
          <Table
            rows={cases}
            columns={[
              {
                key: "name",
                label: "场景",
                render: (r) => (
                  <div>
                    <strong>{r.name}</strong>
                    <small className="table-secondary">
                      {r.hidden ? "盲测内容已隔离" : r.input}
                    </small>
                  </div>
                ),
              },
              { key: "category", label: "类型" },
              {
                key: "assertions",
                label: "验收",
                render: (r) =>
                  r.hidden ? (
                    <ShieldCheck size={16} />
                  ) : (
                    (r.assertions || []).length + " 项断言"
                  ),
              },
              {
                key: "action",
                label: "",
                render: (r) => (
                  <button
                    className="text-button"
                    onClick={() => ctx.open("cases", r.id)}
                  >
                    {r.hidden ? "查看元数据" : "查看场景"}
                    <ChevronRight size={14} />
                  </button>
                ),
              },
            ]}
            empty={
              <Empty
                title="尚未添加场景"
                text={
                  dataset
                    ? "添加任务输入、业务状态和预期结果，即可作为试岗用例。"
                    : "创建测试集后开始编写场景。"
                }
              />
            }
          />
        </Section>
      </div>
      <div className="notice">
        <ShieldCheck size={18} />
        <p>
          盲测题目和答案不会显示在常规列表中，也不进入自动优化上下文。自动生成的开发用例不能独立证明员工适合生产上岗。
        </p>
      </div>
    </>
  );
}
