'use strict';
/**
 * 应用入口 —— 「在朋友眼中，你的MBTI是什么？」后端服务。
 *
 * 零第三方依赖：只用 node:http / node:sqlite / node:crypto。
 * 监听 127.0.0.1，由 nginx 反向代理对外提供 HTTPS。
 */

const http = require('node:http');
const config = require('./config.js');
const { openDatabase, backup } = require('./db.js');
const { createRateLimiter } = require('./security.js');
const { Router, createHandler, sendJson } = require('./http.js');

const auth = require('./routes/auth.js');
const profile = require('./routes/profile.js');
const vote = require('./routes/vote.js');

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const { db, journalMode } = openDatabase(config.dbPath);

const limiters = {
  loginByAccount: createRateLimiter(config.limits.loginByAccount),
  loginByIp: createRateLimiter(config.limits.loginByIp),
  registerByIp: createRateLimiter(config.limits.registerByIp),
  voteByIp: createRateLimiter(config.limits.voteByIp),
  readByIp: createRateLimiter(config.limits.readByIp)
};

const deps = { db, config, limiters };

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

const router = new Router(config.basePath);

// 健康检查：给运维和负载探测用，不暴露任何内部信息
router.add('GET', '/health', (ctx) =>
  sendJson(ctx.res, 200, { ok: true, uptime: Math.floor(process.uptime()) })
);

// 账号
router.add('POST', '/auth/register', auth.register);
router.add('POST', '/auth/login', auth.login);
router.add('POST', '/auth/logout', auth.logout);
router.add('GET', '/auth/me', auth.me);
// 找回功能已按需求关闭：不注册 /auth/recover，访问将返回 404。
// auth.recover 的实现仍然保留在 routes/auth.js 中，日后若要启用，
// 取消下面这行的注释并恢复前端入口即可。
// router.add('POST', '/auth/recover', auth.recover);
router.add('POST', '/auth/password', auth.changePassword);

// 个人资料
router.add('PATCH', '/me', profile.updateProfile);
router.add('POST', '/me/mbti', profile.setMbti);
router.add('GET', '/me/mbti-permission', profile.mbtiPermission);

// 公开访问与评价
router.add('GET', '/u/:token', vote.publicUser);
router.add('POST', '/u/:token/vote', vote.submitVote);
router.add('GET', '/u/:token/summary', vote.getSummary);
router.add('GET', '/u/:token/votes', vote.listVotes);
// 把某条评价标为失效 / 恢复有效（本人操作，软删除）
router.add('PATCH', '/u/:token/votes/:id', vote.setVoteInvalid);
// 我对某个分享链接的主人是否已评价过（访客页防重复评价用）
router.add('GET', '/u/:token/my-vote', vote.getMyVote);
// 我发给别人的评价列表
router.add('GET', '/me/votes-given', vote.listMyVotes);

/* ------------------------------------------------------------------ */
/* 错误日志（内存环形缓冲，避免高频写盘）                               */
/* ------------------------------------------------------------------ */

const errorLog = [];
const ERROR_LOG_MAX = 200;

function logError(err, ctx) {
  errorLog.push({
    at: new Date().toISOString(),
    method: ctx && ctx.req ? ctx.req.method : '-',
    url: ctx && ctx.req ? ctx.req.url : '-',
    ip: ctx ? ctx.ip : '-',
    message: String(err && err.message ? err.message : err),
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : ''
  });
  if (errorLog.length > ERROR_LOG_MAX) errorLog.shift();
  // 仅 5xx 打日志，4xx 属正常业务分支
  const status = err && err.status ? err.status : 500;
  if (status >= 500) {
    console.error('[error]', ctx && ctx.req ? ctx.req.method : '-', ctx && ctx.req ? ctx.req.url : '-',
      String(err && err.message ? err.message : err));
  }
}

const handler = createHandler(router, deps, logError);

const server = http.createServer(handler);

// 慢请求保护：请求体读取卡死时强制断开
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 10000;

server.listen(config.port, config.host, () => {
  console.log(
    'MBTI 服务已启动  http://' + config.host + ':' + config.port + config.basePath +
    '   journal_mode=' + journalMode +
    '   node=' + process.version
  );
});

/* ------------------------------------------------------------------ */
/* 定时备份                                                            */
/* ------------------------------------------------------------------ */

let backupTimer = null;

async function runBackup(reason) {
  try {
    const dest = await backup(db, config.backupDir, config.backupKeep);
    console.log('[backup] ' + reason + ' -> ' + dest);
  } catch (e) {
    console.error('[backup] 失败:', e && e.message);
  }
}

if (config.backupIntervalMs > 0) {
  backupTimer = setInterval(() => runBackup('定时'), config.backupIntervalMs);
  backupTimer.unref();
}

// 限流器惰性清扫，防止长时间运行后内存里的条目堆积
const sweepTimer = setInterval(() => {
  let removed = 0;
  for (const l of Object.values(limiters)) removed += l.sweep();
  if (removed > 0) console.log('[sweep] 清理限流记录 ' + removed + ' 条');
}, 10 * 60 * 1000);
sweepTimer.unref();

/* ------------------------------------------------------------------ */
/* 优雅退出                                                            */
/* ------------------------------------------------------------------ */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[shutdown] 收到 ' + signal + '，开始退出');

  if (backupTimer) clearInterval(backupTimer);
  clearInterval(sweepTimer);

  // 退出前做一次备份，确保 WAL 中的数据落盘可恢复
  await runBackup('退出前');

  server.close(() => {
    try { db.close(); } catch (_) { /* ignore */ }
    console.log('[shutdown] 已完成');
    process.exit(0);
  });

  // 兜底：10 秒内没关干净就强退
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  logError(e, null);
});

module.exports = { server, db, deps, errorLog };
