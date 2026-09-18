#!/usr/bin/env bash
# ==========================================================================
# MBTI 站点分层探针 —— 每分钟跑一次，只在「异常」时写日志
#
#   为什么要有它：用户反馈"经常连不上，刷新几下或过一会儿又好了"。
#   这种偶发故障靠人工复现抓不到，必须留证据。
#   所以探针**逐层**检查，把失败定位到具体一层：
#       1) DNS 解析      —— 解析不出来 = 解析商/本地 DNS 问题
#       2) TCP 连接      —— 连不上 = 入口被封/清洗/路由
#       3) TLS 握手      —— 握手失败 = 证书或中间设备
#       4) HTTP 状态     —— 非 200 = 应用或反代
#       5) 响应体特征     —— 含 webblock = 腾讯云未备案拦截
#
#   只在异常时写日志（正常不写），日志按天切、保留 14 天。
# ==========================================================================
set -uo pipefail

HOST=www.oictech.cn
URL="https://$HOST/games/mbti/api/health"
LOG=/var/log/mbti-watchdog.log
STATE=/var/lib/mbti-watchdog/state
mkdir -p "$(dirname "$STATE")" 2>/dev/null || true

stamp() { date '+%Y-%m-%d %H:%M:%S%z'; }

fail() {
  printf '%s  [FAIL:%s] %s\n' "$(stamp)" "$1" "$2" >> "$LOG"
  # 状态从"正常"翻转为"异常"时，额外记一条醒目的分隔线
  if [ "$(cat "$STATE" 2>/dev/null || echo up)" != "down" ]; then
    printf '%s  -------- 故障开始 --------\n' "$(stamp)" >> "$LOG"
  fi
  echo down > "$STATE"
}

ok() {
  if [ "$(cat "$STATE" 2>/dev/null || echo up)" = "down" ]; then
    printf '%s  ======== 已恢复（本轮正常）========\n' "$(stamp)" >> "$LOG"
  fi
  echo up > "$STATE"
}

# ---- 1. DNS ----
IP=$(getent hosts "$HOST" 2>/dev/null | awk '{print $1}' | head -1)
if [ -z "$IP" ]; then
  fail DNS "解析不出 $HOST（解析商或本地 DNS 问题）"
  exit 0
fi

# ---- 2. TCP 443（只握手，不发请求）----
if ! timeout 5 bash -c "exec 3<>/dev/tcp/$IP/443" 2>/dev/null; then
  fail TCP "$IP:443 连不上（入口被封 / DDoS 清洗 / 路由中断）"
  exit 0
fi

# ---- 3+4. TLS + HTTP ----
BODY=$(mktemp)
CODE=$(curl -s -m 10 -o "$BODY" -w '%{http_code}' --resolve "$HOST:443:$IP" "$URL" 2>/dev/null)
CURL_RC=$?

if [ "$CURL_RC" != "0" ]; then
  case "$CURL_RC" in
    35|51|60) fail TLS "证书校验失败（curl rc=$CURL_RC）" ;;
    28)       fail TIMEOUT "请求超时（10s）" ;;
    56)       fail RESET   "连接被重置（rc=56）—— 特征同 ERR_CONNECTION_RESET" ;;
    *)        fail CURL    "curl 失败 rc=$CURL_RC" ;;
  esac
  rm -f "$BODY"
  exit 0
fi

if [ "$CODE" != "200" ]; then
  if grep -qi 'webblock\|未完成备案' "$BODY" 2>/dev/null; then
    fail BLOCK "HTTP $CODE —— 腾讯云未备案拦截页"
  else
    fail HTTP "HTTP $CODE（期望 200）"
  fi
  rm -f "$BODY"
  exit 0
fi

# 200 了还要确认内容对：返回的必须是我们的 health JSON，不是被顶替的页面
if ! grep -q '"ok":true' "$BODY" 2>/dev/null; then
  fail BODY "HTTP 200 但响应体不是预期 JSON（可能被中间设备篡改）"
  rm -f "$BODY"
  exit 0
fi

rm -f "$BODY"
ok
exit 0
