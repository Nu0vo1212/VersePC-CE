/**
 * @file window-theme.js
 * @description 窗口控制与页面导航 - 窗口最小化/关闭、侧边栏展开收起、页面切换
 *
 * 说明：主题切换统一由 launch-settings.js 的 applyThemeByName() 负责
 * （Vue 个性化卡片 → pickTheme → applyThemeByName）。
 * 这里原先的 switchTheme()/applyCustomAccent() 属于已下线的"自定义强调色"UI 的遗留代码，
 * 它们会把 --accent 以 inline 形式写到 <html> 上、永久压过 themes.css 的主题值，
 * 是"切了黑白主题但颜色不对"的根因，已整体移除。
 */
function browseFolder(type) {
  if (window.electronAPI && window.electronAPI.showOpenDialog) {
    window.electronAPI.showOpenDialog({ properties: ['openDirectory'] }).then(result => {
      if (!result.canceled && result.filePaths.length > 0) {
        if (type === 'target') {
          document.getElementById('setting-target-dir').value = result.filePaths[0];
        }
      }
    }).catch(() => {});
  } else {
    showToast('请手动输入路径', 'info');
  }
}

function updateHomeStats() {
  const el = document.getElementById('stat-installed');
  if (el) el.textContent = installedVersions.length;
}

let isWindowMode = false;
let isWindowMaximized = false;

function setupWindowControls() {
  const windowControls = document.getElementById('window-controls');
  const windowModeCheckbox = document.getElementById('setting-window-mode');

  const isMac = window.electronAPI?.isMac === true;
  if (isMac) {
    document.body.classList.add('is-mac');
  }
  if (windowControls && !isMac) windowControls.style.display = 'flex';

  // 侧边栏展开/收起按钮
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  if (sidebarToggleBtn) {
    let sidebarAnimTimer = null;
    // 动画时长从 CSS 变量 --sidebar-anim-duration 读，保证 JS 的"动画期间"窗口
    // 与 layout.css 里 .sidebar 的 transition 永远一致（改一处即可）
    const readSidebarAnimMs = () => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue('--sidebar-anim-duration').trim();
      const m = /^([\d.]+)(ms|s)$/.exec(v);
      if (!m) return 400;
      return m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
    };
    sidebarToggleBtn.addEventListener('click', () => {
      const willCollapse = !document.body.classList.contains('sidebar-collapsed');
      // body.sidebar-animating：标记"侧栏正在展开/收起"的时间窗。
      // 以前它是用来在动画期间关掉侧栏的 backdrop-filter（每次宽度变化都要重算整屏
      // 模糊，是卡顿主因）；玻璃效果下线后模糊已不存在，这个类现在只作为时间窗标记
      // （动画结束后据此派发一次 resize 让 Vue 重排），不再有对应的 CSS 规则。
      document.body.classList.add('sidebar-animating');
      document.body.classList.toggle('sidebar-collapsed', willCollapse);
      try { localStorage.setItem('versepc_sidebar_collapsed', willCollapse ? '1' : '0'); } catch(e) {}
      if (sidebarAnimTimer) clearTimeout(sidebarAnimTimer);
      sidebarAnimTimer = setTimeout(() => {
        document.body.classList.remove('sidebar-animating');
        // 动画结束后再通知 Vue 布局组件（网格/卡片）按新宽度重排：
        // 放在动画开始时会正好卡在第一帧重算，反而更卡。
        window.dispatchEvent(new Event('resize'));
      }, readSidebarAnimMs() + 120);
    });
    // 恢复上次的收起状态
    try {
      if (localStorage.getItem('versepc_sidebar_collapsed') === '1') {
        document.body.classList.add('sidebar-collapsed');
      }
    } catch(e) {}
  }

  const winBtnMinimize = document.getElementById('win-btn-minimize');
  if (winBtnMinimize) winBtnMinimize.addEventListener('click', () => {
    window.electronAPI.minimize();
  });

  const winBtnMaximize = document.getElementById('win-btn-maximize');
  if (winBtnMaximize) winBtnMaximize.addEventListener('click', () => {
    window.electronAPI.maximize();
  });

  const winBtnRestore = document.getElementById('win-btn-restore');
  if (winBtnRestore) winBtnRestore.addEventListener('click', () => {
    window.electronAPI.maximize();
  });

  const winBtnClose = document.getElementById('win-btn-close');
  if (winBtnClose) winBtnClose.addEventListener('click', () => {
    window.electronAPI.close();
  });

  if (window.electronAPI.onRequestCloseAnimate) {
    window.electronAPI.onRequestCloseAnimate(() => {
      const app = document.getElementById('app');
      if (app && !app.classList.contains('app-closing')) {
        app.classList.add('app-closing');
      }
    });
  }

  window.electronAPI.onWindowStateChanged((data) => {
    isWindowMaximized = data.maximized;
    isWindowMode = !data.fullscreen;
    if (windowModeCheckbox) {
      windowModeCheckbox.checked = isWindowMode;
    }
    updateWindowButtons();
  });

  window.electronAPI.onWindowModeChanged((data) => {
    isWindowMode = data.windowMode;
    isWindowMaximized = data.maximized;
    if (windowModeCheckbox) {
      windowModeCheckbox.checked = data.windowMode;
    }
    updateWindowButtons();
  });

  if (windowModeCheckbox) {
    windowModeCheckbox.addEventListener('change', () => {
      const enabled = windowModeCheckbox.checked;
      isWindowMode = enabled;
      window.electronAPI.setWindowMode(enabled);
      updateWindowButtons();
    });
  }

  window.electronAPI.isFullscreen().then((fullscreen) => {
    isWindowMode = !fullscreen;
    if (windowModeCheckbox) {
      windowModeCheckbox.checked = isWindowMode;
    }
    updateWindowButtons();
  });
}

