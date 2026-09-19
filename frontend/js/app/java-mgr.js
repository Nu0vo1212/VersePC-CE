function setupJavaPage() {
    // 确保 Vue 已挂载 Java 页面模板，否则等下一帧再试
    const refreshBtn = document.getElementById('refresh-java-btn');
    if (!refreshBtn) {
        // Vue 还没渲染完，稍后重试
        setTimeout(setupJavaPage, 100);
        return;
    }
    refreshBtn.addEventListener('click', loadInstalledJava);
    const manualBtn = document.getElementById('add-manual-java-btn');
    if (manualBtn) manualBtn.addEventListener('click', browseManualJava);
    const importArchiveBtn = document.getElementById('import-archive-btn');
    if (importArchiveBtn) importArchiveBtn.addEventListener('click', () => browseImportJava('archive'));
    const importDirBtn = document.getElementById('import-directory-btn');
    if (importDirBtn) importDirBtn.addEventListener('click', () => browseImportJava('directory'));

    loadInstalledJava();
    loadJavaDownloadList();
}

async function loadInstalledJava() {
    const listEl = document.getElementById('installed-java-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading">正在检测Java...</div>';

    try {
        const result = await API.getInstalledJava();

        // 后台仍在检测中，保持"正在检测"并稍后自动刷新
        if (result.detecting) {
            listEl.innerHTML = '<div class="loading">正在检测Java...</div>';
            setTimeout(loadInstalledJava, 2000);
            return;
        }

        const currentPath = (result.currentJavaPath || '').toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

        if (result.java.length === 0) {
            listEl.innerHTML = '<div class="hint">未检测到已安装的Java</div>';
            return;
        }

        listEl.innerHTML = result.java.map((j, idx) => {
            const normalizedPath = (j.path || '').toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
            const isCurrent = currentPath && normalizedPath === currentPath;

            let sourceLabel = '系统';
            let sourceClass = 'system';
            if (j.source === 'bundled') { sourceLabel = '内置'; sourceClass = 'bundled'; }
            else if (j.source === 'manual') { sourceLabel = '手动'; sourceClass = 'manual'; }
            else if (j.source === 'imported') { sourceLabel = '导入'; sourceClass = 'imported'; }

            return `
            <div class="java-item" data-java-index="${idx}">
                <div class="java-item-info">
                    <div class="java-version">
                        Java ${j.majorVersion} (${j.version})
                        <span class="java-badge ${sourceClass}">${sourceLabel}</span>
                        ${j.isJdk ? '<span class="java-badge jdk">JDK</span>' : '<span class="java-badge jre">JRE</span>'}
                        ${j.is64Bit ? '<span class="java-badge arch">64位</span>' : '<span class="java-badge arch">32位</span>'}
                        ${isCurrent ? '<span class="java-badge current">当前使用</span>' : ''}
                    </div>
                    <div class="java-path">${escapeHtml(j.path)}</div>
                </div>
                <div class="java-item-actions">
                    ${j.source === 'bundled' ? `<button class="btn btn-danger btn-sm java-delete-btn" data-java-index="${idx}">删除</button>` : ''}
                    ${(j.source === 'manual' || j.source === 'imported') ? `<button class="btn btn-danger btn-sm java-remove-custom-btn" data-java-index="${idx}">${j.source === 'imported' ? '移除并删文件' : '移除'}</button>` : ''}
                </div>
            </div>
            `;
        }).join('');

        listEl._javaData = result.java;
        listEl._currentJavaPath = result.currentJavaPath || '';
    } catch (e) {
        listEl.innerHTML = '<div class="hint">检测Java失败</div>';
    }
}

/* 手动添加 Java：弹出文件选择器，选 java.exe */
async function browseManualJava() {
    if (!window.electronAPI || !window.electronAPI.showOpenDialog) {
        showToast('当前环境不支持文件选择器', 'error');
        return;
    }
    try {
        const isWin = navigator.platform.toLowerCase().includes('win');
        const result = await window.electronAPI.showOpenDialog({
            title: '选择 Java 可执行文件',
            properties: ['openFile'],
            filters: isWin
                ? [{ name: 'Java 可执行文件', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }]
                : [{ name: '所有文件', extensions: ['*'] }]
        });
        if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) return;
        const javaPath = result.filePaths[0];

        showToast('正在验证 Java...', 'info');
        const r = await API.addManualJava(javaPath);
        if (r.success) {
            showToast(r.message, 'success');
            await loadInstalledJava();
        } else {
            showToast(r.message || '添加失败', 'error');
        }
    } catch (e) {
        showToast('添加失败: ' + (e.message || '未知错误'), 'error');
    }
}

