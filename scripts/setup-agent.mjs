#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { isDeepStrictEqual } from "node:util";
function checkedToml(text) {
  try {
    return parseToml(text, {
      unsafeKeyBehaviour: "throw",
      integersAsBigInt: "asNeeded",
    });
  } catch {
    throw fail("CONFIG_TOML_INVALID", "TOML配置不完整或存在冲突，未修改配置");
  }
}
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const START = "# BEGIN WORKLOOM EVAL MCP",
  END = "# END WORKLOOM EVAL MCP";
const fail = (code, message) => Object.assign(new Error(message), { code });
async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function configureAgent({
  client = "codex",
  home = homedir(),
  url = "http://127.0.0.1:4317",
  install = false,
  root = ROOT,
  node = process.execPath,
} = {}) {
  if (!["codex", "qoder", "all"].includes(client))
    throw fail("INVALID_CLIENT", "client须为codex、qoder或all");
  const target = new URL(url),
    local = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/" ||
    !(target.protocol === "https:" || (local && target.protocol === "http:"))
  )
    throw fail("UNSAFE_URL", "仅支持无凭据的HTTPS或本机回环HTTP根地址");
  const entry = resolve(root, "scripts/agent-launcher.mjs");
  await readFile(entry);
  const skill = (
    await readFile(
      resolve(root, "integrations/skills/workloom-eval/SKILL.md"),
      "utf8",
    )
  ).replaceAll("/ABSOLUTE/PATH/TO/workloom-eval", root);
  const config = {
    command: node,
    args: [entry],
    env: { EVAL_URL: target.origin },
  };
  const plans = [];
  if (client === "codex" || client === "all") {
    const path = join(home, ".codex/config.toml"),
      old = await readOptional(path),
      text = old || "";
    const block = [
      START,
      "[mcp_servers.workloom_eval]",
      `command = ${JSON.stringify(node)}`,
      `args = [${JSON.stringify(entry)}]`,
      'env_vars = ["EVAL_API_TOKEN", "EVAL_SESSION_TOKEN", "EVAL_SESSION_COOKIE", "DEEPSEEK_API_KEY"]',
      "startup_timeout_sec = 30",
      "tool_timeout_sec = 75",
      `env = { EVAL_URL = ${JSON.stringify(target.origin)} }`,
      END,
      "",
    ].join("\n");
    const parsed = checkedToml(text),
      managed = checkedToml(block).mcp_servers.workloom_eval;
    const a = text.indexOf(START),
      b = text.indexOf(END);
    let base = text;
    if (a >= 0 || b >= 0) {
      if (
        a < 0 ||
        b < a ||
        text.split(START).length !== 2 ||
        text.split(END).length !== 2 ||
        !parsed.mcp_servers?.workloom_eval ||
        (a > 0 && text[a - 1] !== "\n")
      )
        throw fail(
          "CONFIG_CONFLICT",
          "现有受管标记不唯一或不属于MCP配置，未修改",
        );
      const oldBlock = checkedToml(text.slice(a, b + END.length));
      if (
        Object.keys(oldBlock).length !== 1 ||
        !oldBlock.mcp_servers ||
        Object.keys(oldBlock.mcp_servers).length !== 1 ||
        !isDeepStrictEqual(
          oldBlock.mcp_servers.workloom_eval,
          parsed.mcp_servers.workloom_eval,
        )
      )
        throw fail("CONFIG_CONFLICT", "受管块包含额外配置，未覆盖");
      base =
        text.slice(0, a) + text.slice(b + END.length).replace(/^\r?\n/, "");
      if (checkedToml(base).mcp_servers?.workloom_eval)
        throw fail("CONFIG_CONFLICT", "同名配置还存在于受管块之外，未覆盖");
    } else if (parsed.mcp_servers?.workloom_eval !== undefined)
      throw fail("CONFIG_CONFLICT", "同名MCP已存在且不属于本安装器，未覆盖");
    const next =
      a >= 0
        ? text.slice(0, a) +
          block +
          text.slice(b + END.length).replace(/^\r?\n/, "")
        : base + (base.endsWith("\n") || !base ? "" : "\n") + "\n" + block;
    const baseData = checkedToml(base),
      expected = Object.assign(Object.create(null), baseData, {
        mcp_servers: Object.assign(Object.create(null), baseData.mcp_servers, {
          workloom_eval: managed,
        }),
      });
    if (!isDeepStrictEqual(checkedToml(next), expected))
      throw fail("CONFIG_CONFLICT", "配置合并会改变其他设置，未写入");
    plans.push({ path, old, next, kind: "codex" });
  }
  if (client === "qoder" || client === "all") {
    const path = join(home, ".qoder/settings.json"),
      old = await readOptional(path);
    let data;
    try {
      data = old ? JSON.parse(old) : {};
    } catch {
      throw fail(
        "CONFIG_JSON_INVALID",
        "Qoder配置不是标准JSON，未修改；请手动合并生成片段",
      );
    }
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      (data.mcpServers &&
        (typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)))
    )
      throw fail("CONFIG_JSON_INVALID", "Qoder MCP配置结构无效");
    const prior = data.mcpServers?.workloom_eval;
    if (prior && (!Array.isArray(prior.args) || prior.args[0] !== entry))
      throw fail("CONFIG_CONFLICT", "Qoder已有同名其他连接器，未覆盖");
    data.mcpServers = {
      ...data.mcpServers,
      workloom_eval: { ...config, timeout: 75000 },
    };
    plans.push({
      path,
      old,
      next: JSON.stringify(data, null, 2) + "\n",
      kind: "qoder",
    });
  }
  const destinations = new Set([
    join(home, ".agents/skills/workloom-eval/SKILL.md"),
  ]);
  if (client === "qoder" || client === "all")
    destinations.add(join(home, ".qoder/skills/workloom-eval/SKILL.md"));
  for (const path of destinations) {
    const old = await readOptional(path);
    if (old && !old.includes("name: workloom-eval"))
      throw fail("SKILL_CONFLICT", "目标Skill目录已有其他内容，未覆盖");
    plans.push({ path, old, next: skill, kind: "skill" });
  }
  if (install) {
    const written = [];
    try {
      for (const plan of plans) {
        await mkdir(dirname(plan.path), { recursive: true, mode: 0o700 });
        if ((await readOptional(plan.path)) !== plan.old)
          throw fail("CONFIG_CHANGED", "安装期间配置发生变化，未覆盖");
        const temp = plan.path + "." + randomUUID() + ".tmp";
        try {
          await writeFile(temp, plan.next, { mode: 0o600, flag: "wx" });
          if ((await readOptional(plan.path)) !== plan.old)
            throw fail("CONFIG_CHANGED", "写入前配置发生变化");
          await rename(temp, plan.path);
        } finally {
          await rm(temp, { force: true });
        }
        written.push(plan);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const plan of written.reverse())
        try {
          if ((await readOptional(plan.path)) !== plan.next)
            throw fail("CONFIG_CHANGED", "配置在回退前已被其他进程修改");
          if (plan.old === null) await rm(plan.path, { force: true });
          else await writeFile(plan.path, plan.old, { mode: 0o600 });
        } catch (e) {
          rollbackErrors.push(e.code || "ROLLBACK_FAILED");
        }
      if (rollbackErrors.length)
        throw fail(
          "CONFIG_ROLLBACK_INCOMPLETE",
          "安装失败，部分配置已被并发修改；请复核目标配置文件",
        );
      throw error;
    }
  }
  return {
    installed: install,
    client,
    serviceUrl: target.origin,
    serverName: "workloom_eval",
    config,
    targets: plans.map((p) => ({
      path: p.path,
      kind: p.kind,
      changed: p.old !== p.next,
    })),
    nextAction:
      "新建聊天或按平台官方方式重载MCP/Skills，然后调用workloom_eval_doctor验证。",
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2),
    options = {};
  let error;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--install") options.install = true;
    else if (["--client", "--home", "--url"].includes(arg) && args[i + 1])
      options[arg.slice(2)] = args[++i];
    else if (arg === "--help") {
      process.stdout.write(
        "node scripts/setup-agent.mjs --client codex|qoder|all [--install] [--home DIR] [--url URL]\n",
      );
      process.exit(0);
    } else {
      error = fail("INVALID_ARGUMENT", "未知参数或缺少值");
      break;
    }
  }
  Promise.resolve()
    .then(() => {
      if (error) throw error;
      return configureAgent(options);
    })
    .then((r) => process.stdout.write(JSON.stringify(r, null, 2) + "\n"))
    .catch((e) => {
      process.stderr.write(
        JSON.stringify({
          error: {
            code: e.code || "SETUP_FAILED",
            message: e.code ? e.message : "配置未完成，请检查目录权限",
          },
        }) + "\n",
      );
      process.exitCode = 1;
    });
}
