#!/usr/bin/env bash
# ==========================================================================
# MBTI 小游戏 —— 一条命令跑完整套验收
#
#   用法：bash _dev/test-all.sh
#
# 覆盖三层：
#   1. 视图冒烟（本地 jsdom，钩住 UI.el 抓非 Node 子项）
#   2. 前端集成（本地 jsdom + 真实接口，经 SSH 隧道打到服务器测试环境）
#   3. 后端端到端（服务器上直跑，打 127.0.0.1:3001 测试库）
#
# 关键约定：生产与测试环境**同前缀不同端口**
#   生产 127.0.0.1:3000  /games/mbti/api   → /var/lib/mbti-game
#   测试 127.0.0.1:3001  /games/mbti/api   → /var/lib/mbti-game-test
# 本地测试脚本固定打 /games/mbti/api，所以必须经隧道转发到 3001。
#
# 全程不碰生产库。
#
# ⚠️ 关于「线上可达性」检查：
#   开发机（WorkBuddy 沙箱）的对外流量被强制走本地 HTTP 代理，该代理到
#   oictech.cn:443 的 TLS 握手会失败（schannel: failed to receive handshake），
#   表现为 curl 返回 000 —— 这是**本机出站限制，不是站点故障**。
#   所以线上探测一律在服务器上跑（ssh 过去 curl），别用本机 curl 下结论。
# ==========================================================================
set -uo pipefail

SSH_HOST="${MBTI_SSH_HOST:-mbti}"
TUNNEL_PORT="${MBTI_TUNNEL_PORT:-3001}"
NODE_BIN="${NODE_BIN:-node}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_MODULES="${NODE_MODULES:-C:/Users/vzwyu/.workbuddy/binaries/node/workspace/node_modules}"

export NODE_PATH="$NODE_MODULES"
PASS_ALL=1
TUNNEL_PID=""

