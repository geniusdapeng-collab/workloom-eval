import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
const root = process.cwd(),
  skip = new Set([
    ".git",
    "node_modules",
    ".runtime",
    "dist",
    "work",
    "coverage",
  ]);
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    skip.has(e.name)
      ? []
      : e.isDirectory()
        ? files(join(dir, e.name))
        : [join(dir, e.name)],
  );
}
const all = files(root);
let failed = false;
let checked = 0;
for (const p of all) {
  if (
    !/\.(mjs|js|jsx|json|md|yml|yaml|html|css|txt|command)$/.test(p) &&
    ![
      "LICENSE",
      "NOTICE",
      "Dockerfile",
      ".dockerignore",
      ".gitignore",
      ".prettierignore",
    ].includes(basename(p))
  )
    continue;
  const text = readFileSync(p, "utf8");
  checked++;
  for (const pattern of [
    /gh[pousr]_[A-Za-z0-9]{24,}/,
    /sk-[A-Za-z0-9]{24,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ])
    if (pattern.test(text)) {
      console.error(`Secret-pattern violation: ${relative(root, p)}`);
      failed = true;
    }
  if (p.endsWith(".mjs")) {
    const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    if (r.status) {
      console.error(r.stderr);
      failed = true;
    }
  }
  if (p.endsWith(".json"))
    try {
      JSON.parse(text);
    } catch {
      console.error(`Invalid JSON: ${relative(root, p)}`);
      failed = true;
    }
}
const manifest = JSON.parse(readFileSync("product.manifest.json", "utf8"));
if (
  manifest.productId !== "workloom-eval" ||
  manifest.repository !== "geniusdapeng-collab/workloom-eval"
)
  throw new Error("Product identity mismatch");
for (const required of [
  "README.md",
  "docs/FEATURE-MATRIX.md",
  "docs/DEPLOYMENT.md",
  "docs/ACCEPTANCE.md",
  "AGENTS.md",
  "LICENSE",
  "NOTICE",
  "public/THIRD_PARTY_NOTICES.txt",
])
  if (!existsSync(required)) {
    console.error(`Missing deliverable: ${required}`);
    failed = true;
  }
if (JSON.parse(readFileSync("package.json", "utf8")).license !== "Apache-2.0") {
  console.error("Missing or unexpected package license declaration.");
  failed = true;
}
console.log(
  `Checked ${checked} source/document files: syntax, JSON, secret patterns and product identity.`,
);
if (failed) process.exitCode = 1;
