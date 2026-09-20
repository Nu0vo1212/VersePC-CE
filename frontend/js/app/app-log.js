/**
 * @file app-log.js
 * @description 程序运行日志（「运行日志」页面）
 *
 * 和「游戏日志」（控制台页，游戏 stdout/stderr）完全分开、互不干扰：
 *   · 游戏日志 = Minecraft 进程的输出
 *   · 运行日志 = 启动器自己「做了什么」：每一次接口调用、页面跳转、下载任务、
 *               启动流程、以及所有报错，方便排查问题
 *
 * 采集方式（全部自动，业务代码基本不用改）：
 *   1. console.error / console.warn  →  warn / error
 *   2. window.onerror / unhandledrejection → error
 *   3. 所有 /api 请求（api.js 里调用 AppLog.api 上报）→ op
 *      · 高频轮询接口成功时不记，失败照样记，避免刷屏
 *   4. 页面跳转、下载任务、启动流程等关键动作 → op（业务代码显式调用 AppLog.op）
 *
 * 容量与持久化：
 *   · 内存最多保留 MAX_MEM 条，超出丢弃最旧的
 *   · 节流写入 localStorage（键 versepc_runtime_log），重启后还能看到上一次的记录
 *   · 连续重复的日志自动合并为一条并累计次数（count），不会刷屏
 *
 * 该文件必须在其它业务脚本之前加载（index.html 里靠前），才能捕获启动阶段的报错。
 */
