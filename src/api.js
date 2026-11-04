export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData))
    headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers,
      body:
        options.body && !(options.body instanceof FormData)
          ? JSON.stringify(options.body)
          : options.body,
    });
  } catch {
    throw new ApiError(
      "无法连接平台服务，请检查服务状态后重试。",
      0,
      "NETWORK_ERROR",
    );
  }
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch (failure) {
    throw new ApiError(
      response.ok
        ? "服务返回了无法识别的数据，请刷新后重试。"
        : "请求失败，服务未提供有效的错误回执。",
      response.status,
      "INVALID_API_RESPONSE",
    );
  }
  if (!response.ok)
    throw new ApiError(
      value.error?.message || value.message || `请求失败（${response.status}）`,
      response.status,
      value.error?.code || "REQUEST_FAILED",
      value.error?.details,
    );
  return value;
}
export async function download(path, filename) {
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin" });
  } catch {
    throw new ApiError("下载失败，请检查连接。", 0, "NETWORK_ERROR");
  }
  if (!response.ok) {
    let value;
    try {
      value = await response.json();
    } catch (failure) {
      throw new ApiError(
        "导出失败，服务未提供有效的错误回执。",
        response.status,
        "INVALID_EXPORT_RESPONSE",
      );
    }
    throw new ApiError(
      value.error?.message || "导出失败",
      response.status,
      value.error?.code || "EXPORT_FAILED",
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const post = (path, body) => request(path, { method: "POST", body });
export const update = (kind, id, body) =>
  request(`/api/resources/${kind}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body,
  });
export const create = (kind, body) => post(`/api/resources/${kind}`, body);
export const remove = (kind, id) =>
  request(`/api/resources/${kind}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export function pretty(value) {
  return typeof value === "string"
    ? value
    : JSON.stringify(value ?? {}, null, 2);
}
export function num(value, digits = 0) {
  return Number.isFinite(Number(value))
    ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits })
    : "—";
}
export function date(value) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
}
export const titles = {
  employees: "数字员工",
  versions: "员工版本",
  knowledge: "知识库",
  tools: "工具",
  skills: "技能",
  models: "模型",
  datasets: "测试集",
  cases: "场景用例",
  jobs: "运行任务",
  runs: "评测记录",
  optimizations: "迭代记录",
  reports: "报告",
  teams: "员工班组",
  memories: "岗位记忆",
  deployments: "发布记录",
  training: "微调任务",
  nodes: "私有节点",
  experiences: "经验",
  reviews: "复核记录",
};
export const statuses = {
  unassessed: "待试岗",
  candidate: "候选版本",
  configured: "待检测",
  registered: "已登记",
  revoked: "已停用",
  deploying: "部署中",
  real: "真实执行",
  needs_review: "待复核",
  uncertain: "待核验",
  not_executed: "未执行",
  reconciled: "已核对",
  canary: "灰度模式",
  managed: "正式托管",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  draft: "草案",
  ready: "可试岗",
  active: "已启用",
  inactive: "未启用",
  connected: "已连接",
  unconfigured: "待配置",
  simulated: "仿真工具",
  test: "测试环境",
  readonly: "生产只读",
  production: "生产写入",
  pending: "待处理",
  succeeded: "成功",
  approved: "已核验",
  rejected: "已驳回",
  recommended: "推荐",
  limited: "限定范围",
  insufficient_evidence: "证据不足",
  online: "在线",
  offline: "离线",
  unknown: "未检测",
  passed: "通过",
  submitted: "已提交",
  rolled_back: "已回退",
  shadow: "影子模式",
  blocked: "已阻止",
  cancelled_by_user: "已取消",
};
export const purposes = {
  train: "训练集",
  dev: "开发集",
  validation: "验证集",
  holdout: "盲测集",
};
