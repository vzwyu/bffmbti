#!/usr/bin/env bash
# ==========================================================================
# 短域名 bffmbti.oictech.cn → 游戏页   （幂等，可重复执行）
#
#   用法：bash subdomain.sh
#
# 设计取舍（为什么用重定向而不是"重写一套逻辑"）：
#   前端所有资源路径都硬编码了 /games/mbti/ 前缀（这是修 SPA 深链接 bug 时必须的）。
#   要让子域在**根路径**直接托管游戏，就得重新构建一套 base path 为 / 的产物：
#   HTML 资源前缀、API 前缀、分享链接、cookie 域全部要跟着变 → 两份产物、双倍维护，
#   收益仅仅是 URL 好看一点。
#   重定向零维护、零风险，且保留原 path/query，连 /s/<token> 都能跟着走：
#       bffmbti.oictech.cn/          → www.oictech.cn/games/mbti/
#       bffmbti.oictech.cn/s/<token> → www.oictech.cn/games/mbti/s/<token>
#
# 用 302 而不是 301：这是便捷入口，不是永久搬家。
#   301 会被浏览器长期缓存，日后想改指向会很难收回。
#
# 配置写到 /etc/nginx/conf.d/bffmbti-game.conf，而不是 sites-enabled/：
#   conf.d 同样是通配加载，但 deploy.sh 只管 sites-enabled/oictech，
#   两者互不干扰，站点的「sites-enabled 只应有 1 个文件」这条卫生约束也不用放宽。
# ==========================================================================
set -uo pipefail

DOMAIN=bffmbti.oictech.cn
TARGET=https://www.oictech.cn/games/mbti
CONF=/etc/nginx/conf.d/bffmbti-game.conf
ACME_ROOT=/var/www/oictech
# ⚠️ 服务器公网 IP 不写死在脚本里 —— 本仓库是 Public，
# 服务器 IP / SSH 用户 / 部署布局这类信息不往公开库里放。
# 需要打印出来时临时传入：SERVER_IP=1.2.3.4 bash subdomain.sh
SERVER_IP="${SERVER_IP:-<本服务器公网IP>}"

say() { printf '  %s\n' "$*"; }
die() { printf '  ❌ %s\n' "$*" >&2; exit 1; }

echo "═══════ 短域名配置：$DOMAIN ═══════"

# ---------------------------------------------------------------- 0. 前置
sudo -n true 2>/dev/null || die "需要免密 sudo"

say "1) 检查 DNS 解析"
RESOLVED=""
for i in 1 2 3 4 5; do
  RESOLVED=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
  [ -n "$RESOLVED" ] && break
  sleep 2
done
if [ -z "$RESOLVED" ]; then
  say "   ⚠️  $DOMAIN 目前无法解析（本地 DNS 缓存或记录尚未生效）"
  say "      请先在腾讯云给 $DOMAIN 加一条 A 记录 → $SERVER_IP"
  say "      本次仍会先把 HTTP 段配置装好，证书申请跳过。"
  HAS_DNS=0
else
  say "   ✅ $DOMAIN → $RESOLVED"
  HAS_DNS=1
fi

# ---------------------------------------------------------------- 1. HTTP 段
say "2) 写入 HTTP(80) 段配置 → $CONF"
sudo mkdir -p "$(dirname "$CONF")"
sudo tee "$CONF" > /dev/null <<EOF
# ===== MODE_SUBDOMAIN_BFFMBTI =====
# 由 _dev/deploy/subdomain.sh 生成，请勿手改（会被下次执行覆盖）
# 短域名走 302 跳到正式路径，保留原 path 与 query，所以 /s/<token> 也能用。
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # Let's Encrypt HTTP-01 校验路径（必须放在重定向之前）
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        default_type "text/plain";
        allow all;
    }

    location / {
        return 302 $TARGET\$request_uri;
    }
}
$( [ "$HAS_DNS" = "1" ] && [ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ] && cat <<EOF2

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        return 302 $TARGET\$request_uri;
    }
}
EOF2
)
# ===== /MODE_SUBDOMAIN_BFFMBTI =====
EOF

