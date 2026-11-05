import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { OPERATIONS, getOperation } from "./operations.mjs";

export class EvalClientError extends Error {
  constructor(code, message, status = 0, details) {
    super(message);
    this.name = "EvalClientError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}
const invalid = (message) =>
  new EvalClientError("INVALID_ARGUMENTS", message, 422);
const objectLike = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sensitiveKey =
  /^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|apiToken|access[-_]?token|refresh[-_]?token|bearerToken|token|tokenHash|secret|secretValue|secretKey|clientSecret|credential|credentials|password|password_hash|private[-_]?key|sessionToken|sessionCookie|eval_session|salt|reasoning_content)$/i;
function credentialText(value, secrets) {
  let result = String(value);
  for (const secret of secrets)
    if (secret) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
      "[REDACTED]",
    )
    .replace(/\beval_session=[^;\s"'<>]+/gi, "eval_session=[REDACTED]");
}
function redact(value, secrets, depth = 0) {
  if (depth > 60) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return credentialText(value, secrets);
  if (Array.isArray(value))
    return value.map((child) => redact(child, secrets, depth + 1));
  if (objectLike(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sensitiveKey.test(key)
          ? "[REDACTED]"
          : redact(child, secrets, depth + 1),
      ]),
    );
  return value;
}
function validateJson(value, depth = 0, seen = new WeakSet()) {
  if (depth > 40)
    throw invalid("Arguments exceed the maximum JSON nesting depth.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value))
    throw invalid("Arguments must contain finite, acyclic JSON values only.");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw invalid("Arguments must contain plain JSON objects only.");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw invalid("Arguments contain a forbidden object key.");
    if (sensitiveKey.test(key) && child)
      throw invalid(
        "Credentials are not accepted by ordinary operations. Configure credentials separately in process memory.",
      );
    validateJson(child, depth + 1, seen);
  }
  seen.delete(value);
}
function validateSchema(value, schema, path = "arguments") {
  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const))
    throw invalid(`${path} does not match its required constant.`);
  if (
    schema.enum &&
    !schema.enum.some((item) => isDeepStrictEqual(item, value))
  )
    throw invalid(`${path} is not an allowed value.`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((option) => {
      try {
        validateSchema(value, option, path);
        return true;
      } catch (error) {
        if (error.code !== "INVALID_ARGUMENTS") throw error;
        return false;
      }
    });
    if (matches.length !== 1)
      throw invalid(
        `${path} must match exactly one documented operation variant.`,
      );
  }
  if (
    schema.anyOf &&
    !schema.anyOf.some((option) => {
      try {
        validateSchema(value, option, path);
        return true;
      } catch (error) {
        if (error.code !== "INVALID_ARGUMENTS") throw error;
        return false;
      }
    })
  )
    throw invalid(`${path} is missing a required documented alternative.`);
  const type = schema.type;
  if (
    type &&
    !(type === "object"
      ? objectLike(value)
      : type === "array"
        ? Array.isArray(value)
        : type === "integer"
          ? Number.isSafeInteger(value)
          : type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : typeof value === type)
  )
    throw invalid(`${path} must be ${type}.`);
  if (
    typeof value === "number" &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw invalid(`${path} is outside its documented numeric limits.`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (
      (schema.minLength !== undefined && length < schema.minLength) ||
      (schema.maxLength !== undefined && length > schema.maxLength)
    )
      throw invalid(`${path} is outside its documented text length limits.`);
  }
  if (Array.isArray(value)) {
    if (
      (schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems)
    )
      throw invalid(`${path} is outside its documented item limits.`);
    if (
      schema.uniqueItems &&
      value.some((item, index) =>
        value.slice(0, index).some((other) => isDeepStrictEqual(item, other)),
      )
    )
      throw invalid(`${path} must not contain duplicate items.`);
    if (schema.items)
      value.forEach((item, index) =>
        validateSchema(item, schema.items, `${path}[${index}]`),
      );
  }
  if (objectLike(value)) {
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key))
        throw invalid(`${path}.${key} is required.`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key))
        validateSchema(child, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false)
        throw invalid(`${path} contains an undocumented field.`);
    }
  }
}
function checkedLimit(value, fallback, minimum, maximum, field) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw invalid(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  return result;
}
function parseBase(value) {
  let base;
  try {
    base = new URL(value);
  } catch {
    throw new EvalClientError(
      "INVALID_URL",
      "EVAL_URL must be an absolute HTTP(S) service origin.",
      422,
    );
  }
  const host = base.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (
    base.username ||
    base.password ||
    base.hash ||
    base.search ||
    base.pathname !== "/" ||
    !["https:", "http:"].includes(base.protocol)
  )
    throw new EvalClientError(
      "UNSAFE_URL",
      "EVAL_URL must be a credential-free HTTP(S) origin without a path, query or fragment.",
      422,
    );
  if (base.protocol === "http:" && !loopback)
    throw new EvalClientError(
      "HTTPS_REQUIRED",
      "Remote service connections require HTTPS; HTTP is accepted only for loopback hosts.",
      403,
    );
  return base;
}

