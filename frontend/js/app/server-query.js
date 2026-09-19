/* server-query.js — 工具箱「测试服务器」：Minecraft 服务器状态查询
 *
 * 协议（Server List Ping）实现在后端 server_query.rs，算法参考瞅眼服务器/2.py：
 *   TCP → Handshake(next_state=1) → Status Request → JSON 状态 + 往返延迟
 * 本文件负责：地址解析（同 2.py 的 parse_address）、MOTD 颜色码渲染、
 * 结果列表渲染（仿 MC 多人联机服务器列表：图标 | 名称+MOTD | 人数+信号格）。
 */
(function () {
  'use strict';

  // ============== Tauri invoke 获取（兼容 v1/v2） ==============
  function _getCore() {
    if (window.__TAURI__ && window.__TAURI__.core) return window.__TAURI__.core;
    if (window.__TAURI_INTERNALS__) return window.__TAURI_INTERNALS__;
    return null;
  }

  // ============== 地址解析（参考 2.py parse_address） ==============
  // 支持：mc.example.com | mc.example.com 25565 | mc.example.com:25565 | [2001:db8::1]:25565
  function parseAddress(input) {
    input = (input || '').trim();
    if (!input) return null;
    if (input.charAt(0) === '[') {
      var m = input.match(/^\[(.*?)\](?::(\d+))?$/);
      if (m) {
        var host6 = m[1];
        var portStr6 = m[2];
        if (portStr6) {
          var p6 = parseInt(portStr6, 10);
          if (p6 >= 1 && p6 <= 65535) return { host: host6, port: p6 };
        }
        return { host: host6, port: null };
      }
      return { host: input, port: null };
    }
    if (input.indexOf(' ') > -1) {
      var parts = input.split(/\s+/);
      if (parts.length >= 2) {
        var p2 = parseInt(parts[1], 10);
        if (p2 >= 1 && p2 <= 65535) return { host: parts[0], port: p2 };
      }
      return { host: input, port: null };
    }
    if (input.indexOf(':') > -1) {
      var idx = input.lastIndexOf(':');
      var hostPart = input.slice(0, idx);
      var portPart = input.slice(idx + 1);
      if (/^\d+$/.test(portPart)) {
        var p = parseInt(portPart, 10);
        if (p >= 1 && p <= 65535 && hostPart) return { host: hostPart, port: p };
      }
      return { host: input, port: null };
    }
    return { host: input, port: null };
  }

  // ============== MOTD 渲染 ==============
  var MC_COLORS = {
    '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
    '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
    '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
    'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF'
  };

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 把 description（字符串或 JSON 组件）拍平为带 § 码的纯文本（保留换行） */
  function motdPlainText(desc) {
    var text = '';
    function walk(node) {
      if (node == null) return;
      if (typeof node === 'string') { text += node; return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node === 'object') {
        if (typeof node.text === 'string') text += node.text;
        if (Array.isArray(node.extra)) node.extra.forEach(walk);
        if (typeof node.translate === 'string') text += node.translate;
      }
    }
    walk(desc);
    return text;
  }

  /** § 颜色/格式码 → HTML span */
  function motdToHtml(desc) {
    var text = motdPlainText(desc);
    var out = '';
    var color = null;
    var bold = false;
    var italic = false;
    var underline = false;
    var strike = false;
    var buffer = '';

    function flush() {
      if (!buffer) return;
      var style = '';
      if (color) style += 'color:' + color + ';';
      if (bold) style += 'font-weight:700;';
      if (italic) style += 'font-style:italic;';
      if (underline) style += 'text-decoration:underline;';
      if (strike) style += 'text-decoration:line-through;';
      out += style
        ? '<span style="' + style + '">' + esc(buffer) + '</span>'
        : esc(buffer);
      buffer = '';
    }

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\u00A7' && i + 1 < text.length) {
        var code = text[i + 1].toLowerCase();
        flush();
        if (MC_COLORS[code]) { color = MC_COLORS[code]; }
        else if (code === 'l') bold = true;
        else if (code === 'o') italic = true;
        else if (code === 'n') underline = true;
        else if (code === 'm') strike = true;
        else if (code === 'r') { color = null; bold = italic = underline = strike = false; }
        i++;
      } else {
        buffer += ch;
      }
    }
    flush();
    return out;
  }

  // ============== 延迟信号格（仿 MC 五格信号） ==============
  function pingBarsHtml(ms) {
    var bars = ms < 0 ? 0 : ms < 150 ? 5 : ms < 300 ? 4 : ms < 600 ? 3 : ms < 1000 ? 2 : 1;
    var color = bars >= 4 ? '#3dd68c' : bars === 3 ? '#fbbf24' : '#ef4444';
    var svg = '<svg viewBox="0 0 22 18" style="width:22px;height:18px;display:block;">';
    for (var i = 0; i < 5; i++) {
      var h = 3 + i * 3.2;
      var x = i * 4.4;
      var lit = i < bars;
      svg += '<rect x="' + x + '" y="' + (18 - h) + '" width="3.2" height="' + h +
        '" rx="0.8" fill="' + (lit ? color : 'var(--text-tertiary, #555)') + '" opacity="' + (lit ? 1 : 0.35) + '"/>';
    }
    svg += '</svg>';
    return svg;
  }

  // ============== 结果行渲染 ==============
  var FALLBACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:26px;height:26px;opacity:.5;"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>';

  function iconHtml(favicon) {
    if (favicon && typeof favicon === 'string' && favicon.startsWith('data:image')) {
      return '<img class="mc-sq-icon" src="' + favicon + '" alt="" onerror="this.outerHTML=\'<div class=&quot;mc-sq-icon mc-sq-icon-fallback&quot;>' +
        esc(FALLBACK_ICON).replace(/"/g, '&quot;') + '</div>\'">';
    }
    return '<div class="mc-sq-icon mc-sq-icon-fallback">' + FALLBACK_ICON + '</div>';
  }

  function resultRowHtml(r) {
    if (!r.ok) {
      return '<div class="mc-sq-row mc-sq-row--failed">' +
        '<div class="mc-sq-icon mc-sq-icon-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:24px;height:24px;opacity:.6;"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg></div>' +
        '<div class="mc-sq-main"><div class="mc-sq-name">' + esc(r.address) + '</div>' +
        '<div class="mc-sq-motd mc-sq-motd--failed">' + esc(r.error || '无法连接到服务器') + '</div></div>' +
        '<div class="mc-sq-right"><span class="mc-sq-version">未知</span>' + pingBarsHtml(-1) + '</div>' +
        '</div>';
    }

    var s = r.status || {};
    var players = s.players || {};
    var online = typeof players.online === 'number' ? players.online : null;
    var max = typeof players.max === 'number' ? players.max : null;
    var playersText = (online != null && max != null) ? (online + ' / ' + max) : (online != null ? String(online) : '--');
    var version = (s.version && s.version.name) ? s.version.name : '未知版本';
    var ms = typeof r.pingMs === 'number' ? r.pingMs : -1;
    var motdHtml = motdToHtml(s.description) || '<span style="opacity:.5">（无 MOTD）</span>';

    return '<div class="mc-sq-row">' +
      iconHtml(s.favicon) +
      '<div class="mc-sq-main">' +
        '<div class="mc-sq-name">' + esc(r.address) + '</div>' +
        '<div class="mc-sq-motd">' + motdHtml + '</div>' +
      '</div>' +
      '<div class="mc-sq-right">' +
        '<div class="mc-sq-players"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>' +
        '<span>' + esc(playersText) + '</span></div>' +
        '<span class="mc-sq-version">' + esc(version) + '</span>' +
        '<div class="mc-sq-ping" title="延迟 ' + ms + ' ms">' + pingBarsHtml(ms) + '<span class="mc-sq-ping-ms">' + (ms >= 0 ? ms + 'ms' : 'N/A') + '</span></div>' +
      '</div>' +
      '</div>';
  }

  // ============== 主流程 ==============
  var _querying = false;

  async function queryMcServer() {
    if (_querying) return;
    var inputEl = document.getElementById('mc-server-query-input');
    var listEl = document.getElementById('mc-server-query-results');
    if (!inputEl || !listEl) return;

    var input = inputEl.value.trim();
    if (!input) {
      if (typeof showToast === 'function') showToast('请输入服务器地址', 'info');
      return;
    }

    var parsed = parseAddress(input);
    if (!parsed || !parsed.host) {
      if (typeof showToast === 'function') showToast('地址格式无法识别，请检查后重试', 'error');
      return;
    }

    var core = _getCore();
    if (!core || !core.invoke) {
      if (typeof showToast === 'function') showToast('当前环境不支持服务器查询', 'error');
      return;
    }

    var addressLabel = parsed.host + (parsed.port && parsed.port !== 25565 ? ':' + parsed.port : '');
    _querying = true;
    var btn = document.getElementById('mc-server-query-btn');
    if (btn) { btn.disabled = true; btn.textContent = '查询中...'; }

    // 占位行插到最前（MC 列表习惯：最新在上）
    var placeholder = document.createElement('div');
    placeholder.className = 'mc-sq-row mc-sq-row--querying';
    placeholder.innerHTML = '<div class="mc-sq-icon mc-sq-icon-fallback"><svg class="dl-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:20px;height:20px;"><path d="M21 12a9 9 0 11-6.2-8.56"/></svg></div>' +
      '<div class="mc-sq-main"><div class="mc-sq-name">' + esc(addressLabel) + '</div>' +
      '<div class="mc-sq-motd" style="opacity:.6;">正在查询服务器信息...</div></div>';
    listEl.insertBefore(placeholder, listEl.firstChild);

    try {
      var result = await core.invoke('tool_server_query', {
        address: parsed.host,
        port: parsed.port ? parsed.port : null
      });
      var row = result && result.ok
        ? resultRowHtml({
            ok: true,
            address: addressLabel,
            status: result.status,
            pingMs: result.pingMs
          })
        : resultRowHtml({ ok: false, address: addressLabel, error: (result && result.error) || '查询失败' });
      placeholder.outerHTML = row;
      if (typeof showToast === 'function') showToast('查询完成：' + addressLabel, 'success');
    } catch (e) {
      var msg = (e && e.message) ? e.message : String(e);
      placeholder.outerHTML = resultRowHtml({ ok: false, address: addressLabel, error: msg });
      if (typeof showToast === 'function') showToast('查询失败：' + addressLabel, 'error');
    } finally {
      _querying = false;
      if (btn) { btn.disabled = false; btn.textContent = '查询'; }
    }
  }

  window.queryMcServer = queryMcServer;
  window._sqParseAddress = parseAddress;
  window._sqEsc = esc;
  window._sqResultRow = resultRowHtml;
})();
