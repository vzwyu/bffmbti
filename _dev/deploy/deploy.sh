#!/usr/bin/env bash
# ==========================================================================
# MBTI 小游戏 —— 一键部署（自包含，幂等）
#   用法：bash deploy.sh <载荷路径> [部署编号]
#
# 原则：
#   1. 幂等，重复执行结果一致
#   2. 改 nginx 前必备份；nginx -t 失败立即回滚
#   3. 不触碰同站点已有的 /fsl/ /wiki/ /ollama/
#   4. 数据库在 webroot 之外，权限 600，属主 www-data
# ==========================================================================
set -euo pipefail

PAYLOAD="${1:?需要载荷文件路径}"
REV="${2:-$(date +%Y%m%d%H%M%S)}"

APP_DIR=/opt/mbti-game
WEB_DIR=/var/www/oictech/games/mbti
DATA_DIR=/var/lib/mbti-game
UNIT=/etc/systemd/system/mbti-game.service
NGINX_SITE=/etc/nginx/sites-enabled/oictech
# ⚠️ 备份目录必须在 sites-enabled/ 之外。
# nginx.conf 里有 include /etc/nginx/sites-enabled/*; ，
# 把 .bak 放在该目录内会被当成正式站点配置一起加载：
#   1) 每个副本都重复声明同一个 server_name → 每次 reload 刷一屏
#      "conflicting server name ... ignored" 告警
#   2) 谁生效取决于 glob 字典序，是运气不是设计。一旦 oictech 被改名/误删，
#      nginx 会静默回落到某个陈旧副本，整站配置倒退且无任何报错。
NGINX_BACKUP_DIR=/etc/nginx/sites-backups
NGINX_BACKUP_KEEP=10
FRAG=/tmp/nginx-frag.conf

echo "═══════ 部署开始 rev=$REV ═══════"

# ---------- 0. 前置检查 ----------
sudo -n true 2>/dev/null || { echo "❌ 需要免密 sudo"; exit 1; }
node -v >/dev/null || { echo "❌ 未找到 node"; exit 1; }
NM=$(node -p 'process.versions.node.split(".")[0]+"."+process.versions.node.split(".")[1]')
node -e "
  const [a,b]=process.versions.node.split('.').map(Number);
  process.exit(a>22 || (a===22 && b>=5) ? 0 : 1);
" || { echo "❌ node:sqlite 需要 Node >= 22.5（当前 $(node -v)）"; exit 1; }
node -e "require('node:sqlite')" 2>/dev/null || { echo "❌ node:sqlite 不可用"; exit 1; }
echo "  ✅ node $(node -v)，node:sqlite 可用"

# ---------- 1. 解包 ----------
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
if [[ "$PAYLOAD" == *.br ]]; then
  node -e "
    const fs=require('fs'),z=require('zlib');
    fs.writeFileSync(process.argv[2], z.brotliDecompressSync(fs.readFileSync(process.argv[1])));
  " "$PAYLOAD" "$WORK/payload.json"
else
  cp "$PAYLOAD" "$WORK/payload.json"
fi
node -e "
  const fs=require('fs'),path=require('path');
  const arr=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
  const root=process.argv[2];
  let n=0, bin=0;
  for(const it of arr){
    const dst=path.join(root, it.f);
    fs.mkdirSync(path.dirname(dst),{recursive:true});
    // b64 字段表示二进制资源（图片等），必须按字节写回
    if(it.b64!==undefined){ fs.writeFileSync(dst, Buffer.from(it.b64,'base64')); bin++; }
    else { fs.writeFileSync(dst, it.body); }
    n++;
  }
  console.log('  解出 '+n+' 个文件（其中二进制 '+bin+' 个）');
" "$WORK/payload.json" "$WORK/tree"

# ---------- 2. 分发代码 ----------
echo "  后端 → $APP_DIR"
sudo mkdir -p "$APP_DIR/shared"
sudo rm -rf "$APP_DIR/server"
sudo cp -r "$WORK/tree/server" "$APP_DIR/server"
# 后端的 routes/*.js 通过 ../../../shared/mbti-types.js 引用
sudo cp "$WORK/tree/shared/mbti-types.js" "$APP_DIR/shared/mbti-types.js"
sudo chown -R root:root "$APP_DIR"
sudo find "$APP_DIR" -type d -exec chmod 755 {} \;
sudo find "$APP_DIR" -type f -exec chmod 644 {} \;
# 部署编号留痕，便于线上直接核对跑的是哪一版
echo "$REV" | sudo tee "$APP_DIR/.rev" > /dev/null

