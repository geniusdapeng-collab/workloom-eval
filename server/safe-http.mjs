import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isDeepStrictEqual } from "node:util";

export function problem(code, message, status = 422, details) {
  return Object.assign(new Error(message), {
    code,
    status,
    ...(details ? { details } : {}),
  });
}

export function isPrivateAddress(address) {
  const a = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  if (net.isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number);
    return (
      x === 0 ||
      x === 10 ||
      x === 127 ||
      x >= 224 ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && [0, 168].includes(y)) ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 198 && [18, 19].includes(y))
    );
  }
  if (net.isIP(a) === 6) {
    if (a.startsWith("::ffff:")) {
      const tail = a.slice(7);
      if (tail.includes(".")) return isPrivateAddress(tail);
      const pieces = tail.split(":");
      if (pieces.length === 2) {
        const x = Number.parseInt(pieces[0], 16),
          y = Number.parseInt(pieces[1], 16);
        return isPrivateAddress(`${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`);
      }
      return true;
    }
    return (
      a === "::" ||
      a === "::1" ||
      /^(fc|fd|fe[89ab]|ff)/.test(a) ||
      a.startsWith("2001:db8:") ||
      a.startsWith("2002:") ||
      a.startsWith("2001:0:") ||
      a.startsWith("64:ff9b:")
    );
  }
  return true;
}

function matchesHost(url, entry) {
  if (typeof entry !== "string" || entry.includes("*")) return false;
  try {
    if (entry.includes("://")) return new URL(entry).origin === url.origin;
    return (
      entry.toLowerCase() === url.host.toLowerCase() ||
      entry.toLowerCase() === url.hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}

export async function validateTarget(input, policy = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw problem("INVALID_URL", "工具地址不是有效 URL");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw problem(
      "UNSAFE_URL",
      "仅允许无凭据的 HTTP(S) 地址，且不能带片段",
      403,
    );
  if (url.protocol === "http:" && !policy.allowInsecure)
    throw problem("HTTPS_REQUIRED", "外部工具必须使用 HTTPS", 403);
  if (!(policy.allowedHosts || []).some((entry) => matchesHost(url, entry)))
    throw problem(
      "HOST_NOT_ALLOWED",
      `目标主机未在管理员允许列表：${url.host}`,
      403,
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await dns.lookup(hostname, { all: true });
  } catch {
    throw problem("DNS_FAILURE", "工具主机解析失败", 503);
  }
  if (!addresses.length)
    throw problem("DNS_FAILURE", "工具主机没有可用地址", 503);
  const privateAllowed = (policy.allowPrivateHosts || []).some((entry) =>
    matchesHost(url, entry),
  );
  if (
    !privateAllowed &&
    addresses.some(({ address }) => isPrivateAddress(address))
  )
    throw problem(
      "PRIVATE_NETWORK_DENIED",
      "目标地址属于私网或保留地址，需管理员明确允许",
      403,
    );
  return { url, addresses };
}

export async function safeRequest({
  url: input,
  method = "GET",
  body,
  headers = {},
  signal,
  allowedHosts = [],
  allowPrivateHosts = [],
  allowInsecure = false,
  timeoutMs = 30000,
  maxBytes = 2097152,
}) {
  if (signal?.aborted)
    throw signal.reason || problem("ABORTED", "请求已取消", 499);
  const { url, addresses } = await validateTarget(input, {
    allowedHosts,
    allowPrivateHosts,
    allowInsecure,
  });
  const serialized =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized) > maxBytes)
    throw problem("REQUEST_TOO_LARGE", "工具请求超过大小限制", 413);
  if (
    !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(
      method.toUpperCase(),
    )
  )
    throw problem("INVALID_METHOD", "不支持的 HTTP 方法");
  const sanitized = { accept: "application/json", ...headers };
  for (const key of Object.keys(sanitized)) {
    if (
      [
        "host",
        "connection",
        "transfer-encoding",
        "content-length",
        "proxy-authorization",
      ].includes(key.toLowerCase())
    )
      delete sanitized[key];
  }
  if (serialized !== undefined)
    sanitized["content-type"] ||= "application/json";
  return await new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        method: method.toUpperCase(),
        headers: sanitized,
        signal,
        lookup: (_host, options, callback) =>
          options?.all
            ? callback(null, addresses)
            : callback(null, addresses[0].address, addresses[0].family),
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            const error = problem(
              "RESPONSE_TOO_LARGE",
              "工具响应超过大小限制",
              502,
            );
            reject(error);
            response.destroy(error);
            req.destroy(error);
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode || 502;
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            /* Text responses remain in text. */
          }
          if (status >= 300 && status < 400)
            return reject(
              problem(
                "REDIRECT_DENIED",
                "工具重定向被拒绝，请配置最终地址",
                403,
              ),
            );
          if (status < 200 || status >= 300)
            return reject(
              problem(
                "UPSTREAM_HTTP_ERROR",
                `工具返回 HTTP ${status}`,
                status === 429 ? 429 : 502,
                { upstreamStatus: status },
              ),
            );
          resolve({
            status,
            headers: response.headers,
            data,
            text,
            buffer: Buffer.concat(chunks),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(problem("UPSTREAM_TIMEOUT", "工具请求超时", 504)),
    );
    req.on("error", reject);
    if (serialized !== undefined) req.write(serialized);
    req.end();
  });
}

