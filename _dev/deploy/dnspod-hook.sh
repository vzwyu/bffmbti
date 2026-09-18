#!/usr/bin/env bash
# ==========================================================================
# certbot 的 DNSPod DNS-01 钩子（auth + cleanup 共用，按 $1 区分）
#
#   用法（由 certbot 自动调用，不要手工跑）：
#     --manual-auth-hook    "bash dnspod-hook.sh auth"
#     --manual-cleanup-hook "bash dnspod-hook.sh cleanup"
#
# 为什么必须用 DNS-01 而不是 HTTP-01：
#   bffmbti.oictech.cn 不在腾讯云备案名单里，**境外访问 80 端口会被返回
#   "未完成备案"拦截页**（实测：dnspod.qcloud.com/static/webblock.html）。
#   Let's Encrypt 的校验服务器在境外 → HTTP-01 必然失败。
#   而 443 端口不被拦（实测境外可完成 TLS 握手），所以只要证书到手，
#   HTTPS 境内境外都通。DNS-01 全程不碰 80，是唯一能自动化的路径。
#
# 凭据文件（600，root）：/etc/letsencrypt/dnspod.env
#   DP_ID=<DNSPod 的 ID，纯数字>
#   DP_KEY=<DNSPod 的 Token>
#   DP_DOMAIN=oictech.cn            # DNSPod 里的主域名
#   DP_SUB=_acme-challenge.bffmbti  # 主域名之前的部分
# ==========================================================================
set -uo pipefail

ACTION="${1:?用法: dnspod-hook.sh auth|cleanup}"
ENV_FILE=/etc/letsencrypt/dnspod.env
API=https://dnsapi.cn

[ -f "$ENV_FILE" ] || { echo "缺少凭据文件 $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${DP_ID:?DP_ID 未设置}" "${DP_KEY:?DP_KEY 未设置}"
: "${DP_DOMAIN:?DP_DOMAIN 未设置}" "${DP_SUB:?DP_SUB 未设置}"

TOKEN="$DP_ID,$DP_KEY"

dns_ok() { printf '%s' "$1" | grep -q '"code":"1"'; }

case "$ACTION" in
  auth)
    [ -n "${CERTBOT_VALIDATION:-}" ] || { echo "CERTBOT_VALIDATION 为空" >&2; exit 1; }
    echo "  [dns] 添加 TXT ${DP_SUB}.${DP_DOMAIN} …" >&2
    RESP=$(curl -s -m 20 -X POST "$API/Record.Create" \
      --data-urlencode "login_token=$TOKEN" \
      --data-urlencode "format=json" \
      --data-urlencode "domain=$DP_DOMAIN" \
      --data-urlencode "sub_domain=$DP_SUB" \
      --data-urlencode "record_type=TXT" \
      --data-urlencode "record_line=默认" \
      --data-urlencode "value=$CERTBOT_VALIDATION" \
      --data-urlencode "ttl=600")

    if dns_ok "$RESP"; then
      echo "  [dns] ✅ 已添加" >&2
    elif printf '%s' "$RESP" | grep -q '记录已经存在\|Record already exists'; then
      echo "  [dns] 记录已存在，先删旧的再重试" >&2
      bash "$0" cleanup >/dev/null 2>&1 || true
      RESP=$(curl -s -m 20 -X POST "$API/Record.Create" \
        --data-urlencode "login_token=$TOKEN" --data-urlencode "format=json" \
        --data-urlencode "domain=$DP_DOMAIN" --data-urlencode "sub_domain=$DP_SUB" \
        --data-urlencode "record_type=TXT" --data-urlencode "record_line=默认" \
        --data-urlencode "value=$CERTBOT_VALIDATION" --data-urlencode "ttl=600")
      dns_ok "$RESP" || { echo "  [dns] ❌ 重试仍失败: $RESP" >&2; exit 1; }
      echo "  [dns] ✅ 已添加（替换旧的）" >&2
    else
      echo "  [dns] ❌ 添加失败: $RESP" >&2
      exit 1
    fi

    # DNSPod 的默认 TTL 是 600s，生效可能滞后。轮询等它真的可以被查到，
    # 否则 certbot 立刻去校验会拿到 NXDOMAIN / 旧值。
    echo "  [dns] 等待解析生效（最长 300s）…" >&2
    for i in $(seq 1 60); do
      FOUND=$(dig +short TXT "${DP_SUB}.${DP_DOMAIN}" @8.8.8.8 2>/dev/null \
        | tr -d '"' | grep -F "$CERTBOT_VALIDATION" || true)
      if [ -n "$FOUND" ]; then
        echo "  [dns] ✅ 解析已生效（第 ${i} 次探测）" >&2
        exit 0
      fi
      sleep 5
    done
    echo "  [dns] ⚠️  300s 内未在 8.8.8.8 查到该 TXT，仍交给 certbot 试一次" >&2
    exit 0
    ;;

  cleanup)
    echo "  [dns] 清理 ${DP_SUB}.${DP_DOMAIN} 的 TXT …" >&2
    LIST=$(curl -s -m 20 -X POST "$API/Record.List" \
      --data-urlencode "login_token=$TOKEN" \
      --data-urlencode "format=json" \
      --data-urlencode "domain=$DP_DOMAIN" \
      --data-urlencode "sub_domain=$DP_SUB" \
      --data-urlencode "record_type=TXT")
    # 只删值等于本次校验串的那条，绝不动别的记录
    IDS=$(printf '%s' "$LIST" | tr '{' '\n' \
      | grep -F "${CERTBOT_VALIDATION:-__none__}" \
      | grep -oE '"id":"[0-9]+"' | grep -oE '[0-9]+' || true)
    if [ -z "$IDS" ]; then
      echo "  [dns] 没有需要清理的记录" >&2
      exit 0
    fi
    for id in $IDS; do
      curl -s -m 20 -X POST "$API/Record.Remove" \
        --data-urlencode "login_token=$TOKEN" \
        --data-urlencode "format=json" \
        --data-urlencode "domain=$DP_DOMAIN" \
        --data-urlencode "record_id=$id" >/dev/null
      echo "  [dns] ✅ 已删除 record_id=$id" >&2
    done
    exit 0
    ;;

  *)
    echo "未知动作: $ACTION（只支持 auth / cleanup）" >&2
    exit 1
    ;;
esac