export function createEvalClient({
  url = process.env.EVAL_URL || "http://127.0.0.1:4317",
  token = process.env.EVAL_API_TOKEN,
  sessionCookie = process.env.EVAL_SESSION_COOKIE ||
    (process.env.EVAL_SESSION_TOKEN
      ? `eval_session=${process.env.EVAL_SESSION_TOKEN}`
      : undefined),
  timeoutMs = 30000,
  maxResponseBytes = 8 * 1024 * 1024,
} = {}) {
  const base = parseBase(url);
  const requestTimeout = checkedLimit(timeoutMs, 30000, 1, 300000, "timeoutMs");
  const maxBytes = checkedLimit(
    maxResponseBytes,
    8 * 1024 * 1024,
    64,
    32 * 1024 * 1024,
    "maxResponseBytes",
  );
  if (
    token !== undefined &&
    (typeof token !== "string" || !/^[\x21-\x7E]{0,8192}$/.test(token))
  )
    throw invalid("EVAL_API_TOKEN is not a valid header value.");
  if (
    sessionCookie !== undefined &&
    (typeof sessionCookie !== "string" ||
      !/^eval_session=[^;\s\r\n]{1,8192}$/.test(sessionCookie))
  )
    throw invalid(
      "Session authentication must contain only the eval_session cookie.",
    );
  const secrets = [
    token,
    sessionCookie,
    sessionCookie?.slice("eval_session=".length),
  ].filter(Boolean);
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  else if (sessionCookie) headers.cookie = sessionCookie;
  const safe = (value) => redact(value, secrets);
  const apiError = (response, value) => {
    const source = objectLike(value?.error) ? value.error : {};
    const code =
      typeof source.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,79}$/.test(source.code)
        ? safe(source.code)
        : "HTTP_ERROR";
    return new EvalClientError(
      code,
      safe(
        typeof source.message === "string"
          ? source.message.slice(0, 3000)
          : `Platform request failed with HTTP ${response.status}.`,
      ),
      response.status,
      source.details === undefined ? undefined : safe(source.details),
    );
  };
  async function request(operation, args, { signal, remainingMs } = {}) {
    if (signal?.aborted)
      throw new EvalClientError(
        "CANCELLED",
        "Client request cancelled; no server-side cancellation is implied.",
        499,
      );
    let spec;
    try {
      spec = operation.request(args);
    } catch {
      throw invalid(
        "A resource ID cannot be used as a safe URL path component.",
      );
    }
    if (
      !spec ||
      !/^\/api\//.test(spec.path) ||
      !["GET", "POST", "PUT", "DELETE"].includes(spec.method)
    )
      throw new EvalClientError(
        "INVALID_OPERATION",
        "Operation has no allowed request mapping.",
        500,
      );
    const target = new URL(spec.path, base);
    if (target.origin !== base.origin || !target.pathname.startsWith("/api/"))
      throw new EvalClientError(
        "INVALID_OPERATION",
        "Operation attempted to leave its registered service path.",
        500,
      );
    const timer = new AbortController();
    const duration = Math.max(
      1,
      Math.min(requestTimeout, remainingMs ?? requestTimeout),
    );
    const timeout = setTimeout(() => timer.abort(), duration);
    const combined = signal
      ? AbortSignal.any([signal, timer.signal])
      : timer.signal;
    try {
      const body =
        spec.body === undefined ? undefined : JSON.stringify(spec.body);
      if (body && Buffer.byteLength(body) > 16 * 1024 * 1024)
        throw new EvalClientError(
          "REQUEST_TOO_LARGE",
          "Request exceeds the 16 MiB client limit.",
          413,
        );
      const response = await fetch(target, {
        method: spec.method,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : { "content-type": "application/json", origin: base.origin }),
          ...(args.idempotencyKey
            ? { "idempotency-key": args.idempotencyKey }
            : {}),
        },
        body,
        signal: combined,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new EvalClientError(
          "REDIRECT_DENIED",
          "Service redirects are refused. Configure the final HTTPS origin explicitly.",
          403,
        );
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel();
        throw new EvalClientError(
          "RESPONSE_TOO_LARGE",
          "Platform response exceeds the configured byte limit.",
          413,
        );
      }
      const chunks = [];
      let bytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
              await reader.cancel();
              throw new EvalClientError(
                "RESPONSE_TOO_LARGE",
                "Platform response exceeds the configured byte limit.",
                413,
              );
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const content = new TextDecoder().decode(Buffer.concat(chunks));
      const contentType = response.headers.get("content-type") || "";
      let value;
      try {
        value = content ? JSON.parse(content) : null;
      } catch {
        if (!response.ok) throw apiError(response, null);
        if (!spec.format || spec.format === "json")
          throw new EvalClientError(
            "INVALID_RESPONSE",
            "Platform returned a non-JSON response for a JSON operation.",
            502,
          );
      }
      if (!response.ok) throw apiError(response, value);
      if (spec.format && spec.format !== "json")
        return safe({ format: spec.format, content, contentType });
      if (!content.trim() || (!/\bjson\b/i.test(contentType) && value === null))
        throw new EvalClientError(
          "INVALID_RESPONSE",
          "Platform returned no JSON result.",
          502,
        );
      return safe(value);
    } catch (error) {
      if (error instanceof EvalClientError) throw error;
      if (signal?.aborted)
        throw new EvalClientError(
          "CANCELLED",
          "Client request cancelled; use job_cancel separately if server cancellation is required.",
          499,
        );
      if (timer.signal.aborted)
        throw new EvalClientError(
          "REQUEST_TIMEOUT",
          "Client request deadline elapsed. The server may still be processing it; writes were not retried.",
          504,
        );
      throw new EvalClientError(
        "NETWORK_ERROR",
        "Unable to complete the platform request. No automatic retry was attempted.",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  async function wait(args, { signal } = {}) {
    const deadline = Date.now() + (args.timeoutMs ?? 30000);
    const interval = args.pollIntervalMs ?? 500;
    let job = null;
    while (Date.now() < deadline) {
      try {
        job = await request(
          getOperation("job_get"),
          { id: args.id },
          { signal, remainingMs: deadline - Date.now() },
        );
      } catch (error) {
        if (error.code === "REQUEST_TIMEOUT" && Date.now() >= deadline)
          return {
            terminal: false,
            timeout: true,
            job,
            lastStatus: job?.status ?? null,
          };
        throw error;
      }
      if (!objectLike(job) || typeof job.status !== "string")
        throw new EvalClientError(
          "INVALID_JOB_RESPONSE",
          "Platform job result has no status.",
          502,
        );
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(job.status)
      )
        return { terminal: true, timeout: false, job, lastStatus: job.status };
      if (!["queued", "running"].includes(job.status))
        throw new EvalClientError(
          "UNKNOWN_JOB_STATUS",
          "Platform returned an undocumented job status; it was not treated as completion.",
          502,
        );
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await delay(Math.min(interval, remaining), undefined, { signal });
      } catch {
        throw new EvalClientError(
          "CANCELLED",
          "Client wait cancelled; the platform job was not cancelled or resubmitted.",
          499,
        );
      }
    }
    if (signal?.aborted)
      throw new EvalClientError(
        "CANCELLED",
        "Client wait cancelled; the platform job was not cancelled or resubmitted.",
        499,
      );
    return {
      terminal: false,
      timeout: true,
      job,
      lastStatus: job?.status ?? null,
    };
  }
  async function doctor({ signal } = {}) {
    const names = ["health", "session", "status", "capabilities"];
    const results = await Promise.allSettled(
      names.map((name) => request(getOperation(name), {}, { signal })),
    );
    if (signal?.aborted)
      throw new EvalClientError(
        "CANCELLED",
        "Client diagnostics cancelled; no model probe was sent.",
        499,
      );
    const checks = {};
    for (let index = 0; index < names.length; index++) {
      const name = names[index],
        result = results[index];
      if (result.status === "fulfilled") {
        const accepted =
          name === "session"
            ? Boolean(result.value?.user)
            : name === "health"
              ? result.value?.ok === true &&
                result.value?.product === "workloom-eval"
              : name === "status"
                ? result.value?.ok === true
                : result.value?.product === "workloom-eval" &&
                  result.value?.apiVersion === "1";
        const mismatch =
          ["health", "capabilities"].includes(name) &&
          result.value?.product !== "workloom-eval";
        const apiMismatch =
          name === "capabilities" &&
          !mismatch &&
          result.value?.apiVersion !== "1";
        checks[name] = {
          ok: accepted,
          result: result.value,
          ...(mismatch
            ? {
                error: {
                  code: "PRODUCT_MISMATCH",
                  status: 502,
                  message:
                    "Service product identity does not match workloom-eval.",
                },
              }
            : {}),
          ...(apiMismatch
            ? {
                error: {
                  code: "API_VERSION_MISMATCH",
                  status: 502,
                  message:
                    "Service Agent API version is not supported by this client.",
                },
              }
            : {}),
        };
      } else {
        checks[name] = {
          ok: false,
          error: {
            code: result.reason.code || "CLIENT_ERROR",
            status: result.reason.status || 0,
            message: result.reason.message || "Diagnostic request failed.",
          },
        };
      }
    }
    return {
      ok: Object.values(checks).every((check) => check.ok),
      checks,
      authenticated: Boolean(checks.session.result?.user),
      modelConfigured: checks.status.result?.modelConfigured ?? false,
      modelProbeExecuted: false,
    };
  }
  return {
    operations: OPERATIONS,
    async call(name, args = {}, options = {}) {
      const operation = getOperation(name);
      if (!operation)
        throw new EvalClientError(
          "UNKNOWN_OPERATION",
          "Operation is not in the public catalogue.",
          422,
        );
      if (!objectLike(args))
        throw invalid("Operation arguments must be a JSON object.");
      if (
        !objectLike(options) ||
        (options.signal !== undefined &&
          !(options.signal instanceof AbortSignal))
      )
        throw invalid(
          "Call options must contain a native AbortSignal when a signal is supplied.",
        );
      validateJson(args);
      validateSchema(args, operation.inputSchema);
      if (args.idempotencyKey && /[\r\n]/.test(args.idempotencyKey))
        throw invalid(
          "Idempotency keys cannot contain header control characters.",
        );
      // URL dot segments normalize before HTTP dispatch, even when percent encoded.
      for (const field of ["id", "datasetId", "employeeId", "subjectId"])
        if ([".", ".."].includes(args[field]))
          throw invalid("Resource IDs cannot be URL dot segments.");
      if (operation.local === "job_wait") return wait(args, options);
      if (operation.local === "doctor") return doctor(options);
      return request(operation, args, options);
    },
  };
}
