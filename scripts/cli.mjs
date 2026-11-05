#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvalClient, EvalClientError } from "../client/client.mjs";
import { operationMetadata } from "../client/operations.mjs";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const help = {
  product: "丰臣秀吉数字员工评测与迭代平台（秀吉系统）CLI",
  usage: [
    "workloom-eval --help",
    "workloom-eval capabilities",
    "workloom-eval doctor [--url ORIGIN] [--timeout-ms N]",
    "workloom-eval call OP [--json '{...}' | --input FILE | --input -] [--url ORIGIN] [--timeout-ms N]",
    "workloom-eval jobs wait ID [--timeout-ms 60000] [--poll-interval-ms 500] [--url ORIGIN]",
  ],
  input:
    "Without --json/--input, call reads piped stdin when present, otherwise uses {}. The input must be one JSON object.",
  environment: {
    EVAL_URL:
      "Service origin; default http://127.0.0.1:4317. Remote connections require HTTPS.",
    EVAL_API_TOKEN:
      "Optional scoped API credential, read only from environment and never persisted or printed.",
    EVAL_SESSION_TOKEN:
      "Optional existing eval_session value, read only from environment.",
    EVAL_SESSION_COOKIE:
      "Optional existing eval_session=VALUE cookie. No login or credential management is exposed here.",
  },
  output:
    "One JSON document on stdout. Human-readable errors on stderr; no request/credential logging.",
  exitCodes: {
    0: "Command or lookup succeeded; submit is only queued",
    1: "Input, API, permission, cancellation or network error",
    2: "Wait reached failed/cancelled/interrupted",
    3: "Wait deadline elapsed; job may still be running",
  },
  safety:
    "No write is automatically retried. Client cancellation stops waiting/requesting, not an already accepted provider job. Use job_cancel explicitly, then inspect provider/record state.",
};
const usageError = (message) => new EvalClientError("CLI_USAGE", message, 422);
function positiveInteger(value, name) {
  if (!/^\d+$/.test(value || ""))
    throw usageError(`${name} requires a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw usageError(`${name} requires a positive integer.`);
  return number;
}
function parse(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (["--help", "-h"].includes(arg)) {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      if (
        ![
          "--url",
          "--timeout-ms",
          "--poll-interval-ms",
          "--json",
          "--input",
        ].includes(arg)
      )
        throw usageError("Unknown option. See --help.");
      const key = arg.slice(2);
      if (Object.hasOwn(flags, key))
        throw usageError("An option was supplied more than once.");
      if (index + 1 >= argv.length)
        throw usageError(`${arg} requires a value.`);
      flags[key] = argv[++index];
    } else positional.push(arg);
  }
  if (flags.json !== undefined && flags.input !== undefined)
    throw usageError("Use either --json or --input, not both.");
  if (flags["timeout-ms"] !== undefined)
    flags.timeoutMs = positiveInteger(flags["timeout-ms"], "--timeout-ms");
  if (flags["poll-interval-ms"] !== undefined)
    flags.pollIntervalMs = positiveInteger(
      flags["poll-interval-ms"],
      "--poll-interval-ms",
    );
  return { positional, flags };
}
async function readBounded(stream, signal) {
  const chunks = [];
  let bytes = 0;
  const abort = () =>
    stream.destroy(
      new EvalClientError("CANCELLED", "Input reading cancelled.", 499),
    );
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT_BYTES) {
        stream.destroy();
        throw usageError("JSON input exceeds the 16 MiB limit.");
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof EvalClientError) throw error;
    throw new EvalClientError(
      "INPUT_READ_FAILED",
      "Unable to read the JSON input file or stdin.",
      422,
    );
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function inputArguments(flags, signal) {
  let input;
  if (flags.json !== undefined) input = flags.json;
  else if (flags.input !== undefined)
    input = await readBounded(
      flags.input === "-" ? process.stdin : createReadStream(flags.input),
      signal,
    );
  else if (!process.stdin.isTTY)
    input = await readBounded(process.stdin, signal);
  if (input === undefined || !input.trim()) return {};
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES)
    throw usageError("JSON input exceeds the 16 MiB limit.");
  try {
    return JSON.parse(input);
  } catch {
    throw new EvalClientError(
      "INVALID_JSON",
      "Input must be valid JSON. Its contents were not logged.",
      422,
    );
  }
}
function waitExit(result) {
  if (result.timeout) return 3;
  return result.terminal && result.job?.status !== "completed" ? 2 : 0;
}
export async function runCli(
  argv = process.argv.slice(2),
  { signal = new AbortController().signal } = {},
) {
  const { positional, flags } = parse(argv);
  if (flags.help || !positional.length) return { result: help, exitCode: 0 };
  const [command, action, id, ...rest] = positional;
  if (command === "capabilities") {
    if (
      positional.length !== 1 ||
      flags.json !== undefined ||
      flags.input !== undefined ||
      flags.pollIntervalMs !== undefined
    )
      throw usageError("capabilities accepts no operation input.");
    return {
      result: {
        schemaVersion: "workloom.agent-operations/v1",
        operations: operationMetadata(),
      },
      exitCode: 0,
    };
  }
  if (
    command !== "call" &&
    command !== "doctor" &&
    !(command === "jobs" && action === "wait")
  )
    throw usageError("Unknown command. See --help.");
  if (
    command !== "call" &&
    (flags.json !== undefined || flags.input !== undefined)
  )
    throw usageError("JSON input options are accepted only by call.");
  if (command !== "jobs" && flags.pollIntervalMs !== undefined)
    throw usageError("--poll-interval-ms is accepted only by jobs wait.");
  const client = createEvalClient({
    ...(flags.url === undefined ? {} : { url: flags.url }),
    ...(flags.timeoutMs === undefined || command === "jobs"
      ? {}
      : { timeoutMs: flags.timeoutMs }),
  });
  if (command === "doctor") {
    if (positional.length !== 1)
      throw usageError("doctor accepts no positional arguments.");
    const result = await client.call("doctor", {}, { signal });
    return { result, exitCode: result.ok ? 0 : 1 };
  }
  if (command === "jobs") {
    if (!id || rest.length)
      throw usageError("jobs wait requires exactly one job ID.");
    const result = await client.call(
      "job_wait",
      {
        id,
        ...(flags.timeoutMs === undefined
          ? {}
          : { timeoutMs: flags.timeoutMs }),
        ...(flags.pollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: flags.pollIntervalMs }),
      },
      { signal },
    );
    return { result, exitCode: waitExit(result) };
  }
  if (!action || positional.length !== 2)
    throw usageError("call requires exactly one registered operation name.");
  const args = await inputArguments(flags, signal);
  const result = await client.call(action, args, { signal });
  return {
    result,
    exitCode:
      action === "job_wait"
        ? waitExit(result)
        : action === "doctor" && !result.ok
          ? 1
          : 0,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const { result, exitCode } = await runCli(process.argv.slice(2), {
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    // Only known, sanitized client errors are emitted. Never print stack/cause/input.
    const known = error instanceof EvalClientError;
    process.stderr.write(
      `${known ? error.code : "CLI_ERROR"}: ${known ? error.message : "Unable to complete the command."}\n`,
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