(function () {
  'use strict';

  var MAX_MEM = 3000;      // 内存中最多保留的日志条数
  var MAX_STORE = 1200;    // 持久化到 localStorage 的条数
  var MAX_MSG = 600;       // 单条消息最大长度
  var STORE_KEY = 'versepc_runtime_log';
  var SAVE_DELAY = 1500;   // 持久化节流间隔（ms）

  /** 高频轮询接口：成功时不记录（失败仍然记录），否则安装/下载期间会刷屏 */
  var POLL_PATHS = [
    '/api/install-progress',
    '/api/version/repair-progress',
    '/api/mods/download-status',
    '/api/launch/session-status',
    '/api/game/status',
    '/api/java/install-status',
    '/api/java/download-status',
    '/api/java/import-status',
    '/api/jvm/cds-status'
  ];

  var LEVEL_LABEL = { op: '操作', info: '信息', warn: '警告', error: '错误' };

  var entries = [];      // 按时间升序，最新在最后
  var seq = 0;
  var listeners = [];
  var saveTimer = null;
  var saveDirty = false;
  var online = (typeof navigator === 'undefined') ? true : (navigator.onLine !== false);

  // ────────────────────────────────────────────────────────────
  // 工具
  // ────────────────────────────────────────────────────────────
  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function timeText(ts) {
    var d = new Date(ts || Date.now());
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) +
      '.' + pad(d.getMilliseconds(), 3);
  }

  function dateTimeText(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' + timeText(ts);
  }

  function clip(s, n) {
    s = (s === null || s === undefined) ? '' : String(s);
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > n) s = s.slice(0, n) + '…';
    return s;
  }

  /** 把任意值粗略转成一行文本（对象尝试 JSON 化） */
  function stringify(v) {
    if (v === null || v === undefined) return '';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (v instanceof Error) return v.message || String(v);
    try {
      var s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      try { return String(v); } catch (e2) { return '[无法序列化]'; }
    }
  }

  function isPollPath(path) {
    if (!path) return false;
    for (var i = 0; i < POLL_PATHS.length; i++) {
      if (path.indexOf(POLL_PATHS[i]) === 0) return true;
    }
    return false;
  }

  // ────────────────────────────────────────────────────────────
  // 核心写入
  // ────────────────────────────────────────────────────────────
  function push(level, tag, msg, extra) {
    try {
      level = LEVEL_LABEL[level] ? level : 'info';
      tag = clip(tag || 'app', 24);
      msg = clip(msg, MAX_MSG);
      if (extra !== undefined && extra !== null && extra !== '') {
        var ex = clip(stringify(extra), Math.max(80, MAX_MSG - msg.length - 3));
        if (ex && ex !== '{}' && ex !== '[]') msg = msg ? (msg + ' | ' + ex) : ex;
      }

      var last = entries.length ? entries[entries.length - 1] : null;
      // 连续完全相同的日志 → 合并计数，避免轮询把日志刷爆
      if (last && last.level === level && last.tag === tag && last.msg === msg) {
        last.count = (last.count || 1) + 1;
        last.t = Date.now();
        saveDirty = true;
        scheduleSave();
        notify(last);
        return last;
      }

      var item = { id: ++seq, t: Date.now(), level: level, tag: tag, msg: msg, count: 1 };
      entries.push(item);
      if (entries.length > MAX_MEM) {
        entries.splice(0, entries.length - MAX_MEM);
        // 重新编号，避免 id 无限增长
        if (seq > MAX_MEM * 4) { seq = entries.length; for (var i = 0; i < entries.length; i++) entries[i].id = i + 1; }
      }
      saveDirty = true;
      scheduleSave();
      notify(item);
      return item;
    } catch (e) { /* 日志系统自身绝不能影响主流程 */ }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      flush();
    }, SAVE_DELAY);
  }

  function flush() {
    if (!saveDirty) return;
    saveDirty = false;
    try {
      var tail = entries.slice(-MAX_STORE);
      localStorage.setItem(STORE_KEY, JSON.stringify(tail));
    } catch (e) {
      // localStorage 写满时退一步：只留最近的 300 条再试一次
      try { localStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(-300))); } catch (e2) {}
    }
  }

  function notify(item) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](item); } catch (e) {}
    }
  }

  function loadStored() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      entries = arr.filter(function (x) { return x && x.msg; }).map(function (x) {
        return {
          id: ++seq,
          t: x.t || Date.now(),
          level: LEVEL_LABEL[x.level] ? x.level : 'info',
          tag: clip(x.tag || 'app', 24),
          msg: clip(x.msg, MAX_MSG),
          count: x.count || 1,
          restored: true
        };
      });
      if (entries.length > MAX_MEM) entries = entries.slice(-MAX_MEM);
    } catch (e) { entries = []; }
  }

  // ────────────────────────────────────────────────────────────
  // 自动采集
  // ────────────────────────────────────────────────────────────
  function installConsoleHooks() {
    try {
      var origError = console.error;
      var origWarn = console.warn;

      console.error = function () {
        try { push('error', 'console', Array.prototype.map.call(arguments, stringify).join(' ')); } catch (e) {}
        return origError.apply(console, arguments);
      };
      console.warn = function () {
        try { push('warn', 'console', Array.prototype.map.call(arguments, stringify).join(' ')); } catch (e) {}
        return origWarn.apply(console, arguments);
      };
    } catch (e) {}
  }

  function installErrorHooks() {
    try {
      window.addEventListener('error', function (e) {
        try {
          if (e && e.target && e.target !== window && e.target.tagName) {
            // 资源加载失败（img/script）也记一笔，方便排查白屏
            push('error', 'resource', '资源加载失败: ' + e.target.tagName + ' ' + (e.target.src || e.target.href || ''));
            return;
          }
          var where = (e && e.filename ? e.filename.replace(/^.*[\\/]/, '') : '') +
            (e && e.lineno ? ':' + e.lineno : '');
          push('error', 'js', (e && e.message ? e.message : '未捕获错误') + (where ? ' @' + where : ''));
        } catch (err) {}
      }, true);

      window.addEventListener('unhandledrejection', function (e) {
        try {
          var r = e && e.reason;
          var msg = r && r.message ? r.message : stringify(r);
          push('error', 'promise', '未处理的异步错误: ' + msg);
        } catch (err) {}
      });

      window.addEventListener('offline', function () { online = false; push('warn', 'network', '网络已断开'); });
      window.addEventListener('online', function () { online = true; push('info', 'network', '网络已恢复'); });
    } catch (e) {}
  }

  // ────────────────────────────────────────────────────────────
  // 对外接口
  // ────────────────────────────────────────────────────────────
  function op(tag, msg, extra) { return push('op', tag, msg, extra); }
  function info(tag, msg, extra) { return push('info', tag, msg, extra); }
  function warn(tag, msg, extra) { return push('warn', tag, msg, extra); }
  function error(tag, msg, extra) { return push('error', tag, msg, extra); }

  /**
   * API 请求上报（由 js/api.js 调用）。
   * @param {string} method GET/POST/...
   * @param {string} path   /api/xxx
   * @param {number} status HTTP 状态码，0 表示请求异常
   * @param {number} ms     耗时
   * @param {Error}  [err]  异常对象
   */
  function api(method, path, status, ms, err) {
    try {
      var failed = !status || status >= 400;
      if (!failed && isPollPath(path)) return;          // 高频轮询成功不记
      var line = method + ' ' + path + ' → ' + (status || 'ERR') + '（' + ms + 'ms）';
      if (failed) {
        error('接口', line + (err ? ' ' + (err.message || err) : ''));
      } else {
        op('接口', line);
      }
    } catch (e) {}
  }

  function list(level) {
    if (!level || level === 'all') return entries;
    return entries.filter(function (x) { return x.level === level; });
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function clear() {
    entries = [];
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    notify(null);
  }

  function text(level) {
    return list(level).map(function (x) {
      return '[' + dateTimeText(x.t) + '] [' + (LEVEL_LABEL[x.level] || x.level) + '] [' + x.tag + '] ' +
        x.msg + ((x.count || 1) > 1 ? '  (×' + x.count + ')' : '');
    }).join('\n');
  }

  function stats() {
    var s = { total: entries.length, op: 0, info: 0, warn: 0, error: 0 };
    for (var i = 0; i < entries.length; i++) {
      var l = entries[i].level;
      if (s[l] === undefined) s[l] = 0;
      s[l]++;
    }
    return s;
  }

  /** 导出为文件（浏览器下载），返回文件名 */
  function download() {
    var stamp = new Date();
    var name = 'VersePC-CE-运行日志-' + stamp.getFullYear() + pad(stamp.getMonth() + 1, 2) + pad(stamp.getDate(), 2) +
      '-' + pad(stamp.getHours(), 2) + pad(stamp.getMinutes(), 2) + pad(stamp.getSeconds(), 2) + '.log';
    var head = 'VersePC-CE 运行日志\n导出时间: ' + dateTimeText(Date.now()) +
      '\n运行环境: ' + (navigator.userAgent || '未知') + '\n' + new Array(60).join('=') + '\n';
    try {
      var blob = new Blob([head + text()], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 3000);
    } catch (e) {
      error('日志', '导出失败: ' + (e.message || e));
    }
    return name;
  }

  function copy() {
    var body = text();
    try {
      if (window.electronAPI && window.electronAPI.clipboard && window.electronAPI.clipboard.writeText) {
        window.electronAPI.clipboard.writeText(body);
        return Promise.resolve(true);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(body).then(function () { return true; }, function () { return false; });
      }
    } catch (e) {}
    return Promise.resolve(false);
  }

  // ────────────────────────────────────────────────────────────
  // 初始化
  // ────────────────────────────────────────────────────────────
  loadStored();
  installConsoleHooks();
  installErrorHooks();

  window.AppLog = {
    LEVEL_LABEL: LEVEL_LABEL,
    MAX_MEM: MAX_MEM,
    op: op,
    info: info,
    warn: warn,
    error: error,
    api: api,
    list: list,
    stats: stats,
    text: text,
    clear: clear,
    subscribe: subscribe,
    download: download,
    copy: copy,
    flush: flush
  };

  push('info', 'app', '启动器进程启动（版本 ' + (window.__APP_VERSION__ || '1.0.1') + '）');

  // 关窗/刷新前把还没落盘的日志写下去
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
})();
