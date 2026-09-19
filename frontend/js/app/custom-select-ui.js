/* custom-select-ui.js — 自绘下拉选择器（VersePC-CE）
 *
 * 解决的问题：原生 <select> 的弹出层由浏览器（WebView2）绘制，样式不可控、
 * 无动效、深浅主题下观感割裂（例如助手页 AI 设置里选择供应商时的「模型 / 接口格式」）。
 *
 * 做法（关键：不破坏任何既有逻辑）：
 *   1. 原生 <select> 保留在 DOM 中，仅用 .vsel-native 隐藏 —— 它仍是唯一数据源；
 *   2. 触发器是与原生 select 同级的 <button>，沿用 select 原有 class
 *      （.select-input / .vset-select），因此自动继承各主题既有观感；
 *   3. 用户选择时写回 native.value 并派发原生 change 事件 —— Vue v-model、
 *      原生 onchange、任何读 .value 的代码全部照旧工作；
 *   4. 反向同步：拦截 value 的 setter + MutationObserver 监听 options 变化，
 *      Vue 重渲染 / 动态填充选项后触发器文案会自动跟上。
 *
 * 动效：箭头旋转、触发器聚焦光晕、弹层缩放淡入、选项逐个错峰滑入、勾选弹跳。
 */
(function () {
  'use strict';

  var SELECTOR = 'select.select-input, select.vset-select, select.va-select';
  var PANEL_GAP = 6;
  var PANEL_MAX_H = 320;
  var CLOSE_MS = 140;

  var ARROW_SVG =
    '<svg class="vsel-trigger__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

  var CHECK_SVG =
    '<svg class="vsel-option__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  function esc(s) {
    if (typeof window.escapeHtml === 'function') {
      try { return window.escapeHtml(s); } catch (e) { /* fallthrough */ }
    }
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var VALUE_DESC = null;
  try {
    VALUE_DESC = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  } catch (e) { /* 极端环境下降级为不拦截 setter */ }

  var instances = [];
  var openedInstance = null;
  var globalBound = false;

  /* ── 实例 ───────────────────────────────────────────────────────────── */

  function Vsel(native) {
    this.native = native;
    this.open = false;
    this.panel = null;
    this.scroll = null;
    this.activeIndex = -1;
    this.typeBuffer = '';
    this.typeTimer = 0;

    native.dataset.vselReady = '1';
    native.classList.add('vsel-native');

    // 触发器：沿用原生 select 的样式类与内联样式
    var trigger = document.createElement('button');
    trigger.type = 'button';
    var cls = native.className.replace(/\bvsel-native\b/g, '').trim();
    trigger.className = 'vsel-trigger' + (cls ? ' ' + cls : '');
    var inlineStyle = native.getAttribute('style');
    if (inlineStyle) trigger.setAttribute('style', inlineStyle);
    trigger.innerHTML = '<span class="vsel-trigger__value"></span>' + ARROW_SVG;
    var label = '';
    try {
      if (native.labels && native.labels.length) label = (native.labels[0].textContent || '').trim();
    } catch (e) { /* ignore */ }
    if (label) trigger.title = label;

    this.trigger = trigger;
    this.valueEl = trigger.querySelector('.vsel-trigger__value');
    this.fieldLabel = label;

    native.parentNode.insertBefore(trigger, native.nextSibling);

    this._bindEvents();
    this._watchOptions();
    this.sync();
  }

  Vsel.prototype._bindEvents = function () {
    var self = this;

    this.trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      self.open ? self.close() : self.openPanel();
    });

    this.trigger.addEventListener('keydown', function (e) {
      self._onKeydown(e);
    });

    // 其他代码直接派发 change（或浏览器的原生交互）时同步文案
    this.native.addEventListener('change', function () { self.sync(); });

    // 拦截 value 写入：Vue 打补丁 / 其他 JS 赋值时触发器文案立即跟上
    if (VALUE_DESC) {
      try {
        Object.defineProperty(this.native, 'value', {
          configurable: true,
          enumerable: true,
          get: function () { return VALUE_DESC.get.call(self.native); },
          set: function (v) {
            VALUE_DESC.set.call(self.native, v);
            self.sync();
          }
        });
      } catch (e) { /* ignore */ }
    }
  };

  Vsel.prototype._watchOptions = function () {
    var self = this;
    try {
      this.observer = new MutationObserver(function () {
        self.sync();
        if (self.open) {
          self.render();
          self.reposition();
        }
      });
      this.observer.observe(this.native, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'label', 'value']
      });
    } catch (e) { /* ignore */ }
  };

  /* 把原生 select 的状态同步到触发器 */
  Vsel.prototype.sync = function () {
    var n = this.native;
    var opt = n.selectedIndex >= 0 ? n.options[n.selectedIndex] : null;
    var text = opt ? String(opt.text) : '';
    this.valueEl.textContent = text;
    this.valueEl.classList.toggle('is-placeholder', !opt);
    this.trigger.disabled = !!n.disabled;
    this.trigger.title = this.fieldLabel ? this.fieldLabel + '：' + text : text;
  };

  Vsel.prototype.destroy = function () {
    if (this.observer) this.observer.disconnect();
    if (this.panel && this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
    if (this.trigger && this.trigger.parentNode) this.trigger.parentNode.removeChild(this.trigger);
    this.native.dataset.vselReady = '';
    delete this.native.dataset.vselReady;
    this.native.classList.remove('vsel-native');
  };

  /* ── 弹层 ───────────────────────────────────────────────────────────── */

  Vsel.prototype._ensurePanel = function () {
    if (this.panel) return this.panel;
    var panel = document.createElement('div');
    panel.className = 'vsel-panel';
    panel.setAttribute('role', 'listbox');
    var scroll = document.createElement('div');
    scroll.className = 'vsel-panel__scroll';
    panel.appendChild(scroll);
    this.panel = panel;
    this.scroll = scroll;
    return panel;
  };

  Vsel.prototype.render = function () {
    var n = this.native;
    var scroll = this.scroll;
    if (!scroll) return;

    if (!n.options.length) {
      scroll.innerHTML = '<div class="vsel-panel__empty">暂无可选项</div>';
      return;
    }

    var html = '';
    var lastGroup = null;
    var order = 0;

    for (var i = 0; i < n.options.length; i++) {
      var o = n.options[i];
      var group = (o.parentNode && o.parentNode.tagName === 'OPTGROUP') ? (o.parentNode.label || '') : null;
      if (group && group !== lastGroup) {
        html += '<div class="vsel-group-title">' + esc(group) + '</div>';
        order = 0;
      }
      lastGroup = group;

      var delay = Math.min(order++, 14) * 12;
      html +=
        '<div class="vsel-option' +
          (i === n.selectedIndex ? ' is-selected' : '') +
          (o.disabled ? ' is-disabled' : '') +
        '" role="option" data-index="' + i + '"' +
        ' aria-selected="' + (i === n.selectedIndex ? 'true' : 'false') + '"' +
        ' style="animation-delay:' + delay + 'ms">' +
          '<span class="vsel-option__label">' + esc(o.text) + '</span>' +
          CHECK_SVG +
        '</div>';
    }

    scroll.innerHTML = html;

    var self = this;
    Array.prototype.forEach.call(scroll.querySelectorAll('.vsel-option'), function (el) {
      el.addEventListener('click', function () {
        self.selectIndex(parseInt(el.dataset.index, 10));
      });
      el.addEventListener('mouseenter', function () {
        self._setActive(parseInt(el.dataset.index, 10), false);
      });
    });
  };

  Vsel.prototype.reposition = function () {
    var panel = this.panel;
    if (!panel || !document.body.contains(panel)) return;

    var r = this.trigger.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var maxH = Math.max(140, Math.min(PANEL_MAX_H, vh - 24));
    this.scroll.style.maxHeight = maxH + 'px';

    var width = Math.max(Math.round(r.width), 168);
    var height = panel.offsetHeight || 240;

    var left = Math.round(Math.min(Math.max(8, r.left), Math.max(8, vw - width - 8)));
    var top = r.bottom + PANEL_GAP;
    var up = false;

    if (top + height > vh - 8 && r.top - height - PANEL_GAP > 8) {
      top = r.top - height - PANEL_GAP;
      up = true;
    }
    if (top + height > vh - 8) top = Math.max(8, vh - height - 8);

    panel.style.width = width + 'px';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.classList.toggle('vsel-panel--up', up);
  };

  Vsel.prototype.scrollSelectedIntoView = function () {
    if (!this.scroll) return;
    var el = this.scroll.querySelector('.vsel-option.is-selected');
    if (!el) return;
    var top = el.offsetTop - this.scroll.clientHeight / 2 + el.offsetHeight / 2;
    this.scroll.scrollTop = Math.max(0, top);
  };

  Vsel.prototype.openPanel = function () {
    if (this.open || this.native.disabled) return;
    if (openedInstance && openedInstance !== this) openedInstance.close();
    openedInstance = this;
    this.open = true;

    var panel = this._ensurePanel();
    panel.classList.remove('vsel-panel--out', 'vsel-panel--in');

    document.body.appendChild(panel);
    this.render();
    this.reposition();

    this.trigger.classList.add('is-open');

    var self = this;
    // 先渲染到「收起态」，下一帧再切到展开态，过渡才会真正播放
    void panel.offsetWidth;
    requestAnimationFrame(function () {
      panel.classList.add('vsel-panel--in');
      self.scrollSelectedIntoView();
    });

    this.activeIndex = this.native.selectedIndex;
  };

  Vsel.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    this.trigger.classList.remove('is-open');
    if (openedInstance === this) openedInstance = null;
    if (!this.panel) return;

    var panel = this.panel;
    panel.classList.remove('vsel-panel--in');
    panel.classList.add('vsel-panel--out');

    clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(function () {
      panel.classList.remove('vsel-panel--out');
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    }, CLOSE_MS);
  };

  Vsel.prototype.selectIndex = function (index) {
    var o = this.native.options[index];
    if (!o || o.disabled) return;
    this.native.selectedIndex = index;
    if (VALUE_DESC) {
      // 绕过我们的 setter 直接写入后手动同步，避免重复触发
      try { VALUE_DESC.set.call(this.native, o.value); } catch (e) { /* ignore */ }
    }
    this.sync();
    this.dispatchChange();
    this.close();
  };

  Vsel.prototype.dispatchChange = function () {
    var ev;
    try {
      ev = new Event('change', { bubbles: true });
    } catch (e) {
      ev = document.createEvent('HTMLEvents');
      ev.initEvent('change', true, false);
    }
    this.native.dispatchEvent(ev);
  };

  /* ── 键盘 ───────────────────────────────────────────────────────────── */

  Vsel.prototype._optionEls = function () {
    if (!this.scroll) return [];
    return Array.prototype.slice.call(this.scroll.querySelectorAll('.vsel-option:not(.is-disabled)'));
  };

  Vsel.prototype._setActive = function (index, scroll) {
    if (!this.scroll) return;
    var els = this.scroll.querySelectorAll('.vsel-option');
    for (var i = 0; i < els.length; i++) {
      els[i].classList.toggle('is-active', parseInt(els[i].dataset.index, 10) === index);
    }
    this.activeIndex = index;
    if (scroll === false) return;
    var el = this.scroll.querySelector('.vsel-option.is-active');
    if (el) {
      var top = el.offsetTop;
      var bottom = top + el.offsetHeight;
      if (top < this.scroll.scrollTop) this.scroll.scrollTop = top;
      else if (bottom > this.scroll.scrollTop + this.scroll.clientHeight) {
        this.scroll.scrollTop = bottom - this.scroll.clientHeight;
      }
    }
  };

  Vsel.prototype._move = function (dir) {
    var els = this._optionEls();
    if (!els.length) return;
    var idxs = els.map(function (el) { return parseInt(el.dataset.index, 10); });
    var cur = idxs.indexOf(this.activeIndex);
    var next = cur < 0 ? (dir > 0 ? 0 : idxs.length - 1) : (cur + dir + idxs.length) % idxs.length;
    this._setActive(idxs[next]);
  };

  Vsel.prototype._onKeydown = function (e) {
    var k = e.key;

    if (!this.open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ' || k === 'Spacebar') {
        e.preventDefault();
        this.openPanel();
      }
      return;
    }

    switch (k) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        this._move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._move(-1);
        break;
      case 'Home':
        e.preventDefault();
        this._setActive(this._optionEls()[0] ? parseInt(this._optionEls()[0].dataset.index, 10) : -1);
        break;
      case 'End':
        e.preventDefault();
        var last = this._optionEls().pop();
        this._setActive(last ? parseInt(last.dataset.index, 10) : -1);
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        if (this.activeIndex >= 0) this.selectIndex(this.activeIndex);
        break;
      case 'Tab':
        this.close();
        break;
      default:
        if (k && k.length === 1 && /\S/.test(k)) {
          e.preventDefault();
          this._typeahead(k);
        }
        break;
    }
  };

  Vsel.prototype._typeahead = function (ch) {
    var self = this;
    clearTimeout(this.typeTimer);
    this.typeBuffer += ch.toLowerCase();
    this.typeTimer = setTimeout(function () { self.typeBuffer = ''; }, 600);

    var opts = this.native.options;
    var buf = this.typeBuffer;
    for (var i = 0; i < opts.length; i++) {
      if (!opts[i].disabled && String(opts[i].text).toLowerCase().indexOf(buf) === 0) {
        this._setActive(i);
        return;
      }
    }
  };

  /* ── 全局：点击外部关闭 / 滚动跟随 / 自动发现新 select ─────────────── */

  function bindGlobal() {
    if (globalBound) return;
    globalBound = true;

    document.addEventListener('click', function (e) {
      if (!openedInstance) return;
      var t = e.target;
      if (openedInstance.trigger.contains(t)) return;
      if (openedInstance.panel && openedInstance.panel.contains(t)) return;
      openedInstance.close();
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openedInstance) openedInstance.close();
    });

    window.addEventListener('resize', function () {
      if (openedInstance) openedInstance.reposition();
    });

    window.addEventListener('scroll', function () {
      if (!openedInstance) return;
      var r = openedInstance.trigger.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) openedInstance.close();
      else openedInstance.reposition();
    }, true);
  }

  function enhanceAll() {
    var list;
    try {
      list = document.querySelectorAll(SELECTOR);
    } catch (e) {
      return;
    }
    Array.prototype.forEach.call(list, function (sel) {
      if (!sel || sel.dataset.vselReady === '1') return;
      if (sel.multiple || sel.size > 1) return;
      if (sel.closest('.custom-select')) return;
      if (!sel.parentNode) return;
      try {
        instances.push(new Vsel(sel));
      } catch (e) {
        console.warn('[vsel] 升级失败，保留原生 select:', e);
        sel.dataset.vselReady = '1'; // 不再重试，避免刷屏
      }
    });
  }

  /* 清理随页面/弹窗一起被移除的实例，避免残留监听 */
  function sweep() {
    for (var i = instances.length - 1; i >= 0; i--) {
      var inst = instances[i];
      if (inst.trigger && document.contains(inst.trigger)) continue;
      inst.destroy();
      instances.splice(i, 1);
    }
  }

  var scanTimer = 0;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      sweep();
      enhanceAll();
    }, 120);
  }

  function watchDom() {
    try {
      var mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var nodes = records[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'SELECT' || (n.querySelector && n.querySelector('select'))) {
              scheduleScan();
              return;
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  function boot() {
    bindGlobal();
    enhanceAll();
    watchDom();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 公开最小 API，方便后续按需使用
  window.VerseSelect = {
    refresh: function () { sweep(); enhanceAll(); },
    closeAll: function () { if (openedInstance) openedInstance.close(); }
  };
})();