cleanup() {
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

banner() { echo; echo "════════════════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════════════════"; }

# ---------------------------------------------------------------- 0. 前置
banner "0. 环境自检"
echo -n "  生产服务            : "
ssh -o ConnectTimeout=12 "$SSH_HOST" 'systemctl is-active mbti-game' || true
echo -n "  测试服务            : "
ssh -o ConnectTimeout=12 "$SSH_HOST" 'systemctl is-active mbti-game-test' || true
echo -n "  测试环境健康        : "
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  "curl -s -m 5 http://127.0.0.1:3001/games/mbti/api/health" || echo "无响应"
echo
echo -n "  测试库用户数        : "
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  "sudo -u www-data node -e \"
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync('/var/lib/mbti-game-test/mbti.sqlite',{readOnly:true});
    console.log(db.prepare('SELECT COUNT(*) c FROM users').get().c); db.close();
  \"" 2>/dev/null || echo "?"
echo -n "  生产库用户数        : "
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  "sudo -u www-data node -e \"
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync('/var/lib/mbti-game/mbti.sqlite',{readOnly:true});
    console.log(db.prepare('SELECT COUNT(*) c FROM users').get().c); db.close();
  \"" 2>/dev/null || echo "?"

# ---------------------------------------------------------------- 1. 本地静态与冒烟
banner "1. 本地静态与冒烟测试"
cd "$ROOT"

echo "  ── 1a. 构建载荷（含 JS 合并 + 缓存指纹）──"
mkdir -p _build
if "$NODE_BIN" _dev/build-payload.js > _build/build.log 2>&1; then
  grep -E 'JS 合并|缓存指纹|请求数|条目数|brotli|sha256' _build/build.log | sed 's/^/    /'
else
  echo "    ❌ 构建失败："
  tail -20 _build/build.log | sed 's/^/      /'
  PASS_ALL=0
fi

echo "  ── 1b. 视图冒烟（源文件）──"
if "$NODE_BIN" _dev/view-smoke-test.js; then :; else PASS_ALL=0; fi

echo "  ── 1c. 视图冒烟（构建产物 bundle.js —— 真正上线的那份）──"
# 只测源文件会漏掉「源文件都对、合并后出错」这类只在线上暴露的问题
if MBTI_BUNDLE=_build/bundle.js "$NODE_BIN" _dev/view-smoke-test.js; then :; else PASS_ALL=0; fi

echo "  ── 1d. 启动自愈与失败诊断（真实 index.html 的内联兜底脚本）──"
if "$NODE_BIN" _dev/boot-heal-test.js; then :; else PASS_ALL=0; fi

echo "  ── 1d2. 场景问卷引擎（推题规则 / 判定规则 / 收敛性）──"
if "$NODE_BIN" _dev/quiz-engine-test.js; then :; else PASS_ALL=0; fi

echo "  ── 1e. 构建产物只应有 1 个外链脚本 ──"
"$NODE_BIN" -e "
  const p = require('./_build/payload.json');
  const idx = p.find(x => x.f === 'web/index.html');
  const n = (idx.body.match(/<script\s+src=/g) || []).length;
  const hasBundle = /\/games\/mbti\/js\/bundle\.js\?v=[0-9a-f]{8}/.test(idx.body);
  console.log('    外链脚本数量: ' + n + (n === 1 ? ' ✅' : ' ❌ 应为 1'));
  console.log('    引用 bundle.js 带指纹: ' + (hasBundle ? '✅' : '❌'));
  process.exit(n === 1 && hasBundle ? 0 : 1);
" || PASS_ALL=0

# ---------------------------------------------------------------- 2. SSH 隧道
banner "2. 建立 SSH 隧道 $TUNNEL_PORT → 测试环境"
# 用后台进程而不是 ssh -f，这样才能拿到 pid 并在退出时收掉隧道
ssh -N -o ExitOnForwardFailure=yes -o ConnectTimeout=15 \
    -o ServerAliveInterval=30 \
    -L "${TUNNEL_PORT}:127.0.0.1:3001" "$SSH_HOST" &
TUNNEL_PID=$!

TUNNEL_OK=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -m 3 "http://127.0.0.1:${TUNNEL_PORT}/games/mbti/api/health" >/dev/null 2>&1; then
    TUNNEL_OK=1; break
  fi
  sleep 0.5
done
if [ "$TUNNEL_OK" = "1" ]; then
  echo "  ✅ 隧道连通（pid=$TUNNEL_PID）"
else
  echo "  ❌ 隧道不通，前端集成测试会失败"
  PASS_ALL=0
fi

# ---------------------------------------------------------------- 3. 前端集成
banner "3. 前端集成测试（本地 jsdom + 真实接口）"
if UPSTREAM="http://127.0.0.1:${TUNNEL_PORT}" "$NODE_BIN" _dev/frontend-test.js; then :; else PASS_ALL=0; fi

# ---------------------------------------------------------------- 4. 后端端到端
banner "4. 后端端到端测试（服务器上跑，打测试库）"
# 部署载荷里不含 test/（只发运行时代码），所以每次现传
scp -o ConnectTimeout=15 "$ROOT/server/test/e2e.js" "${SSH_HOST}:/tmp/e2e.js" >/dev/null \
  && echo "  e2e.js 已上传" || { echo "  ❌ e2e.js 上传失败"; PASS_ALL=0; }
ssh -o ConnectTimeout=20 "$SSH_HOST" "bash -s" <<REMOTE
set -u
sudo mkdir -p /opt/mbti-game/server/test
sudo cp -f /tmp/e2e.js /opt/mbti-game/server/test/e2e.js
sudo chmod 644 /opt/mbti-game/server/test/e2e.js
cd /opt/mbti-game/server
sudo -u www-data env HOME=/tmp MBTI_DB_PATH=/var/lib/mbti-game-test/mbti.sqlite \\
  /usr/bin/node test/e2e.js 2>&1 | tail -12
REMOTE

# ---------------------------------------------------------------- 5. 收尾核对
banner "5. 收尾核对"
echo -n "  生产库用户数（应保持不变）: "
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  "sudo -u www-data node -e \"
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync('/var/lib/mbti-game/mbti.sqlite',{readOnly:true});
    console.log(db.prepare('SELECT COUNT(*) c FROM users').get().c); db.close();
  \"" 2>/dev/null || echo "?"
echo -n "  生产库完整性              : "
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  "sudo -u www-data node -e \"
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync('/var/lib/mbti-game/mbti.sqlite',{readOnly:true});
    console.log(db.prepare('PRAGMA integrity_check').get().integrity_check); db.close();
  \"" 2>/dev/null || echo "?"
echo -n "  线上首页                  : "
# 在服务器上探，避免本机代理导致假 000（见文件头说明）
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  "curl -s -m 8 -o /dev/null -w '%{http_code}' https://www.oictech.cn/games/mbti/" || echo "?"
echo
echo "  线上全路径（服务器侧探测）:"
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  'for p in "/" "/wiki/" "/fsl/" "/ollama/" "/games/mbti/" "/games/mbti/me" "/games/mbti/js/app.js" "/games/mbti/js/__nope__.js"; do printf "    %-30s %s\n" "$p" "$(curl -s -m 8 -o /dev/null -w "%{http_code}" https://www.oictech.cn$p)"; done'
echo "  线上首页的资源引用（必须只剩 bundle + css）:"
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  'curl -s -m 8 https://www.oictech.cn/games/mbti/ | grep -oE "(src|href)=\"/games/mbti/[^\"]+\"" | sed "s/^/    /"; \
   echo -n "    外链脚本数量: "; curl -s -m 8 https://www.oictech.cn/games/mbti/ | grep -oc "<script src="'
echo "  短域名 bffmbti.oictech.cn:"
ssh -o ConnectTimeout=12 "$SSH_HOST" \
  'if getent hosts bffmbti.oictech.cn >/dev/null 2>&1; then
     printf "    根路径  : "; curl -s -m 8 -o /dev/null -w "%{http_code} → %{redirect_url}\n" http://bffmbti.oictech.cn/
     printf "    深链接  : "; curl -s -m 8 -o /dev/null -w "%{http_code} → %{redirect_url}\n" http://bffmbti.oictech.cn/s/demo
     printf "    HTTPS   : "; curl -s -m 8 -o /dev/null -w "%{http_code}\n" https://bffmbti.oictech.cn/ 2>/dev/null || echo "证书未就绪"
   else
     echo "    DNS 未解析，跳过（给 bffmbti 加一条 A 记录指向本服务器后重跑）"
   fi'
echo -n "  nginx server_name 冲突    : "
ssh -o ConnectTimeout=12 "$SSH_HOST" "sudo nginx -t 2>&1 | grep -c 'conflicting server name'" || true

echo
if [ "$PASS_ALL" = "1" ]; then
  echo "═══════ ✅ 全部通过 ═══════"
else
  echo "═══════ ❌ 存在失败项，见上方输出 ═══════"
fi
exit $((1 - PASS_ALL))
