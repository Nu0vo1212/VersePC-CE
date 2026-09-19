async function loadSettings() {
    try {
        const settings = await API.getSettings();
        const sv = (id, fallback) => { const el = document.getElementById(id); if (el) return el; return { value: fallback, checked: !!fallback, textContent: String(fallback) }; };

        sv('setting-java-path').value = settings.javaPath || '';
        sv('setting-max-memory').value = settings.maxMemory || 4096;
        sv('setting-min-memory').value = settings.minMemory || 1024;
        sv('setting-version-isolation').checked = settings.versionIsolation !== false;
        sv('setting-fullscreen').checked = !!settings.fullscreen;
        sv('setting-resolution').value = settings.resolution || '1920x1080';
        sv('setting-java-args').value = settings.javaArgs || '';
        sv('setting-close-on-launch').checked = !!settings.closeOnLaunch;
        sv('setting-auto-update').checked = settings.autoUpdate !== false;

        let downloadSourceValue = settings.downloadSource || 'china-first';
        if (downloadSourceValue === 'bmclapi') downloadSourceValue = 'china-first';
        sv('setting-download-source').value = downloadSourceValue;
        sv('setting-version-source').value = settings.versionSource || 'auto';
        const maxThreads = settings.maxThreads || 64;
        sv('setting-max-threads').value = maxThreads;
        const threadCountEl = document.getElementById('thread-count-value');
        if (threadCountEl) threadCountEl.textContent = maxThreads;
        const enableChunkEl = document.getElementById('setting-enable-chunk-download');
        if (enableChunkEl) enableChunkEl.checked = settings.enableChunkDownload !== false;
        const maxChunksEl = document.getElementById('setting-max-chunks-per-file');
        if (maxChunksEl) {
            const maxChunks = settings.maxChunksPerFile || 64;
            maxChunksEl.value = maxChunks;
            const chunkLabel = document.getElementById('chunk-count-value');
            if (chunkLabel) chunkLabel.textContent = maxChunks;
        }
        const speedLimit = settings.speedLimit || 0;
        sv('setting-speed-limit').value = speedLimit;
        updateSpeedLimitLabel(speedLimit);
        sv('setting-target-dir').value = settings.targetDir || '';
        sv('setting-ssl-verify').checked = !!settings.sslVerify;

        sv('setting-mod-source').value = settings.modSource || 'modrinth';
        sv('setting-filename-format').value = settings.filenameFormat || 'default';
        sv('setting-mod-style').value = settings.modStyle || 'title';
        sv('setting-ignore-quilt').checked = !!settings.ignoreQuilt;

        // 主题：统一走 applySavedTheme()，以 store 单项键 versepc_theme 为准。
        // 这里只把 settings.theme 当作旧版残留字段传进去做一次性迁移，
        // 绝不再直接用它覆盖 data-theme —— 那会让"刚选的主题重启后翻回旧值"。
        if (typeof applySavedTheme === 'function') {
            await applySavedTheme({ legacyTheme: settings.theme });
        }
    } catch (e) { console.error('[Settings] Failed to load settings:', e); }
}

function updateSpeedLimitLabel(value) {
    const el = document.getElementById('speed-limit-value');
    if (el) {
        el.textContent = value === 0 ? '无限制' : value + ' MB/s';
    }
}

async function saveCurrentSettings() {
    const g = (id) => document.getElementById(id);
    const settings = {
        javaPath: g('setting-java-path')?.value || '',
        maxMemory: parseInt(g('setting-max-memory')?.value || '2048', 10),
        minMemory: parseInt(g('setting-min-memory')?.value || '256', 10),
        versionIsolation: g('setting-version-isolation')?.checked || false,
        fullscreen: g('setting-fullscreen')?.checked || false,
        resolution: g('setting-resolution')?.value || '',
        javaArgs: g('setting-java-args')?.value || '',
        closeOnLaunch: g('setting-close-on-launch')?.checked || false,
        autoUpdate: g('setting-auto-update')?.checked || false,

        downloadSource: g('setting-download-source')?.value || 'china-first',
        versionSource: g('setting-version-source')?.value || 'mojang',
        maxThreads: parseInt(g('setting-max-threads')?.value || '64', 10),
        enableChunkDownload: g('setting-enable-chunk-download') ? g('setting-enable-chunk-download').checked : true,
        maxChunksPerFile: g('setting-max-chunks-per-file') ? parseInt(g('setting-max-chunks-per-file').value, 10) : 64,
        speedLimit: parseInt(g('setting-speed-limit')?.value || '0', 10),
        targetDir: g('setting-target-dir')?.value || '',
        sslVerify: g('setting-ssl-verify')?.checked || false,

        modSource: g('setting-mod-source')?.value || 'modrinth',
        filenameFormat: g('setting-filename-format')?.value || '',
        modStyle: g('setting-mod-style')?.value || '',
        ignoreQuilt: g('setting-ignore-quilt')?.checked || false
        // 不再写 accentColor：该字段是已下线的"自定义强调色"UI 留下的历史遗留项，
        // 留着只会让 #custom-accent-color 不存在时被写成 '#ffffff'，进而污染浅色主题的强调色。
    };
    try {
        await API.saveSettings(settings);
        showToast('设置已保存', 'success');
    } catch (e) {
        showToast('保存设置失败', 'error');
    }
}
