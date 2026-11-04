import { useState } from "react";
import {
  Download,
  FileText,
  GitBranch,
  GitCompareArrows,
  Plus,
} from "lucide-react";
import { num, date } from "../api";
import {
  Badge,
  Button,
  Empty,
  Section,
  Tabs,
  Table,
  Json,
  FactList,
} from "../components";
import { matches, score, rate, recordName } from "../view-utils";

export function Versions({ ctx }) {
  const [tab, setTab] = useState("versions"),
    [base, setBase] = useState(""),
    [candidate, setCandidate] = useState("");
  const b = ctx.data.versions.find((v) => v.id === base),
    c = ctx.data.versions.find((v) => v.id === candidate);
  return (
    <>
      <Tabs
        tabs={[
          { id: "versions", label: "版本库", count: ctx.data.versions.length },
          { id: "compare", label: "版本比较" },
          { id: "reports", label: "评测报告", count: ctx.data.reports.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "versions" && (
        <Section
          title="冻结的员工版本"
          sub="知识、工具、技能、模型与权限一并留存"
          action={
            <Button
              icon={Plus}
              disabled={!ctx.canEdit || !ctx.data.employees.length}
              onClick={() => ctx.createVersion()}
            >
              新建版本
            </Button>
          }
        >
          <Table
            rows={ctx.data.versions
              .filter((v) =>
                matches(
                  {
                    ...v,
                    name: recordName("employees", v.employeeId, ctx.data),
                  },
                  ctx.query,
                ),
              )
              .slice()
              .reverse()}
            onRow={(v) => ctx.open("versions", v.id)}
            columns={[
              {
                key: "label",
                label: "版本",
                render: (v) => (
                  <div className="name-cell">
                    <GitBranch size={18} />
                    <div>
                      <strong>{v.label}</strong>
                      <small>
                        {recordName("employees", v.employeeId, ctx.data)}
                      </small>
                    </div>
                  </div>
                ),
              },
              { key: "changeSummary", label: "改动说明" },
              {
                key: "parentId",
                label: "父版本",
                render: (v) => recordName("versions", v.parentId, ctx.data),
              },
              {
                key: "manifestHash",
                label: "依赖摘要",
                render: (v) => (
                  <code>{v.manifestHash?.slice(0, 12) || "—"}</code>
                ),
              },
              {
                key: "createdAt",
                label: "创建时间",
                render: (v) => date(v.createdAt),
              },
            ]}
          />
        </Section>
      )}
      {tab === "compare" && (
        <Section
          title="比较版本配置与实际表现"
          sub="比较只基于已有评测记录；不同测试条件下的分数不直接等价。"
        >
          <div className="compare-select">
            <label className="field">
              <span>基线版本</span>
              <select value={base} onChange={(e) => setBase(e.target.value)}>
                <option value="">选择基线</option>
                {ctx.data.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {recordName("employees", v.employeeId, ctx.data)} ·{" "}
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <GitCompareArrows size={22} />
            <label className="field">
              <span>候选版本</span>
              <select
                value={candidate}
                onChange={(e) => setCandidate(e.target.value)}
              >
                <option value="">选择候选</option>
                {ctx.data.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {recordName("employees", v.employeeId, ctx.data)} ·{" "}
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {b && c ? (
            <div className="compare-grid">
              {[b, c].map((v, i) => {
                const r = ctx.data.runs
                  .filter((r) => r.versionId === v.id)
                  .at(-1);
                return (
                  <div key={i}>
                    <span className="eyebrow">{i ? "候选" : "基线"}</span>
                    <h3>{v.label}</h3>
                    <FactList
                      entries={[
                        ["最近评分", score(r?.metrics?.score)],
                        [
                          "测试集",
                          recordName("datasets", r?.datasetId, ctx.data),
                        ],
                        ["任务通过率", rate(r?.metrics?.passRate)],
                        ["关键违规", r?.metrics?.violations ?? "—"],
                        ["调用 Token", num(r?.metrics?.tokens)],
                      ]}
                    />
                    <h4>岗位指令</h4>
                    <pre className="prose-pre">{v.prompt}</pre>
                    <Json
                      value={{
                        knowledgeIds: v.knowledgeIds,
                        toolIds: v.toolIds,
                        skillIds: v.skillIds,
                        modelId: v.modelId,
                        policy: v.policy,
                      }}
                      label="能力配置"
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty
              icon={GitCompareArrows}
              title="选择两个版本开始比较"
              text="可比较岗位指令、资产依赖、权限和已有评测表现。"
            />
          )}
        </Section>
      )}
      {tab === "reports" && (
        <Section
          title="每版本评测报告"
          sub="推荐范围、限制和下一轮建议随证据一起交付"
        >
          <Table
            rows={ctx.data.reports
              .filter((r) => matches(r, ctx.query))
              .slice()
              .reverse()}
            onRow={(r) => ctx.open("reports", r.id)}
            columns={[
              {
                key: "title",
                label: "报告",
                render: (r) => (
                  <div className="name-cell">
                    <FileText size={19} />
                    <div>
                      <strong>{r.title || "员工评测报告"}</strong>
                      <small>
                        {recordName("versions", r.versionId, ctx.data)}
                      </small>
                    </div>
                  </div>
                ),
              },
              {
                key: "recommendation",
                label: "推荐结论",
                render: (r) => (
                  <Badge
                    value={
                      typeof r.recommendation === "string"
                        ? r.recommendation
                        : r.recommendation?.status
                    }
                  />
                ),
              },
              {
                key: "createdAt",
                label: "生成时间",
                render: (r) => date(r.createdAt),
              },
              {
                key: "export",
                label: "",
                render: (r) => (
                  <Button
                    icon={Download}
                    onClick={(e) => {
                      e.stopPropagation();
                      ctx.exportFile(
                        "/api/reports/" + r.id + "/export?format=markdown",
                        "评测报告-" + r.id + ".md",
                      );
                    }}
                  >
                    导出
                  </Button>
                ),
              },
            ]}
          />
        </Section>
      )}
    </>
  );
}
