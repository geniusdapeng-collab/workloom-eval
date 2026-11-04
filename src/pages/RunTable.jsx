import { Activity, ArrowUpRight } from "lucide-react";
import { date } from "../api";
import { Badge, Empty, Table } from "../components";
import { score, rate, recordName } from "../view-utils";

export function RunTable({ ctx, rows }) {
  return (
    <Table
      rows={rows}
      onRow={(r) => ctx.open("runs", r.id)}
      columns={[
        {
          key: "versionId",
          label: "员工版本",
          render: (r) => (
            <div>
              <strong>
                {recordName(
                  "employees",
                  ctx.data.versions.find((v) => v.id === r.versionId)
                    ?.employeeId,
                  ctx.data,
                )}
              </strong>
              <small className="table-secondary">
                {recordName("versions", r.versionId, ctx.data)}
              </small>
            </div>
          ),
        },
        {
          key: "datasetId",
          label: "测试集",
          render: (r) => recordName("datasets", r.datasetId, ctx.data),
        },
        {
          key: "score",
          label: "评分",
          render: (r) => (
            <strong className="score-cell">{score(r.metrics?.score)}</strong>
          ),
        },
        {
          key: "passRate",
          label: "通过率",
          render: (r) => rate(r.metrics?.passRate),
        },
        {
          key: "status",
          label: "状态",
          render: (r) => <Badge value={r.status} />,
        },
        {
          key: "createdAt",
          label: "运行时间",
          render: (r) => date(r.createdAt),
        },
        { key: "action", label: "", render: () => <ArrowUpRight size={16} /> },
      ]}
      empty={
        <Empty
          icon={Activity}
          title="还没有评测结果"
          text="选择冻结的员工版本与测试集，开始第一次真实模型评测。"
        />
      }
    />
  );
}