sudo nginx -t || { say "   ❌ nginx -t 失败"; sudo rm -f "$CONF"; die "已移除新配置，nginx 回到原状"; }
sudo systemctl reload nginx
say "   ✅ 配置已装载"

# ---------------------------------------------------------------- 2. 证书
# 校验方式的选择不是随意的：
#   bffmbti.oictech.cn 不在腾讯云备案名单里 → **境外访问 80 会被返回
#   "未完成备案"拦截页**（实测 dnspod.qcloud.com/static/webblock.html），
#   而 Let's Encrypt 的校验服务器在境外 → HTTP-01 必然失败。
#   443 不被拦（实测境外可完成 TLS 握手），所以拿到证书后 HTTPS 就通。
#   ⇒ 有 DNSPod 凭据时一律走 DNS-01（不碰 80，可自动续期）。
DNSPOD_ENV=/etc/letsencrypt/dnspod.env
HOOK=/usr/local/bin/mbti-dnspod-hook

if [ "$HAS_DNS" = "1" ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  if [ -f "$DNSPOD_ENV" ]; then
    say "3) 申请证书（certbot，DNS-01 —— 绕开 80 端口的备案拦截）"
    [ -x "$HOOK" ] || die "缺少钩子 $HOOK，请先执行 deploy.sh 或手工安装"
    if sudo certbot certonly --manual --preferred-challenges dns \
         --manual-auth-hook "$HOOK auth" \
         --manual-cleanup-hook "$HOOK cleanup" \
         -d "$DOMAIN" -n --agree-tos --keep-until-expiring 2>&1 | tail -10 | sed 's/^/     /'; then
      :
    fi
  else
    say "3) 申请证书（certbot，HTTP-01）"
    say "   ⚠️  注意：本域名未在腾讯云备案名单内，**境外访问 80 会被拦**，"
    say "      Let's Encrypt 校验在境外 → 大概率失败。若失败，改用 DNS-01："
    say "      1) 到 DNSPod 控制台创建 API Token"
    say "      2) 写入 $DNSPOD_ENV（DP_ID / DP_KEY / DP_DOMAIN=oictech.cn / DP_SUB=_acme-challenge.bffmbti）"
    say "      3) 重跑本脚本"
    if sudo certbot certonly --nginx -d "$DOMAIN" -n --keep-until-expiring 2>&1 | tail -8 | sed 's/^/     /'; then
      :
    fi
  fi

  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    say "   ✅ 证书已签发"
    say "   重新执行以补齐 443 段…"
    exec bash "$0"
  fi
  say "   ⚠️  证书仍未签发，请按上面提示处理后重跑本脚本"
else
  say "3) 证书：$( [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] && echo '已存在，跳过' || echo 'DNS 未就绪，跳过' )"
fi

# ---------------------------------------------------------------- 3. 自检
echo "═══════ 自检 ═══════"
say "conf.d 内容："
sudo ls -1 /etc/nginx/conf.d/ | sed 's/^/     /'
for u in "http://$DOMAIN/" "http://$DOMAIN/s/demo" ; do
  printf '  %-42s ' "$u"
  curl -s -m 8 -o /dev/null -w '%{http_code} → %{redirect_url}\n' "$u" -H "Host: $DOMAIN" \
    || echo "无响应"
done
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  printf '  %-42s ' "https://$DOMAIN/"
  curl -s -m 8 -o /dev/null -w '%{http_code} → %{redirect_url}\n' "https://$DOMAIN/" --resolve "$DOMAIN:443:127.0.0.1" || echo "无响应"
fi
echo "  ── 回归：原有站点必须不受影响 ──"
for p in "/" "/wiki/" "/fsl/" "/games/mbti/"; do
  printf '    %-18s ' "$p"
  curl -s -m 8 -o /dev/null -w '%{http_code}\n' "https://www.oictech.cn$p"
done
say "nginx server_name 冲突告警：$(sudo nginx -t 2>&1 | grep -c 'conflicting server name')"
echo "═══════ 完成 ═══════"