echo "  前端 → $WEB_DIR"
sudo mkdir -p "$WEB_DIR"
sudo find "$WEB_DIR" -mindepth 1 -delete
sudo cp -r "$WORK/tree/web/." "$WEB_DIR/"
sudo chown -R www-data:www-data "$WEB_DIR"
sudo find "$WEB_DIR" -type d -exec chmod 755 {} \;
sudo find "$WEB_DIR" -type f -exec chmod 644 {} \;

# ---------- 3. 数据目录 ----------
sudo mkdir -p "$DATA_DIR/backups"
sudo chown -R www-data:www-data "$DATA_DIR"
sudo chmod 700 "$DATA_DIR" "$DATA_DIR/backups"
echo "  数据目录 $DATA_DIR 就绪"

# ---------- 3b. 独立测试环境（生产/测试彻底分离）----------
# 目的：自动化测试只碰测试库，永远不写生产库，从根上杜绝误删真实用户。
# 测试服务只监听 127.0.0.1:3001，不经 nginx 对外暴露，测试脚本在服务器上直连。
TEST_DATA_DIR=/var/lib/mbti-game-test
echo "  测试数据目录 $TEST_DATA_DIR"
sudo mkdir -p "$TEST_DATA_DIR/backups"
sudo chown -R www-data:www-data "$TEST_DATA_DIR"
sudo chmod 700 "$TEST_DATA_DIR" "$TEST_DATA_DIR/backups"

sudo tee /etc/systemd/system/mbti-game-test.service > /dev/null <<'TESTUNITEOF'
[Unit]
Description=MBTI Game API (测试环境，仅本机可访问)
After=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/mbti-game/server
ExecStart=/usr/bin/node /opt/mbti-game/server/src/index.js

Restart=always
RestartSec=3

Environment=NODE_ENV=test
Environment=MBTI_PORT=3001
Environment=MBTI_HOST=127.0.0.1
# 与生产用**同一个** URL 前缀。
# 环境区分靠「端口 + 数据目录」，不靠路径：
# 一旦路径也不同，前端测试（固定打 /games/mbti/api）和 e2e（打测试前缀）
# 就会各说各话，测试假失败、真问题被淹没。
Environment=MBTI_BASE_PATH=/games/mbti/api
Environment=MBTI_DATA_DIR=/var/lib/mbti-game-test
Environment=MBTI_DB_PATH=/var/lib/mbti-game-test/mbti.sqlite
Environment=MBTI_BACKUP_DIR=/var/lib/mbti-game-test/backups
Environment=MBTI_BACKUP_KEEP=5
Environment=MBTI_BACKUP_INTERVAL_MS=0
Environment=MBTI_SECURE_COOKIE=false

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/mbti-game-test
MemoryMax=256M

StandardOutput=journal
StandardError=journal
SyslogIdentifier=mbti-game-test

[Install]
WantedBy=multi-user.target
TESTUNITEOF
echo "  测试服务单元已写入（127.0.0.1:3001，不经 nginx 暴露）"

# 便捷命令 mbticli
sudo tee /usr/local/bin/mbticli > /dev/null <<'CLIEOF'
#!/bin/sh
# MBTI 游戏数据库运维工具（生产/测试分离）
exec sudo -u www-data /usr/bin/node /opt/mbti-game/server/bin/mbticli.js "$@"
CLIEOF
sudo chmod 755 /usr/local/bin/mbticli
echo "  已安装 mbticli 命令"

# ---------- 4. systemd ----------
sudo tee "$UNIT" > /dev/null <<'UNITEOF'
[Unit]
Description=MBTI Game API (在朋友眼中，你的MBTI是什么？)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/mbti-game/server
ExecStart=/usr/bin/node /opt/mbti-game/server/src/index.js

Restart=always
RestartSec=3
StartLimitIntervalSec=60
StartLimitBurst=5

Environment=NODE_ENV=production
Environment=MBTI_PORT=3000
Environment=MBTI_HOST=127.0.0.1
Environment=MBTI_BASE_PATH=/games/mbti/api
Environment=MBTI_DATA_DIR=/var/lib/mbti-game
Environment=MBTI_DB_PATH=/var/lib/mbti-game/mbti.sqlite
Environment=MBTI_BACKUP_DIR=/var/lib/mbti-game/backups
Environment=MBTI_BACKUP_KEEP=30
Environment=MBTI_SECURE_COOKIE=true

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=/var/lib/mbti-game

MemoryMax=768M
LimitNOFILE=65535

StandardOutput=journal
StandardError=journal
SyslogIdentifier=mbti-game

[Install]
WantedBy=multi-user.target
UNITEOF
echo "  systemd 单元已写入"

