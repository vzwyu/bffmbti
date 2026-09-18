#!/usr/bin/env bash
# ==========================================================================
# 安装 MBTI 站点分层探针（幂等，可重复执行）
#   bash install-watchdog.sh
# 卸载：systemctl disable --now mbti-watchdog.timer
# ==========================================================================
set -uo pipefail

BIN=/usr/local/bin/mbti-watchdog
UNIT=/etc/systemd/system/mbti-watchdog.service
TIMER=/etc/systemd/system/mbti-watchdog.timer
SRC=/tmp/watchdog.sh

echo "═══════ 安装站点探针 ═══════"

[ -f "$SRC" ] || { echo "  ❌ 缺少 $SRC"; exit 1; }

sudo install -m 755 -o root -g root "$SRC" "$BIN" && echo "  ✅ 探针脚本 → $BIN"

sudo tee "$UNIT" > /dev/null <<'EOF'
[Unit]
Description=MBTI 站点分层探针（每分钟，仅异常时写日志）

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mbti-watchdog
EOF

sudo tee "$TIMER" > /dev/null <<'EOF'
[Unit]
Description=每分钟跑一次 MBTI 站点探针

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=5s
Unit=mbti-watchdog.service

[Install]
WantedBy=timers.target
EOF

# 日志按天切、保留 14 天（只在异常时才有内容，正常时是空文件）
sudo tee /etc/logrotate.d/mbti-watchdog > /dev/null <<'EOF'
/var/log/mbti-watchdog.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
EOF

sudo touch /var/log/mbti-watchdog.log
sudo chown root:adm /var/log/mbti-watchdog.log
sudo chmod 644 /var/log/mbti-watchdog.log

# 状态目录（记录上次是 up 还是 down，用于只在「状态翻转」时打分隔线）
sudo mkdir -p /var/lib/mbti-watchdog
sudo chmod 700 /var/lib/mbti-watchdog

sudo systemctl daemon-reload
sudo systemctl enable --now mbti-watchdog.timer >/dev/null 2>&1
sudo systemctl start mbti-watchdog.service || true

echo "  ✅ systemd timer 已启用"
echo
echo "═══════ 自检 ═══════"
systemctl is-active mbti-watchdog.timer | sed 's/^/  timer 状态: /'
echo -n "  下次触发: "; systemctl list-timers mbti-watchdog.timer --no-pager 2>/dev/null | sed -n 2p | awk '{print $1, $2, $3}'
echo "  立即用 root 跑一次（与服务实际身份一致）："
sudo /usr/local/bin/mbti-watchdog && echo "    退出码 0（无异常）"
if [ -s /var/log/mbti-watchdog.log ]; then
  echo "  日志尾部："
  tail -5 /var/log/mbti-watchdog.log | sed 's/^/    /'
else
  echo "  日志: 空 —— 当前一切正常 ✅"
fi
echo "═══════ 完成 ═══════"
