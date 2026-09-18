'use strict';
/**
 * 运行配置 —— 全部来自环境变量，给出适合单机小站的保守默认值。
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

const config = {
  /** 监听端口。反代由 nginx 负责，这里只绑本机。 */
  port: intEnv('MBTI_PORT', 3000),
  host: process.env.MBTI_HOST || '127.0.0.1',

  /** 应用挂载前缀。nginx 不剥前缀，由应用自行剥离。 */
  basePath: process.env.MBTI_BASE_PATH != null ? process.env.MBTI_BASE_PATH : '/games/mbti/api',

  /** 数据目录：必须位于 webroot 之外 */
  dataDir: process.env.MBTI_DATA_DIR || path.join(ROOT, 'data'),
  dbPath: process.env.MBTI_DB_PATH || path.join(ROOT, 'data', 'mbti.sqlite'),
  backupDir: process.env.MBTI_BACKUP_DIR || path.join(ROOT, 'data', 'backups'),
  backupKeep: intEnv('MBTI_BACKUP_KEEP', 30),
  /** 备份间隔，默认 6 小时 */
  backupIntervalMs: intEnv('MBTI_BACKUP_INTERVAL_MS', 6 * 60 * 60 * 1000),

  /** 会话有效期，默认 30 天 */
  sessionTtlMs: intEnv('MBTI_SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000),

  /** HTTPS 环境下必须为 true */
  secureCookie: process.env.MBTI_SECURE_COOKIE !== 'false',

  /** 称呼长度上限（按显示宽度计：中文/emoji 记 2） */
  nicknameMaxWidth: intEnv('MBTI_NICKNAME_MAX_WIDTH', 64),

  /** 单个用户可收到的评价上限，防止刷票灌库 */
  maxVotesPerTarget: intEnv('MBTI_MAX_VOTES_PER_TARGET', 5000),

  limits: {
    /** 登录：同一账号连续失败 5 次锁 15 分钟 */
    loginByAccount: { maxFailures: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000, maxEntries: 20000 },
    /** 登录：同一 IP 每小时最多 20 次失败 */
    loginByIp: { maxFailures: 20, windowMs: 60 * 60 * 1000, lockMs: 30 * 60 * 1000, maxEntries: 20000 },
    /** 注册：同一 IP 每小时最多 10 次 */
    registerByIp: { maxFailures: 10, windowMs: 60 * 60 * 1000, lockMs: 60 * 60 * 1000, maxEntries: 20000 },
    /** 投票：同一 IP 每小时最多 60 次 */
    voteByIp: { maxFailures: 60, windowMs: 60 * 60 * 1000, lockMs: 10 * 60 * 1000, maxEntries: 20000 },
    /** 公开接口读：同一 IP 每分钟最多 120 次 */
    readByIp: { maxFailures: 120, windowMs: 60 * 1000, lockMs: 60 * 1000, maxEntries: 20000 }
  }
};

module.exports = config;
