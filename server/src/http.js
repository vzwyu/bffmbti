'use strict';
/**
 * 极简 HTTP 层 —— 只用 node:http，零框架依赖。
 *
 * 职责：路由匹配、JSON 请求体解析（带体积上限）、Cookie 读写、
 *       安全响应头、客户端 IP 提取、统一错误输出。
 *
 * 安全要点：
 *   - 请求体硬上限，超限直接断开，避免内存打爆
 *   - 只接受 application/json，其余 415
 *   - 写操作校验 Origin（配合 SameSite=Lax 双重防 CSRF）
 *   - 响应一律带 nosniff / 禁止 iframe / 不泄漏 Referer
 */

const MAX_BODY_BYTES = 64 * 1024;          // 单请求体上限 64KB
const ALLOWED_ORIGIN_SUFFIX = ['.oictech.cn', 'oictech.cn'];

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 提取真实客户端 IP；仅信任本机 nginx 传来的转发头 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const first = xff.split(',')[0].trim();
    if (first) return first.slice(0, 45);
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.slice(0, 45);
  return String(req.socket.remoteAddress || '').slice(0, 45);
}

/** 解析 Cookie 头为普通对象 */
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
    }
  });
  return out;
}

/** 写 Set-Cookie。默认 SameSite=Lax + HttpOnly；secure 由调用方按环境决定。 */
function buildCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return parts.join('; ');
}

/** 读取并解析 JSON 请求体；超限或非法一律 reject */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const ctype = String(req.headers['content-type'] || '');
    if (!ctype.includes('application/json')) {
      const e = new Error('仅支持 application/json');
      e.status = 415;
      e.code = 'unsupported_media_type';
      return reject(e);
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const e = new Error('请求体过大');
        e.status = 413;
        e.code = 'payload_too_large';
        req.destroy();
        return reject(e);
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const e = new Error('请求体必须是 JSON 对象');
          e.status = 400;
          e.code = 'bad_json';
          return reject(e);
        }
        resolve(parsed);
      } catch (_) {
        const e = new Error('JSON 解析失败');
        e.status = 400;
        e.code = 'bad_json';
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 统一错误输出。对外只给 code + 安全的中文文案，绝不透传内部堆栈。 */
function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

class Router {
  /**
   * @param {string} basePath 应用挂载前缀（会被剥掉），如 /games/mbti/api
   */
  constructor(basePath = '') {
    this.basePath = basePath.replace(/\/+$/, '');
    this.routes = [];
  }

  /**
   * 注册路由。
   * @param {string} method HTTP 方法
   * @param {string} pattern 形如 /u/:token/vote
   * @param {Function} handler async (ctx) => void
   */
  add(method, pattern, handler) {
    const keys = [];
    const regexSrc = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method: method.toUpperCase(),
      regex: new RegExp('^' + regexSrc + '/?$'),
      keys,
      handler
    });
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method.toUpperCase()) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); }
        catch (_) { params[k] = m[i + 1]; }
      });
      return { route: r, params };
    }
    return null;
  }
}

/**
 * 创建 http server 的请求处理器。
 * @param {Router} router
 * @param {object} deps 注入给 handler 的依赖（db、限流器等）
 * @param {Function} [onError] 错误钩子，便于记录日志
 */
function createHandler(router, deps, onError) {
  return function handler(req, res) {
    applySecurityHeaders(res);

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      return sendError(res, 400, 'bad_url', '请求格式错误');
    }

    // 剥离挂载前缀
    if (router.basePath && pathname.startsWith(router.basePath)) {
      pathname = pathname.slice(router.basePath.length) || '/';
    }

    const hit = router.match(req.method, pathname);
    if (!hit) {
      return sendError(res, 404, 'not_found', '接口不存在');
    }

    // 写操作做同源校验（与 SameSite=Lax 形成双重防护）
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    if (isWrite) {
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try { host = new URL(origin).hostname; } catch (_) { host = ''; }
        const ok = ALLOWED_ORIGIN_SUFFIX.some(
          (s) => host === s.replace(/^\./, '') || host.endsWith(s)
        );
        if (!ok) {
          return sendError(res, 403, 'bad_origin', '请求来源不被允许');
        }
      }
    }

    const ctx = {
      req,
      res,
      params: hit.params,
      query: Object.fromEntries(new URL(req.url, 'http://localhost').searchParams),
      cookies: parseCookies(req.headers.cookie),
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || '').slice(0, 300),
      deps,
      body: null,
      /** 惰性解析请求体 */
      async json() {
        if (this.body === null) this.body = await readJson(req);
        return this.body;
      }
    };

    Promise.resolve()
      .then(() => hit.route.handler(ctx))
      .catch((err) => {
        if (onError) onError(err, ctx);
        if (res.headersSent) return;
        const status = err && err.status ? err.status : 500;
        const code = err && err.code ? err.code : 'internal_error';
        const msg = status === 500 ? '服务器开小差了，请稍后重试' : String(err.message || '请求失败');
        sendError(res, status, code, msg);
      });
  };
}

module.exports = {
  Router,
  createHandler,
  sendJson,
  sendError,
  readJson,
  clientIp,
  parseCookies,
  buildCookie,
  applySecurityHeaders,
  MAX_BODY_BYTES
};