/* 导入 Java：type='archive' 选压缩包，type='directory' 选文件夹 */
async function browseImportJava(type) {
    if (!window.electronAPI || !window.electronAPI.showOpenDialog) {
        showToast('当前环境不支持文件选择器', 'error');
        return;
    }

    let result;
    if (type === 'archive') {
        result = await window.electronAPI.showOpenDialog({
            title: '选择 Java 压缩包（.zip）',
            properties: ['openFile'],
            filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }, { name: '所有文件', extensions: ['*'] }]
        });
    } else {
        result = await window.electronAPI.showOpenDialog({
            title: '选择 Java 安装目录（包含 bin 文件夹的根目录）',
            properties: ['openDirectory']
        });
    }

    if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const sourcePath = result.filePaths[0];

    // 启动导入并轮询进度
    try {
        const r = await API.importJava(type, sourcePath);
        if (!r.sessionId) {
            showToast('启动导入失败', 'error');
            return;
        }
        showToast('开始导入 Java...', 'info');
        startImportPolling(r.sessionId);
    } catch (e) {
        showToast('启动导入失败: ' + (e.message || '未知错误'), 'error');
    }
}

let javaImportPollTimer = null;
function startImportPolling(sessionId) {
    const card = document.getElementById('java-import-progress');
    const fill = document.getElementById('java-import-fill');
    const text = document.getElementById('java-import-text');
    const msg = document.getElementById('java-import-message');
    if (card) card.style.display = 'block';
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '0%';
    if (msg) msg.textContent = '准备导入...';

    if (javaImportPollTimer) clearInterval(javaImportPollTimer);
    javaImportPollTimer = setInterval(async () => {
        try {
            const status = await API.getJavaImportStatus(sessionId);
            if (fill && typeof status.progress === 'number') fill.style.width = status.progress + '%';
            if (text && typeof status.progress === 'number') text.textContent = status.progress + '%';
            if (msg) msg.textContent = status.message || '处理中...';

            if (status.status === 'completed') {
                clearInterval(javaImportPollTimer);
                javaImportPollTimer = null;
                showToast(status.message || '导入成功', 'success');
                setTimeout(() => { if (card) card.style.display = 'none'; loadInstalledJava(); }, 1500);
            } else if (status.status === 'error') {
                clearInterval(javaImportPollTimer);
                javaImportPollTimer = null;
                showToast('导入失败: ' + (status.message || '未知错误'), 'error');
            }
        } catch (e) {
            console.error('轮询导入状态失败:', e);
        }
    }, 500);
}

/* 设为当前使用 */
async function setCurrentJava(javaPath) {
    try {
        const r = await API.setCurrentJava(javaPath);
        if (r.success) {
            showToast(r.message || '已设为当前 Java', 'success');
            await loadInstalledJava();
        } else {
            showToast(r.message || '设置失败', 'error');
        }
    } catch (e) {
        showToast('设置失败: ' + (e.message || '未知错误'), 'error');
    }
}

