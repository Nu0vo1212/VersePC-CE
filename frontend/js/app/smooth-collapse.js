/* smooth-collapse.js — 折叠卡片（<details>）的真实高度过渡动画
 *
 * <details> 的展开/收起由浏览器原生控制，完全没有过渡，点击时内容会"啪"地跳出来。
 * 本文件接管 summary 的点击：先测量总高度 / 折叠高度，再用显式 height 过渡，
 * 动画结束清除内联样式，不影响内部任何布局。
 *
 * 只影响 <details>，其余折叠面板（下载任务、模组分组等）由 css/motion.css 用
 * height: 0 ↔ auto 的原生插值实现，两者互不干扰。
 */
(function () {
  'use strict';

  var DUR = 320;
  var EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

  function summaryOf(details) {
    for (var i = 0; i < details.children.length; i++) {
      if (details.children[i].tagName === 'SUMMARY') return details.children[i];
    }
    return null;
  }

  function expand(details) {
    var summary = summaryOf(details);
    var collapsedH = summary ? summary.offsetHeight : 0;

    details.open = true;
    var fullH = details.scrollHeight;

    details.style.overflow = 'hidden';
    details.style.height = collapsedH + 'px';
    void details.offsetHeight; // 强制回流，确保起始值被采纳
    details.style.transition = 'height ' + DUR + 'ms ' + EASE;
    details.style.height = fullH + 'px';

    details._scAnimating = true;
    setTimeout(function () {
      details._scAnimating = false;
      details.style.transition = '';
      details.style.height = '';
      details.style.overflow = '';
    }, DUR + 20);
  }

  function collapse(details) {
    var summary = summaryOf(details);
    var collapsedH = summary ? summary.offsetHeight : 0;
    var fullH = details.scrollHeight;

    details.style.overflow = 'hidden';
    details.style.height = fullH + 'px';
    void details.offsetHeight;
    details.style.transition = 'height ' + DUR + 'ms ' + EASE;
    details.style.height = Math.max(0, collapsedH) + 'px';

    details._scAnimating = true;
    setTimeout(function () {
      details.open = false;
      details._scAnimating = false;
      details.style.transition = '';
      details.style.height = '';
      details.style.overflow = '';
    }, DUR + 20);
  }

  function bind(details) {
    if (details.dataset.scBound === '1') return;
    var summary = summaryOf(details);
    if (!summary) return;
    details.dataset.scBound = '1';

    summary.addEventListener('click', function (e) {
      e.preventDefault();
      if (details._scAnimating) return;
      if (details.open) collapse(details);
      else expand(details);
    });
  }

  function scan() {
    var list = document.querySelectorAll('details');
    Array.prototype.forEach.call(list, bind);
  }

  function boot() {
    scan();
    try {
      var mo = new MutationObserver(function () { scan(); });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
