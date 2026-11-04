const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const fail = (message) => {
  throw new Error(message);
};
function path(value, field = "") {
  const parts = String(field).split(".").filter(Boolean);
  if (parts.some((p) => forbidden.has(p))) fail("禁止使用内部路径");
  return parts.reduce((v, key) => v?.[key], value);
}
export function transformData(input, steps) {
  if (!Array.isArray(steps) || steps.length > 100)
    fail("声明式脚本需要不超过100个步骤");
  let data = structuredClone(input);
  for (const step of steps) {
    if (step.action === "select") data = path(data, step.path);
    else if (step.action === "filter") {
      if (!Array.isArray(data)) fail("filter要求数组");
      data = data.filter(
        (item) =>
          JSON.stringify(path(item, step.path)) === JSON.stringify(step.equals),
      );
    } else if (step.action === "project") {
      if (
        !Array.isArray(data) ||
        !step.fields ||
        typeof step.fields !== "object"
      )
        fail("project要求数组与fields");
      data = data.map((item) =>
        Object.fromEntries(
          Object.entries(step.fields).map(([key, field]) => {
            if (forbidden.has(key)) fail("禁止输出内部字段");
            return [key, path(item, field)];
          }),
        ),
      );
    } else if (step.action === "count") {
      if (!Array.isArray(data)) fail("count要求数组");
      data = data.length;
    } else if (step.action === "sum") {
      if (!Array.isArray(data)) fail("sum要求数组");
      data = data.reduce((sum, item) => {
        const value = Number(step.path ? path(item, step.path) : item);
        if (!Number.isFinite(value)) fail("sum输入不是有限数字");
        return sum + value;
      }, 0);
      if (!Number.isFinite(data)) fail("计算溢出");
    } else if (step.action === "sort") {
      if (!Array.isArray(data)) fail("sort要求数组");
      data.sort((a, b) => {
        const x = path(a, step.path),
          y = path(b, step.path);
        const direction = step.descending ? -1 : 1;
        return x === y ? 0 : x > y ? direction : -direction;
      });
    } else if (step.action === "assert") {
      if (JSON.stringify(path(data, step.path)) !== JSON.stringify(step.equals))
        fail("声明式断言失败");
    } else if (step.action === "format") {
      if (typeof step.template !== "string" || step.template.length > 100000)
        fail("格式模板无效");
      data = step.template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, key) => {
        const value = path(data, key);
        return value === undefined
          ? ""
          : typeof value === "string"
            ? value
            : JSON.stringify(value);
      });
    } else fail(`未注册的声明式脚本操作: ${step.action}`);
    if (Buffer.byteLength(JSON.stringify(data ?? null)) > 1048576)
      fail("声明式脚本结果超过1MB");
  }
  return data;
}

if (process.argv.includes("--worker")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (Buffer.byteLength(input) > 1048576) {
      process.stderr.write("输入超过1MB");
      process.exit(1);
    }
  });
  process.stdin.on("end", () => {
    try {
      const parsed = JSON.parse(input);
      process.stdout.write(
        JSON.stringify({ result: transformData(parsed.input, parsed.steps) }),
      );
    } catch (error) {
      process.stderr.write(error.message);
      process.exitCode = 1;
    }
  });
}