/* 移除自定义 Java */
async function removeCustomJava(javaHome, source) {
    if (!javaHome) {
        showToast('缺少 Java 路径信息', 'error');
        return;
    }
    const isImported = source === 'imported';
    const confirmMsg = isImported
        ? `确定要移除这个导入的 Java 吗？\n\n将同时删除导入的文件目录：${javaHome}\n\n此操作不可撤销！`
        : `确定要从列表中移除这个手动添加的 Java 吗？\n\n仅移除列表记录，不会删除原文件：${javaHome}`;
    const confirmed = await showConfirmDialog('移除 Java', confirmMsg, '确定移除', '取消');
    if (!confirmed) return;

    try {
        const r = await API.removeCustomJava(javaHome, isImported);
        if (r.success) {
            showToast(r.message || '已移除', 'success');
            await loadInstalledJava();
        } else {
            showToast(r.message || '移除失败', 'error');
        }
    } catch (e) {
        showToast('移除失败: ' + (e.message || '未知错误'), 'error');
    }
}

document.addEventListener('click', function(e) {
    // 删除（内置 Java）
    const deleteBtn = e.target.closest('.java-delete-btn');
    if (deleteBtn) {
        const idx = parseInt(deleteBtn.dataset.javaIndex, 10);
        const listEl = document.getElementById('installed-java-list');
        if (!listEl || !listEl._javaData || !listEl._javaData[idx]) return;
        const j = listEl._javaData[idx];
        deleteJava(j.javaHome, j.majorVersion);
        return;
    }

    // 移除自定义 Java（手动添加或导入）
    const removeCustomBtn = e.target.closest('.java-remove-custom-btn');
    if (removeCustomBtn) {
        const idx = parseInt(removeCustomBtn.dataset.javaIndex, 10);
        const listEl = document.getElementById('installed-java-list');
        if (!listEl || !listEl._javaData || !listEl._javaData[idx]) return;
        const j = listEl._javaData[idx];
        removeCustomJava(j.javaHome, j.source);
        return;
    }
});

async function deleteJava(javaHome, majorVersion) {
    if (!javaHome) {
        showToast('缺少Java路径信息', 'error');
        return;
    }
    const confirmed = await showConfirmDialog('删除 Java', `确定要删除 Java ${majorVersion} 吗？\n\n将删除: ${javaHome}\n\n此操作不可撤销！`, '删除', '取消');
    if (!confirmed) return;
    
    try {
        const result = await API.deleteJava(javaHome);
        if (result.success) {
            showToast(result.message || 'Java已删除', 'success');
            await loadInstalledJava();
        } else {
            showToast(result.message || '删除失败', 'error');
        }
    } catch (e) {
        showToast('删除Java失败: ' + (e.message || '未知错误'), 'error');
    }
}

async function loadJavaDownloadList() {
    const listEl = document.getElementById('java-download-list');
    listEl.innerHTML = '<div class="loading">正在获取Java版本列表...</div>';
    
    try {
        const result = await API.getJavaList();
        
        if (!result.versions || result.versions.length === 0) {
            listEl.innerHTML = '<div class="hint">无法获取Java版本列表，请检查网络后重试<button class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="loadJavaDownloadList()">重试</button></div>';
            return;
        }
        
        listEl.innerHTML = result.versions.map(j => `
            <div class="java-download-item">
                <div class="java-download-version">Java ${j.majorVersion}</div>
                <div class="java-download-info">版本: ${j.version}</div>
                <button class="btn btn-primary" onclick="downloadJava(${j.majorVersion})">下载</button>
            </div>
        `).join('');
    } catch (e) {
        listEl.innerHTML = '<div class="hint">获取Java版本列表失败: ' + escapeHtml(e.message || '网络错误') + ' <button class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="loadJavaDownloadList()">重试</button></div>';
    }
}

let javaDownloadSessionId = null;
let javaDownloadPollTimer = null;
let javaDownloadProgressHistory = [];

