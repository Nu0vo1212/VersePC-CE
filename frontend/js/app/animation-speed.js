/* animation-speed.js — 全局动画速度调节（个性化页）
 *
 * 原理：扫描全部样式表中含 animation / transition 时长（含延时）的规则，
 * 按倍率缩放后生成一条覆盖 <style>（挂在 <head> 末尾，同特异性下后者胜出）。
 *   倍率 > 1 → 动画变快（时长变短）；< 1 → 变慢；1.0 → 标准。
 *
 * 细节：
 *   - 仅替换带 s / ms 单位的时间值；cubic-bezier(0.22,1,0.36,1)、steps(10)
 *     里的纯数字没有时间单位，不会被误改。
 *   - 首次扫描时缓存每条规则的原始值，之后始终以原始值为基准缩放，
 *     反复调整倍率不会叠加。
 *   - @media / @supports 内的规则（如 prefers-reduced-motion）会带原条件输出，
 *     不破坏无障碍降级。
 *   - 存储键：versepc_anim_speed（number，1.1 / 0.9 / 1.0 ...）
 */
(function () {
  'use strict';

  var STYLE_ID = 'anim-speed-override';

  // [{ sel, ad, adel, td, tdel, wrap }] wrap: function(decl) -> 带父条件(@media 等)的完整规则文本
  var _orig = [];
  var _seenSheets = new WeakSet();

  function scaleTimes(value, mult) {
    return String(value).replace(/(\d+(?:\.\d+)?)(m?s)\b/g, function (_, num, unit) {
      var v = parseFloat(num) * mult;
      if (v < 0) v = 0;
      // 保留合理精度，去掉浮点噪声（0.35000000000000003 -> 0.35）
      v = unit === 's' ? Math.round(v * 10000) / 10000 : Math.round(v * 1000) / 1000;
      return v + unit;
    });
  }

  function ruleHasTiming(r) {
    return (r.animationDuration && r.animationDuration !== '0s') ||
           (r.transitionDuration && r.transitionDuration !== '0s');
  }

  function collectRule(r, wrap) {
    if (ruleHasTiming(r)) {
      _orig.push({
        sel: r.selectorText,
        ad: r.animationDuration || '',
        adel: (r.animationDelay && r.animationDelay !== '0s') ? r.animationDelay : '',
        td: r.transitionDuration || '',
        tdel: (r.transitionDelay && r.transitionDelay !== '0s') ? r.transitionDelay : '',
        wrap: wrap || null
      });
    }
  }

  function walkRules(rules, wrap) {
    if (!rules) return;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      try {
        if (r.type === 1) { // CSSStyleRule
          collectRule(r, wrap);
        } else if (r.type === 7) { // @keyframes：内部无 duration，跳过
          continue;
        } else if (r.cssRules) { // @media / @supports / @layer 等，保留原条件
          (function (group) {
            var open = group.cssText ? group.cssText.split('{')[0].trim() : '';
            walkRules(group.cssRules, function (decl) {
              return open + '{' + (r.selectorText) + '}';
            });
          })(r);
        }
      } catch (e) { /* 跨域/异常规则忽略 */ }
    }
  }

  function collectAll() {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      if (!sheet || _seenSheets.has(sheet)) continue;
      // 跳过自己生成的覆盖层，避免重复收集
      if (sheet.ownerNode && sheet.ownerNode.id === STYLE_ID) { _seenSheets.add(sheet); continue; }
      _seenSheets.add(sheet);
      walkRules(safeRules(sheet), null);
    }
  }

  function safeRules(sheet) {
    try { return sheet.cssRules; } catch (e) { return null; }
  }

  function setOverrideCss(cssText) {
    var el = document.getElementById(STYLE_ID);
    if (!cssText) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = cssText;
  }

  /**
   * 应用全局动画速度倍率。
   * @param {number} mult 1.1 = 比 1.0 快 10%，0.9 = 慢 10%，1.0 = 标准
   */
  function applyAnimationSpeed(mult) {
    mult = Number(mult);
    if (!isFinite(mult) || mult <= 0) mult = 1;
    mult = Math.round(mult * 100) / 100;

    if (mult === 1) { setOverrideCss(''); return; }

    collectAll();
    var css = [];
    for (var i = 0; i < _orig.length; i++) {
      var r = _orig[i];
      var decl = '';
      if (r.ad) decl += 'animation-duration:' + scaleTimes(r.ad, mult) + ';';
      if (r.adel) decl += 'animation-delay:' + scaleTimes(r.adel, mult) + ';';
      if (r.td) decl += 'transition-duration:' + scaleTimes(r.td, mult) + ';';
      if (r.tdel) decl += 'transition-delay:' + scaleTimes(r.tdel, mult) + ';';
      if (!decl) continue;
      if (r.wrap) {
        css.push(r.wrap(r.sel, decl));
      } else {
        css.push(r.sel + '{' + decl + '}');
      }
    }
    setOverrideCss(css.join('\n'));
  }

  window.applyAnimationSpeed = applyAnimationSpeed;

  function boot() {
    // 样式表已就绪后再扫描；store 中有保存值则恢复
    var api = window.electronAPI;
    if (api && api.store && api.store.get) {
      api.store.get('versepc_anim_speed').then(function (v) {
        if (v != null) applyAnimationSpeed(v);
      }).catch(function () {});
    }
  }

  if (document.readyState === 'complete') {
    setTimeout(boot, 300);
  } else {
    window.addEventListener('load', function () { setTimeout(boot, 300); });
  }
})();
