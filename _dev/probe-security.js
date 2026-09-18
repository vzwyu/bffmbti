'use strict';

/**
 * src/security.js
 * MBTI 社交小游戏后端账号安全基础设施
 * 仅使用 Node 内置模块，CommonJS
 */

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// 密码哈希（scrypt，自描述格式，便于日后调参）
// ---------------------------------------------------------------------------

const SCRYPT_DEFAULTS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 16,
});

// 防御性上限：stored 字符串也当作不可信输入，防止畸形参数造成 CPU/内存 DoS
const SCRYPT_MAX_N = 1 << 20; // 1048576
const SCRYPT_MAX_R = 32;
const SCRYPT_MAX_P = 16;
const SCRYPT_MAX_KEYLEN = 128;

/**
 * 使用 scrypt 派生密码哈希
 * @param {string} password 明文密码
 * @param {{N?:number,r?:number,p?:number,keylen?:number,saltBytes?:number}} [opts]
 * @returns {string} 形如 scrypt$N$r$p$salt_b64$hash_b64
 */
function hashPassword(password, opts) {
  if (typeof password !== 'string') {
    throw new TypeError('password 必须是字符串');
  }
  const o = Object.assign({}, SCRYPT_DEFAULTS, opts || {});
  const salt = crypto.randomBytes(o.saltBytes);
  const derived = crypto.scryptSync(password, salt, o.keylen, {
    N: o.N,
    r: o.r,
    p: o.p,
  });
  return [
    'scrypt',
    String(o.N),
    String(o.r),
    String(o.p),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * 校验密码。任何解析失败/格式非法一律返回 false，绝不抛异常
 * @param {string} password 待校验明文
 * @param {string} stored hashPassword 产出的自描述字符串
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') {
      return false;
    }
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return false;
    }
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    // 必须是正整数且在安全上限内；N 必须为 2 的幂（scrypt 要求）
    if (
      !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) ||
      N < 2 || N > SCRYPT_MAX_N || (N & (N - 1)) !== 0 ||
      r < 1 || r > SCRYPT_MAX_R ||
      p < 1 || p > SCRYPT_MAX_P
    ) {
      return false;
    }
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (salt.length === 0 || expected.length === 0 || expected.length > SCRYPT_MAX_KEYLEN) {
      return false;
    }
    const derived = crypto.scryptSync(password, salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(derived, expected);
  } catch (_) {
    // 优雅降级：校验失败视为不匹配
    return false;
  }
}

// ---------------------------------------------------------------------------
// 内存限流器（登录防爆破：按账号 / 按 IP 各建一个实例即可）
// ---------------------------------------------------------------------------

/**
 * 创建内存版限流器。按账号、按 IP 两个维度各创建一个实例：
 *   const byAccount = createRateLimiter({...});
 *   const byIp = createRateLimiter({...});
 * @param {{maxFailures:number, windowMs:number, lockMs:number, maxEntries?:number}} options
 */
function createRateLimiter(options) {
  const opts = options || {};
  const maxFailures = Number.isInteger(opts.maxFailures) && opts.maxFailures > 0 ? opts.maxFailures : 5;
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : 15 * 60 * 1000;
  const lockMs = Number.isFinite(opts.lockMs) && opts.lockMs > 0 ? opts.lockMs : 15 * 60 * 1000;
  // 容量上限，防止内存无限增长
  const maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : 10000;

  /** @type {Map<string, {fails:number, windowStart:number, lockedUntil:number}>} */
  const store = new Map();

  /**
   * 取条目并做惰性过期处理：窗口已过且未锁定则视为新条目
   */
  function getEntry(key, now) {
    const e = store.get(key);
    if (!e) return null;
    const locked = e.lockedUntil > now;
    if (!locked && now - e.windowStart >= windowMs) {
      store.delete(key);
      return null;
    }
    // 刷新插入顺序，让淘汰策略淘汰真正的"最旧"条目
    store.delete(key);
    store.set(key, e);
    return e;
  }

  /**
   * 写入前保证容量：超出上限时淘汰 Map 中最旧的条目
   */
  function ensureCapacity() {
    while (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  }

  /**
   * 检查是否允许尝试（不记录失败）
   * @param {string} key
   * @returns {{allowed:boolean, retryAfterSec:number, remaining:number}}
   */
  function check(key) {
    const now = Date.now();
    const e = getEntry(String(key), now);
    if (!e) {
      return { allowed: true, retryAfterSec: 0, remaining: maxFailures };
    }
    if (e.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000),
        remaining: 0,
      };
    }
    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: Math.max(0, maxFailures - e.fails),
    };
  }

  /**
   * 记录一次失败；达到 maxFailures 进入锁定态
   * @param {string} key
   * @returns {{allowed:boolean, retryAfterSec:number, remaining:number}} 记录后的状态
   */
  function fail(key) {
    const now = Date.now();
    const k = String(key);
    let e = getEntry(k, now);
    if (!e) {
      ensureCapacity();
      e = { fails: 0, windowStart: now, lockedUntil: 0 };
      store.set(k, e);
    }
    // 已锁定：刷新剩余锁定时间提示，不重复延长
    if (e.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000),
        remaining: 0,
      };
    }
    e.fails += 1;
    if (e.fails >= maxFailures) {
      e.lockedUntil = now + lockMs;
      return {
        allowed: false,
        retryAfterSec: Math.ceil(lockMs / 1000),
        remaining: 0,
      };
    }
    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: maxFailures - e.fails,
    };
  }

  /**
   * 成功后清零计数
   * @param {string} key
   */
  function succeed(key) {
    store.delete(String(key));
  }

  /**
   * 手动清理：移除窗口已过且未锁定的条目（惰性清扫之外的兜底）
   * @returns {number} 清理掉的条目数
   */
  function sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [k, e] of store) {
      const locked = e.lockedUntil > now;
      if (!locked && now - e.windowStart >= windowMs) {
        store.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  return { check, fail, succeed, sweep };
}

// ---------------------------------------------------------------------------
// 随机 token / 找回码 / 定时安全比较
// ---------------------------------------------------------------------------

/**
 * 生成 URL-safe 随机字符串（base64url，天然无 '=' 填充）
 * 用于 session token 与分享链接标识
 * @param {number} [bytes=32] 随机字节数
 * @returns {string}
 */
function makeToken(bytes) {
  const n = Number.isInteger(bytes) && bytes > 0 ? bytes : 32;
  return crypto.randomBytes(n).toString('base64url');
}

// 易抄写字符集：排除 0 O 1 l I 等易混淆字符
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * 生成人类易抄写的找回码，形如 XXXX-XXXX-XXXX
 * @returns {string}
 */
function makeRecoveryCode() {
  const len = RECOVERY_ALPHABET.length;
  // 拒绝采样，消除取模偏差
  const limit = Math.floor(256 / len) * len;
  const chars = [];
  while (chars.length < 12) {
    const buf = crypto.randomBytes(12);
    for (let i = 0; i < buf.length && chars.length < 12; i += 1) {
      if (buf[i] < limit) {
        chars.push(RECOVERY_ALPHABET[buf[i] % len]);
      }
    }
  }
  return [
    chars.slice(0, 4).join(''),
    chars.slice(4, 8).join(''),
    chars.slice(8, 12).join(''),
  ].join('-');
}

/**
 * 字符串定时安全比较；长度不等直接返回 false
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createRateLimiter,
  makeToken,
  makeRecoveryCode,
  constantTimeEqual,
};