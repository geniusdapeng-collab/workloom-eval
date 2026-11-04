import { useState } from "react";
import { GitCompareArrows, Plus } from "lucide-react";
import { request, num } from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Section,
  Tabs,
  Table,
  Json,
} from "../components";
import { matches, score, recordName } from "../view-utils";

export function Experiences({ ctx }) {
  const [tab, setTab] = useState("experiences"),
    [employee, setEmployee] = useState(""),
    [portfolio, setPortfolio] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  async function compare() {
    setBusy(true);
    setError(null);
    try {
      setPortfolio(await request("/api/portfolio/" + employee));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Tabs
        tabs={[
          {
            id: "experiences",
            label: "可复用经验",
            count: ctx.data.experiences.length,
          },
          { id: "portfolio", label: "质量／成本／时延组合" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "experiences" && (
        <Section
          title="有来源的经验库"
          sub="保留适用条件、评测来源和核验状态；不默认共享客户原始数据。"
          action={
            <Button
              primary
              icon={Plus}
              disabled={!ctx.canEdit}
              onClick={() => ctx.editResource("experiences")}
            >
              沉淀经验
            </Button>
          }
        >
          <Table
            rows={ctx.data.experiences.filter((e) => matches(e, ctx.query))}
            onRow={(e) => ctx.open("experiences", e.id)}
            columns={[
              { key: "name", label: "经验" },
              {
                key: "summary",
                label: "内容",
                render: (e) => <span className="clamp-two">{e.summary}</span>,
              },
              {
                key: "tags",
                label: "标签",
                render: (e) => (e.tags || []).join(" / "),
              },
              {
                key: "visibility",
                label: "范围",
                render: (e) =>
                  e.visibility === "shared" ? "已声明共享" : "本工作区",
              },
              {
                key: "approved",
                label: "核验",
                render: (e) => (
                  <Badge value={e.approved ? "approved" : "draft"} />
                ),
              },
            ]}
          />
        </Section>
      )}
      {tab === "portfolio" && (
        <Section
          title="按使用目标选择版本"
          sub="基于真实评测数据计算非支配版本，保留质量、成本与时延的权衡。"
        >
          <div className="portfolio-controls">
            <label className="field">
              <span>选择员工</span>
              <select
                value={employee}
                disabled={busy}
                onChange={(e) => {
                  setEmployee(e.target.value);
                  setPortfolio(null);
                }}
              >
                <option value="">选择员工</option>
                {ctx.data.employees.map((e) => (
                  <option value={e.id} key={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              primary
              icon={GitCompareArrows}
              disabled={!employee}
              busy={busy}
              onClick={compare}
            >
              计算版本组合
            </Button>
          </div>
          {error && <ErrorBox error={error} />}{" "}
          {portfolio ? (
            <>
              <PortfolioResult value={portfolio} ctx={ctx} />
              <Json value={portfolio} label="完整计算依据" />
            </>
          ) : (
            <Empty
              icon={GitCompareArrows}
              title="比较有评测记录的员工版本"
              text="质量优先、低时延或低成本可以对应不同版本；无数据的版本不参与结论。"
            />
          )}
        </Section>
      )}
    </>
  );
}

export function PortfolioResult({ value, ctx }) {
  const rows = Array.isArray(value)
    ? value
    : value.frontier ||
      value.versions ||
      value.portfolio ||
      value.candidates ||
      [];
  return (
    <Table
      rows={rows}
      columns={[
        {
          key: "versionId",
          label: "版本",
          render: (r) => recordName("versions", r.versionId || r.id, ctx.data),
        },
        {
          key: "score",
          label: "质量",
          render: (r) => score(r.quality ?? r.score ?? r.metrics?.score),
        },
        {
          key: "tokens",
          label:
            value.costBasis === "USD_estimate"
              ? "成本（USD估算）"
              : "成本（Token）",
          render: (r) =>
            num(
              r.cost ?? r.tokens ?? r.metrics?.tokens,
              value.costBasis === "USD_estimate" ? 6 : 0,
            ),
        },
        {
          key: "latencyMs",
          label: "时延",
          render: (r) => num(r.latencyMs ?? r.metrics?.latencyMs) + " ms",
        },
        {
          key: "role",
          label: "建议",
          render: (r) => r.recommendation || r.role || "非支配候选",
        },
      ]}
    />
  );
}