export const safeFetch = safeRequest;

export function getPath(object, path) {
  const segments = Array.isArray(path)
    ? path
    : String(path || "")
        .split(".")
        .filter(Boolean);
  if (
    segments.some((p) =>
      ["__proto__", "prototype", "constructor"].includes(String(p)),
    )
  )
    throw problem("UNSAFE_PATH", "路径包含禁止字段", 403);
  return segments.reduce((value, key) => value?.[key], object);
}

export function setPath(object, path, value) {
  const parts = String(path).split(".");
  getPath({}, parts);
  if (parts.length > 16 || parts.some((p) => !p))
    throw problem("INVALID_PATH", "状态路径无效");
  let target = object;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== "object") target[part] = {};
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

export function assertSchema(value, schema = {}, path = "$", depth = 0) {
  if (depth > 24) throw problem("SCHEMA_DEPTH", "Schema 嵌套过深");
  if (!schema || typeof schema !== "object")
    throw problem("INVALID_SCHEMA", "Schema 必须为对象");
  const supported = new Set([
    "type",
    "enum",
    "const",
    "anyOf",
    "allOf",
    "oneOf",
    "not",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minProperties",
    "maxProperties",
    "format",
    "$schema",
    "$id",
    "title",
    "description",
    "default",
    "examples",
    "readOnly",
    "writeOnly",
  ]);
  for (const key of Object.keys(schema))
    if (!supported.has(key))
      throw problem(
        "SCHEMA_KEYWORD_UNSUPPORTED",
        `${path} 使用了尚未支持的schema关键字 ${key}，请改用显式字段约束`,
      );
  if (
    schema.enum &&
    (!Array.isArray(schema.enum) ||
      !schema.enum.some((x) => isDeepStrictEqual(x, value)))
  )
    throw problem("TOOL_SCHEMA", `${path} 不在允许取值内`);
  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const))
    throw problem("TOOL_SCHEMA", `${path} 与固定值不匹配`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((option) => {
      try {
        assertSchema(value, option, path, depth + 1);
        return true;
      } catch (error) {
        if (error.code !== "TOOL_SCHEMA") throw error;
        return false;
      }
    });
    if (matches.length !== 1)
      throw problem("TOOL_SCHEMA", `${path} 必须且只能符合一个oneOf分支`);
  }
  if (schema.not) {
    let matches = false;
    try {
      assertSchema(value, schema.not, path, depth + 1);
      matches = true;
    } catch (error) {
      if (error.code !== "TOOL_SCHEMA") throw error;
    }
    if (matches) throw problem("TOOL_SCHEMA", `${path} 命中禁止的schema`);
  }
  if (schema.anyOf) {
    if (
      !schema.anyOf.some((option) => {
        try {
          assertSchema(value, option, path, depth + 1);
          return true;
        } catch (error) {
          if (error.code !== "TOOL_SCHEMA") throw error;
          return false;
        }
      })
    )
      throw problem("TOOL_SCHEMA", `${path} 不符合 anyOf`);
  }
  if (schema.allOf)
    for (const option of schema.allOf)
      assertSchema(value, option, path, depth + 1);
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (types.length) {
    const matches = types.some((type) =>
      type === "null"
        ? value === null
        : type === "array"
          ? Array.isArray(value)
          : type === "object"
            ? value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
            : type === "integer"
              ? Number.isInteger(value)
              : typeof value === type,
    );
    if (!matches)
      throw problem("TOOL_SCHEMA", `${path} 类型应为 ${types.join("|")}`);
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    )
      throw problem("TOOL_SCHEMA", `${path} 数值越界`);
    if (
      (schema.exclusiveMinimum !== undefined &&
        value <= schema.exclusiveMinimum) ||
      (schema.exclusiveMaximum !== undefined &&
        value >= schema.exclusiveMaximum)
    )
      throw problem("TOOL_SCHEMA", `${path} 数值越界`);
    if (
      schema.multipleOf !== undefined &&
      (!(schema.multipleOf > 0) ||
        Math.abs(
          value / schema.multipleOf - Math.round(value / schema.multipleOf),
        ) > 1e-8)
    )
      throw problem("TOOL_SCHEMA", `${path} 不符合multipleOf`);
  }
  if (typeof value === "string") {
    const size = [...value].length;
    if (
      (schema.minLength !== undefined && size < schema.minLength) ||
      (schema.maxLength !== undefined && size > schema.maxLength)
    )
      throw problem("TOOL_SCHEMA", `${path} 文本长度越界`);
    if (schema.format) {
      let valid;
      if (schema.format === "uri") {
        try {
          valid = Boolean(new URL(value).protocol);
        } catch {
          valid = false;
        }
      } else if (schema.format === "email")
        valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      else if (schema.format === "date-time")
        valid =
          /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
      else if (schema.format === "uuid")
        valid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            value,
          );
      else
        throw problem(
          "SCHEMA_FORMAT_UNSUPPORTED",
          `${path} 不支持格式 ${schema.format}`,
        );
      if (!valid)
        throw problem("TOOL_SCHEMA", `${path} 格式不符合 ${schema.format}`);
    }
  }
  if (Array.isArray(value)) {
    if (value.length > 10000)
      throw problem("TOOL_SCHEMA", `${path} 数组超过10000项安全上限`);
    if (
      (schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems)
    )
      throw problem("TOOL_SCHEMA", `${path} 数组长度越界`);
    if (schema.items)
      value.forEach((item, i) =>
        assertSchema(item, schema.items, `${path}[${i}]`, depth + 1),
      );
    if (schema.uniqueItems) {
      const canonical = (item) =>
        item && typeof item === "object"
          ? Array.isArray(item)
            ? `[${item.map(canonical).join(",")}]`
            : `{${Object.keys(item)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
                .join(",")}}`
          : JSON.stringify(item);
      const keys = value.map(canonical);
      if (new Set(keys).size !== keys.length)
        throw problem("TOOL_SCHEMA", `${path} 包含重复项`);
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const size = Object.keys(value).length;
    if (
      (schema.minProperties !== undefined && size < schema.minProperties) ||
      (schema.maxProperties !== undefined && size > schema.maxProperties)
    )
      throw problem("TOOL_SCHEMA", `${path} 对象字段数越界`);
    for (const key of Object.keys(value))
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw problem("TOOL_SCHEMA", `${path} 包含禁止字段`);
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key))
        throw problem("TOOL_SCHEMA", `${path}.${key} 为必填字段`);
    for (const [key, val] of Object.entries(value)) {
      if (schema.properties?.[key])
        assertSchema(val, schema.properties[key], `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false)
        throw problem("TOOL_SCHEMA", `${path}.${key} 为未知字段`);
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      )
        assertSchema(
          val,
          schema.additionalProperties,
          `${path}.${key}`,
          depth + 1,
        );
    }
  }
  return value;
}
