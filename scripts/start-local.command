#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  eval_node_dir="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
  if [ -x "$eval_node_dir/node" ]; then
    export PATH="$eval_node_dir:$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
  else
    print -u2 '请先安装 Node.js 24 或更高版本。'
    exit 1
  fi
fi
if [ ! -d node_modules ]; then
  pnpm install --frozen-lockfile
fi
if [ ! -f dist/index.html ]; then
  pnpm build
fi
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  read -r -s 'eval_session_key?DeepSeek API Key（隐藏输入，可留空后在界面配置）：'
  print
  export DEEPSEEK_API_KEY="$eval_session_key"
  unset eval_session_key
fi
export HOST=127.0.0.1 PORT=4317 EVAL_AUTH_MODE=local
print '打开 http://127.0.0.1:4317；关闭此窗口会停止服务。'
trap 'unset DEEPSEEK_API_KEY' EXIT
node server/index.mjs