# ---------- 5. nginx ----------
cat > "$FRAG" <<'FRAGEOF'
    # ===== MODE_LOCATION_MBTI_GAME =====
    # 接口反代：^~ 抢占前缀，避免被正则 location 抢走。
    # proxy_pass 不带结尾斜杠 —— 保留完整 URI，由应用按 MBTI_BASE_PATH 剥离。
    location ^~ /games/mbti/api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";
        proxy_connect_timeout 5s;
        proxy_send_timeout    30s;
        proxy_read_timeout    30s;
        client_max_body_size  128k;
        add_header Cache-Control "no-store" always;
    }

    location = /games/mbti {
        return 301 /games/mbti/;
    }

    # 静态资源 + SPA 回退（不加 ^~，好让下面的图片正则生效）
    location /games/mbti/ {
        root /var/www/oictech;
        index index.html;
        try_files $uri $uri/ /games/mbti/index.html;
        add_header Cache-Control "no-cache" always;
    }

    # ── 资源目录严禁 SPA 回退 ──
    # 若缺文件也回退成 index.html，浏览器会拿到 text/html 的「JS」，
    # 拒绝执行且不报明显错误，表现为整站白屏、只显示「页面未能正确加载」。
    # 这里强制 404，让缺失立刻暴露。
    location ^~ /games/mbti/js/ {
        root /var/www/oictech;
        try_files $uri =404;
        add_header Cache-Control "no-cache" always;
    }

    location ^~ /games/mbti/css/ {
        root /var/www/oictech;
        try_files $uri =404;
        add_header Cache-Control "no-cache" always;
    }

    location ^~ /games/mbti/assets/ {
        root /var/www/oictech;
        try_files $uri =404;
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
        access_log off;
    }

    location ~* ^/games/mbti/.+\.(png|jpe?g|gif|svg|webp|ico|woff2?)$ {
        root /var/www/oictech;
        try_files $uri =404;
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
        access_log off;
    }
    # ===== /MODE_LOCATION_MBTI_GAME =====
FRAGEOF

# 片段内容随版本演进，因此每次部署都替换旧块（而不是"存在就跳过"）

# --- 备份基础设施（目录必须在 sites-enabled 之外，见文件头说明）---
sudo mkdir -p "$NGINX_BACKUP_DIR"
sudo chmod 700 "$NGINX_BACKUP_DIR"

# 幂等清理：把早期版本误留在 sites-enabled/ 内的备份扫出去
STRAY=$(sudo bash -c "ls -1 ${NGINX_SITE}.bak.* 2>/dev/null || true")
if [ -n "$STRAY" ]; then
  echo "  ⚠️  清理 sites-enabled 内的历史备份（会被 nginx 误加载）"
  for f in $STRAY; do
    sudo mv "$f" "$NGINX_BACKUP_DIR/$(basename "$f")"
    echo "     迁出 $(basename "$f")"
  done
fi

# 改动前快照
sudo cp "$NGINX_SITE" "$NGINX_BACKUP_DIR/oictech.bak.${REV}"
# 只保留最近 N 份
sudo bash -c "ls -1t ${NGINX_BACKUP_DIR}/oictech.bak.* 2>/dev/null \
  | tail -n +$((NGINX_BACKUP_KEEP + 1)) | xargs -r rm -f"

if grep -q 'MODE_LOCATION_MBTI_GAME' "$NGINX_SITE"; then
  sudo python3 - "$NGINX_SITE" "$FRAG" <<'PYEOF'
import sys, re
p, fp = sys.argv[1], sys.argv[2]
src = open(p, encoding='utf-8').read()
frag = open(fp, encoding='utf-8').read()
# 删掉旧的整块（从起始标记所在行到结束标记所在行）
pat = re.compile(r'[ \t]*# ===== MODE_LOCATION_MBTI_GAME =====.*?# ===== /MODE_LOCATION_MBTI_GAME =====',
                 re.S)
if pat.search(src):
    src = pat.sub('', src)
    print('  已移除旧片段')
# 插到 root 指令之后
anchor = 'root /var/www/oictech;'
i = src.find(anchor)
if i < 0:
    print('  ❌ 未找到 anchor，中止'); sys.exit(1)
j = i + len(anchor)
open(p, 'w', encoding='utf-8').write(src[:j] + '\n\n' + frag + src[j:])
print('  ✅ 片段已更新')
PYEOF
else
  sudo python3 - "$NGINX_SITE" "$FRAG" <<'PYEOF'
import sys
p, fp = sys.argv[1], sys.argv[2]
src = open(p, encoding='utf-8').read()
frag = open(fp, encoding='utf-8').read()
anchor = 'root /var/www/oictech;'
i = src.find(anchor)
if i < 0:
    print('  ❌ 未找到 anchor，中止'); sys.exit(1)