function setupVersionListClicks() {
  document.addEventListener('click', (e) => {
    // 主页内嵌版本卡片：跳转到独立的"已安装版本"页面
    const homeCard = e.target.closest('.home-current-version-card');
    if (homeCard) {
      navigateToPage('installed-versions');
      return;
    }

    // 齿轮按钮：进入版本设置页（阻止冒泡，不触发卡片选中）
    const settingsBtn = e.target.closest('.version-item-settings-btn');
    if (settingsBtn) {
      e.stopPropagation();
      const versionId = settingsBtn.dataset.versionId;
      const customName = settingsBtn.dataset.customName || '';
      if (versionId) {
        openVersionSettings(versionId, customName || versionId);
      }
      return;
    }

    // 卡片本体（排除其他按钮如"设置""删除"）
    const versionItem = e.target.closest('.version-item-clickable');
    if (versionItem && !e.target.closest('button')) {
      const versionId = versionItem.dataset.versionId;
      const versionUrl = versionItem.dataset.versionUrl || '';
      const versionType = versionItem.dataset.versionType || 'release';
      const isInstalled = versionItem.dataset.installed === 'true';
      const customName = versionItem.dataset.customName || '';

      if (versionId) {
        if (isInstalled) {
          selectLaunchVersion(versionId);
        } else {
          openVersionDetail(versionId, versionUrl, versionType);
        }
      }
    }
  });
}

function updateWindowButtons() {
  const controls = document.getElementById('window-controls');
  const maximizeBtn = document.getElementById('win-btn-maximize');
  const restoreBtn = document.getElementById('win-btn-restore');

  if (!controls || window.electronAPI?.isMac === true) return;

  controls.style.display = 'flex';
  if (isWindowMode) {
    if (isWindowMaximized) {
      maximizeBtn.style.display = 'none';
      restoreBtn.style.display = 'flex';
    } else {
      maximizeBtn.style.display = 'flex';
      restoreBtn.style.display = 'none';
    }
  } else {
    maximizeBtn.style.display = 'flex';
    restoreBtn.style.display = 'none';
  }
}





// ─── 设置子菜单和功能函数 ──────────────────────────────────

function setupSettingsSubmenu() {
}

function switchPage(pageName) {
  const currentPage = document.querySelector('.page.active');
  const target = document.getElementById(`page-${pageName}`);
  if (!target || target === currentPage) return;

  if (currentPage && currentPage.id === 'page-accounts' && _currentDetailAccount) {
    showAccountList();
  }

  if (currentPage) {
    currentPage.style.animation = 'pageOut 0.18s var(--ease-out-expo) forwards';
    setTimeout(() => {
      currentPage.classList.remove('active');
      currentPage.style.animation = '';
      target.classList.add('active');
      target.style.animation = 'pageIn 0.35s var(--ease-out-expo) backwards';
    }, 160);
  } else {
    target.classList.add('active');
    target.style.animation = 'pageIn 0.35s var(--ease-out-expo) backwards';
  }

  previousPage = currentPage?.id?.replace('page-', '') || null;

  // 切到账户页后，先立刻把轮播轨道藏起来（避免页面一可见就以未定位状态露出来），
  // 等页面动画/hidden→visible 完成、尺寸稳定后再定位到中间
  if (pageName === 'accounts' && typeof resetCarouselPosition === 'function') {
    resetCarouselPosition();
    setTimeout(() => resetCarouselPosition(), 450);
    setTimeout(() => resetCarouselPosition(), 900);
  }
}
