/* frp-bridge.js — 内网穿透（LoliaFRP / OpenFrp / SakuraFrp）前端桥接层
 *
 * 职责（自 NetTool 的 lib/ipc.ts + 三个 View 的公共逻辑收敛而来）：
 *   1. 统一 invoke 封装 + 错误文本化（后端错误都是 String，直接可展示）；
 *   2. Tauri 事件订阅（frp-local-log / lolia-log / openfrp-log / sakura-log）；
 *   3. OpenFrp 专用 frpc 下载：调后端拿直链 → 建「下载任务」会话 → 交 dlManager
 *      渲染到下载页（不静默下载）→ 完成后自动解压安装。
 *
 * 约定：所有命令的返回/错误与 NetTool 后端一致（错误是中文字符串）。
 */
(function () {
  'use strict';

  function core() {
    if (window.__TAURI__ && window.__TAURI__.core) return window.__TAURI__.core;
    if (window.__TAURI_INTERNALS__) return window.__TAURI_INTERNALS__;
    return null;
  }

  function eventApi() {
    if (window.__TAURI__ && window.__TAURI__.event) return window.__TAURI__.event;
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.listen) return window.__TAURI_INTERNALS__;
    return null;
  }

  /** 调用后端命令（错误统一转成可展示的中文字符串抛出） */
  async function frpInvoke(cmd, args) {
    const c = core();
    if (!c || !c.invoke) throw new Error('Tauri 桥不可用：' + cmd);
    try {
      return await c.invoke(cmd, args || {});
    } catch (e) {
      throw (typeof e === 'string' ? new Error(e) : e);
    }
  }

  /** guard：失败弹 toast 并返回 undefined，成功可选弹 okMsg */
  async function frpGuard(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) showToast(okMsg, 'success');
      return r;
    } catch (e) {
      showToast(e && e.message ? e.message : String(e), 'error');
      return undefined;
    }
  }

  /** 订阅 frp 日志事件（返回取消函数）。事件 payload：{ tunnel, level, message } */
  function onFrpLog(eventName, callback) {
    const evt = eventApi();
    if (!evt || !evt.listen) return function () {};
    let disposed = false;
    let unlisten = null;
    evt.listen(eventName, function (event) {
      if (disposed) return;
      try { callback(event.payload); } catch (e) { console.error('[frp-bridge] log cb', eventName, e); }
    }).then(function (fn) {
      if (disposed) { try { fn(); } catch (_) {} } else { unlisten = fn; }
    }).catch(function () {});
    return function () {
      disposed = true;
      if (unlisten) { try { unlisten(); } catch (_) {} unlisten = null; }
    };
  }

  /* ============ OpenFrp 专用 frpc 下载（走下载任务，不静默） ============ */

  let _frpcDownloading = false;

  /**
   * 发起 OpenFrp 专用 frpc 下载：
   *   后端解析直链与落盘位置 → 建 /api/download-custom 会话 →
   *   注册进 dlManager（下载页可见、可取消）→ 跳转下载页 →
   *   轮询到 completed 后自动解压安装并 toast。
   * 返回 true 表示任务已创建。
   */
  async function startOpenfrpFrpcDownload() {
    if (_frpcDownloading) { showToast('专用 frpc 下载已在进行中', 'info'); return true; }
    const info = await frpGuard(function () { return frpInvoke('openfrp_frpc_download_info'); });
    if (!info) return false;

    let res;
    try {
      res = await window.bridge.apiProxy('POST', '/api/download-custom', {}, {
        url: info.url, savePath: info.savePath, fileName: info.fileName
      });
    } catch (e) {
      showToast('创建下载任务失败：' + (e && e.message ? e.message : e), 'error');
      return false;
    }
    const result = await res.json();
    if (result.error || !result.sessionId) {
      showToast(result.error || '创建下载任务失败', 'error');
      return false;
    }

    _frpcDownloading = true;
    const taskId = 'openfrp-frpc';
    const sessionId = result.sessionId;
    if (typeof dlManager !== 'undefined') {
      dlManager.add(taskId, 'OpenFrp 专用 frpc ' + (info.version || ''), 'other', sessionId);
      dlManager.update(taskId, { progress: 0, status: 'downloading', message: '正在连接...' });
    }
    showToast('已加入下载任务，可在「下载」页查看进度', 'success');
    if (typeof navigateToPage === 'function') navigateToPage('downloads');

    // 轮询下载任务进度（1s 节流，完成后自动安装）
    const timer = setInterval(async function () {
      let st = null;
      try {
        const r = await window.bridge.apiProxy('GET', '/api/download-custom/status', { sessionId: sessionId }, null);
        st = await r.json();
      } catch (e) { /* 网络/桥异常：下次重试 */ }
      if (!st || !st.status) return;

      if (typeof dlManager !== 'undefined') {
        dlManager.update(taskId, {
          progress: st.progress || 0,
          status: st.status,
          message: st.message || ''
        });
      }

      if (st.status === 'completed') {
        clearInterval(timer);
        _frpcDownloading = false;
        const inst = await frpGuard(function () {
          return frpInvoke('openfrp_frpc_install', {});
        });
        if (inst) {
          showToast('OpenFrp 专用 frpc 安装完成，启动隧道时将自动使用', 'success');
          window.dispatchEvent(new CustomEvent('frp-frpc-changed'));
        }
        if (typeof dlManager !== 'undefined') {
          dlManager.update(taskId, { status: 'completed', progress: 100, message: '已安装' });
          setTimeout(function () { try { dlManager.remove(taskId); } catch (_) {} }, 8000);
        }
      } else if (st.status === 'failed' || st.status === 'cancelled') {
        clearInterval(timer);
        _frpcDownloading = false;
        if (typeof dlManager !== 'undefined') {
          dlManager.update(taskId, { status: 'failed', message: st.message || '下载失败' });
        }
      }
    }, 1000);
    return true;
  }

  /* ============ 展示格式化（三个平台各不相同，别混用） ============ */

  function fmtBytes(n) {
    if (!n || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return v.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }

  function fmtUptime(secs) {
    const s = Math.floor(Number(secs) || 0);
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h + ' 小时 ' + m + ' 分';
  }

  function fmtDateSecs(t) {
    const n = Number(t) || 0;
    if (!n) return '—';
    const d = new Date(n * 1000);
    if (isNaN(d.getTime())) return '—';
    const p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtDateMs(t) {
    const n = Number(t) || 0;
    if (!n) return '—';
    return fmtDateSecs(n / 1000);
  }

  function fmtText(v, fallback) {
    if (v === null || v === undefined) return fallback || '—';
    const s = String(v).trim();
    return s || (fallback || '—');
  }

  function num(v, fallback) {
    const n = typeof v === 'string' ? Number(v) : v;
    return (typeof n === 'number' && Number.isFinite(n)) ? n : (fallback || 0);
  }

  window.VerseFrp = {
    invoke: frpInvoke,
    guard: frpGuard,
    onFrpLog: onFrpLog,
    startOpenfrpFrpcDownload: startOpenfrpFrpcDownload,
    fmtBytes: fmtBytes,
    fmtUptime: fmtUptime,
    fmtDateSecs: fmtDateSecs,
    fmtDateMs: fmtDateMs,
    fmtText: fmtText,
    num: num
  };
})();