j = i + len(anchor)
open(p, 'w', encoding='utf-8').write(src[:j] + '\n\n' + frag + src[j:])
print('  ✅ 片段已注入')
PYEOF
fi

if ! sudo nginx -t; then
  echo "  ❌ nginx -t 失败，回滚"
  LATEST=$(sudo bash -c "ls -t ${NGINX_BACKUP_DIR}/oictech.bak.* 2>/dev/null | head -1" || true)
  if [ -n "$LATEST" ]; then sudo cp "$LATEST" "$NGINX_SITE"; sudo nginx -t && echo "  ✅ 已回滚（来自 $LATEST）"; fi
  exit 1
fi
echo "  ✅ nginx 配置校验通过"

# 冲突告警必须为 0 —— 非 0 说明 sites-enabled/ 里又混进了重复 server_name 的文件
CONFLICT=$(sudo nginx -t 2>&1 | grep -c 'conflicting server name' || true)
if [ "$CONFLICT" -ne 0 ]; then
  echo "  ⚠️  仍有 $CONFLICT 条 server_name 冲突告警，请检查 /etc/nginx/sites-enabled/"
fi

# ---------- 6. 启动 ----------
sudo systemctl daemon-reload
sudo systemctl enable mbti-game mbti-game-test >/dev/null 2>&1 || true
sudo systemctl restart mbti-game
sudo systemctl restart mbti-game-test
sleep 3
sudo systemctl reload nginx

# ---------- 7. 自检 ----------
echo "═══════ 自检 ═══════"
echo "  部署编号 rev=$REV"
sudo systemctl is-active --quiet mbti-game || {
  echo "  ❌ 生产服务未运行，日志："
  sudo journalctl -u mbti-game -n 30 --no-pager
  exit 1
}
echo "  ✅ 生产服务运行中"
sudo systemctl is-active --quiet mbti-game-test \
  && echo "  ✅ 测试服务运行中（127.0.0.1:3001）" \
  || echo "  ⚠️  测试服务未运行（不影响线上）"

echo -n "  后端直连 3000     : "; curl -s -m 5 http://127.0.0.1:3000/games/mbti/api/health || echo "无响应"; echo
echo -n "  经 nginx 的 API   : "; curl -s -m 8 https://www.oictech.cn/games/mbti/api/health || echo "无响应"; echo
echo -n "  测试环境直连 3001 : "; curl -s -m 5 http://127.0.0.1:3001/games/mbti/api/health || echo "无响应"; echo
echo -n "  测试库用户数      : "
sudo -u www-data node -e "
  const {DatabaseSync}=require('node:sqlite');
  const p='/var/lib/mbti-game-test/mbti.sqlite';
  if(!require('fs').existsSync(p)){console.log('(尚未创建)');process.exit(0);}
  const db=new DatabaseSync(p);
  console.log(db.prepare('SELECT COUNT(*) c FROM users').get().c);
  db.close();
" 2>/dev/null | tail -1
echo -n "  生产库用户数      : "
sudo -u www-data node -e "
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync('/var/lib/mbti-game/mbti.sqlite');
  console.log(db.prepare('SELECT COUNT(*) c FROM users').get().c);
  db.close();
" 2>/dev/null | tail -1
echo -n "  前端首页          : "; curl -s -m 8 -o /dev/null -w "%{http_code}\n" https://www.oictech.cn/games/mbti/
echo -n "  静态 JS           : "; curl -s -m 8 -o /dev/null -w "%{http_code}\n" https://www.oictech.cn/games/mbti/js/app.js
echo -n "  SPA 深链接        : "; curl -s -m 8 -o /dev/null -w "%{http_code}\n" https://www.oictech.cn/games/mbti/me
echo "  ── 回归检查：原有服务必须不受影响 ──"
for p in "/" "/wiki/" "/fsl/" "/ai-usage.html"; do
  echo -n "    $p : "; curl -s -m 8 -o /dev/null -w "%{http_code}\n" "https://www.oictech.cn${p}"
done
echo "  ── nginx 卫生 ──"
echo -n "    server_name 冲突告警 : "; sudo nginx -t 2>&1 | grep -c 'conflicting server name' || true
echo -n "    sites-enabled 文件数 : "; sudo bash -c 'ls -1 /etc/nginx/sites-enabled/ | wc -l'
echo -n "    目录外备份份数       : "; sudo bash -c 'ls -1 /etc/nginx/sites-backups/ 2>/dev/null | wc -l'

echo "═══════ 部署完成 rev=$REV ═══════"