/* 下载 Java：创建后端下载会话后挂到下载任务列表（dlManager），进度在下载工具里查看 */
async function downloadJava(majorVersion) {
    try {
        const result = await API.downloadJava(majorVersion);
        javaDownloadSessionId = result.sessionId;
        javaDownloadProgressHistory = [];

        const taskId = 'java-' + result.sessionId;
        dlManager.add(taskId, 'Java ' + majorVersion + ' 运行环境', 'java', result.sessionId, '');

        if (javaDownloadPollTimer) clearInterval(javaDownloadPollTimer);
        javaDownloadPollTimer = setInterval(() => pollJavaDownloadStatus(taskId), 500);

        showToast('已加入下载任务：Java ' + majorVersion, 'info');
    } catch (e) {
        showToast('启动下载失败: ' + e.message, 'error');
    }
}

async function pollJavaDownloadStatus(taskId) {
    if (!javaDownloadSessionId) {
        if (javaDownloadPollTimer) { clearInterval(javaDownloadPollTimer); javaDownloadPollTimer = null; }
        return;
    }
    // 任务被用户从下载列表移除后停止轮询
    if (!dlManager.tasks.has(taskId)) {
        if (javaDownloadPollTimer) { clearInterval(javaDownloadPollTimer); javaDownloadPollTimer = null; }
        javaDownloadSessionId = null;
        return;
    }

    try {
        const status = await API.getJavaDownloadStatus(javaDownloadSessionId);
        const now = Date.now();

        let msg = status.message || '处理中...';
        javaDownloadProgressHistory.push({ time: now, progress: status.progress || 0 });
        if (javaDownloadProgressHistory.length > 20) javaDownloadProgressHistory.shift();

        if (status.progress > 0 && status.progress < 100 && javaDownloadProgressHistory.length >= 2) {
            const oldest = javaDownloadProgressHistory[0];
            const elapsed = (now - oldest.time) / 1000;
            const progressDelta = status.progress - oldest.progress;
            if (elapsed > 0 && progressDelta > 0) {
                const remaining = (100 - status.progress) / (progressDelta / elapsed);
                if (remaining > 0 && remaining < 86400) {
                    msg += ' · 剩余 ' + formatDuration(remaining);
                }
            }
        }

        const files = [];
        if (status.speed && status.speed > 0) {
            files.push({ name: '下载速度: ' + formatSpeed(status.speed), progress: 0, status: 'downloading' });
        }
        if (status.downloadedBytes || status.totalBytes) {
            let sizeText = formatSize(status.downloadedBytes || 0);
            if (status.totalBytes) sizeText += ' / ' + formatSize(status.totalBytes);
            files.push({ name: '已下载 ' + sizeText, progress: status.progress || 0, status: 'downloading' });
        }

        dlManager.update(taskId, {
            progress: status.progress || 0,
            status: 'downloading',
            message: msg,
            files: files
        });

        if (status.status === 'completed') {
            if (javaDownloadPollTimer) { clearInterval(javaDownloadPollTimer); javaDownloadPollTimer = null; }
            javaDownloadSessionId = null;
            dlManager.update(taskId, { progress: 100, status: 'completed', message: 'Java 安装成功，环境变量已自动配置', files: [] });
            showToast('Java 安装成功！环境变量已自动配置', 'success');
            loadInstalledJava();
        } else if (status.status === 'error') {
            if (javaDownloadPollTimer) { clearInterval(javaDownloadPollTimer); javaDownloadPollTimer = null; }
            javaDownloadSessionId = null;
            dlManager.update(taskId, { status: 'failed', message: '安装失败: ' + (status.message || '未知错误'), files: [] });
            showToast('安装失败: ' + (status.message || '未知错误'), 'error');
        } else if (status.status === 'cancelled') {
            if (javaDownloadPollTimer) { clearInterval(javaDownloadPollTimer); javaDownloadPollTimer = null; }
            javaDownloadSessionId = null;
            dlManager.update(taskId, { status: 'failed', message: '下载已取消', files: [] });
        }
    } catch (e) {
        console.error('轮询Java下载状态失败:', e);
    }
}
