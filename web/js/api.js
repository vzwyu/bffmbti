'use strict';
/**
 * 后端接口客户端 —— 唯一的网络出口，视图层不得直接调用 fetch。
 *
 * 约定：
 *   - 所有请求 same-origin，带 cookie（会话是 HttpOnly，JS 读不到也不该读）
 *   - 失败统一抛出 ApiError，带 code 与后端给的中文文案
 *   - 网络层失败（断网、超时、5xx）统一转为 SUBMIT_FAILED，
 *     文案固定为"提交失败，请稍后重试"，避免把内部细节暴露给用户
 */

(function (global) {
  var BASE = global.__MBTI_BASE__ || '/games/mbti/api';
  var TIMEOUT_MS = 15000;

  function ApiError(code, message, status) {
    var e = new Error(message || '请求失败');
    e.name = 'ApiError';
    e.code = code || 'unknown';
    e.status = status || 0;
    return e;
  }

  /**
   * @param {string} method
   * @param {string} path   以 / 开头，拼在 BASE 之后
   * @param {object} [body]
   */
  function request(method, path, body) {
    var url = BASE + path;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);

    var opts = {
      method: method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(url, opts)
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

          if (res.ok) return data || { ok: true };

          // 后端有结构化错误就透传它的 code 与中文文案
          if (data && data.code && data.message) {
            throw ApiError(data.code, data.message, res.status);
          }
          // 网关层错误（nginx 502/504 等）没有结构体，按提交失败处理
          throw ApiError('SUBMIT_FAILED', '提交失败，请稍后重试', res.status);
        });
      })
      .catch(function (err) {
        if (err && err.name === 'ApiError') throw err;
        // 断网 / 超时 / CORS：对用户一律是"稍后重试"
        throw ApiError('SUBMIT_FAILED', '提交失败，请稍后重试', 0);
      })
      .finally(function () { clearTimeout(timer); });
  }

  var API = {
    base: BASE,
    ApiError: ApiError,

    get: function (p) { return request('GET', p); },
    post: function (p, b) { return request('POST', p, b === undefined ? {} : b); },
    patch: function (p, b) { return request('PATCH', p, b === undefined ? {} : b); },

    /* ---- 账号 ---- */
    register: function (nickname, account, password) {
      return request('POST', '/auth/register', { nickname: nickname, account: account, password: password });
    },
    login: function (account, password) {
      return request('POST', '/auth/login', { account: account, password: password });
    },
    logout: function () { return request('POST', '/auth/logout', {}); },
    me: function () { return request('GET', '/auth/me'); },
    recover: function (account, recoveryCode, newPassword) {
      return request('POST', '/auth/recover', {
        account: account, recovery_code: recoveryCode, new_password: newPassword
      });
    },
    changePassword: function (oldPassword, newPassword) {
      return request('POST', '/auth/password', {
        old_password: oldPassword, new_password: newPassword
      });
    },

    /* ---- 个人资料 ---- */
    updateProfile: function (patch) { return request('PATCH', '/me', patch); },
    setMbti: function (mbti, password) {
      var body = { mbti: mbti };
      if (password) body.password = password;
      return request('POST', '/me/mbti', body);
    },
    mbtiPermission: function () { return request('GET', '/me/mbti-permission'); },

    /* ---- 公开访问与评价 ---- */
    publicUser: function (token) { return request('GET', '/u/' + encodeURIComponent(token)); },
    submitVote: function (token, payload) {
      return request('POST', '/u/' + encodeURIComponent(token) + '/vote', payload);
    },
    summary: function (token) { return request('GET', '/u/' + encodeURIComponent(token) + '/summary'); },
    listVotes: function (token, limit, offset) {
      var q = '?limit=' + (limit || 50) + '&offset=' + (offset || 0);
      return request('GET', '/u/' + encodeURIComponent(token) + '/votes' + q);
    },
    /** 把某条评价标为失效 / 恢复有效（只能操作自己收到的评价） */
    setVoteInvalid: function (token, voteId, invalid) {
      return request('PATCH',
        '/u/' + encodeURIComponent(token) + '/votes/' + encodeURIComponent(voteId),
        { invalid: invalid === true });
    },
    /** 我发给别人的评价列表 */
    myVotesGiven: function (limit, offset) {
      var q = '?limit=' + (limit || 50) + '&offset=' + (offset || 0);
      return request('GET', '/me/votes-given' + q);
    },
    /** 我是否已经评价过这个分享链接的主人（未登录时 voted 恒为 false，不报错） */
    myVote: function (token) {
      return request('GET', '/u/' + encodeURIComponent(token) + '/my-vote');
    }
  };

  global.API = API;
})(typeof window !== 'undefined' ? window : this);
