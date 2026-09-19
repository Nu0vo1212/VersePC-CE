/* page-lan-openfrp.js - OpenFrp 联机页 Vue 组件
 * 自 NetTool OpenFrpView 迁移（2026-09-19）：
 *   1. 登录用「远程安全登录」（Curve25519 密钥协商，后端 openfrp.rs 完成）；
 *   2. 隧道启动用简易启动（frpc -u token -p id），必须用 OpenFrp 专用 frpc；
 *   3. 专用 frpc 下载改为显式按钮 → 建「下载任务」进下载页（frp-bridge.js），
 *      下载完成后自动解压安装，不做任何静默下载。
 */
const PageLanOpenfrp = {
  name: 'PageLanOpenfrp',
  data() {
    return {
      auth: { loggedIn: false, username: null, tokenPreview: null },
      loginState: 'idle', // idle | waiting | success
      authUrl: '',
      user: null,
      tunnels: [],
      nodes: [],
      runStatus: [],
      frpc: null,
      loading: false,
      createOpen: false,
      createForm: { name: '', type: 'tcp', node_id: null, local_addr: '127.0.0.1', local_port: '25565', remote_port: 0 },
      editOpen: false,
      editForm: { id: 0, name: '', type: 'tcp', node_id: null, local_addr: '127.0.0.1', local_port: '25565', remote_port: 0 },
      logOpen: false, logTunnel: '', logs: [],
      _unlisten: null, _pollTimer: 0, _uptimeTimer: 0
    };
  },
  computed: {
    F() { return window.VerseFrp; },
    nodeOptions() {
      return this.nodes
        .filter(function (n) { return n.status === 200; })
        .map(function (n) { return { value: n.id, text: n.name + '（ID ' + n.id + '）' + (n.fullyLoaded ? ' · 满载' : '') }; });
    },
    runMap() {
      const m = {};
      this.runStatus.forEach(function (r) { m[r.tunnel] = r; });
      return m;
    },
    frpcReady() { return !!(this.frpc && this.frpc.exists); }
  },
  methods: {
    nodeName(id) {
      const target = this.F.num(id, 0);
      const n = this.nodes.find(function (x) { return x.id === target; });
      return n ? n.name : '节点 ' + (target || '—');
    },
    addrOf(t) {
      const ca = this.F.fmtText(t.connectAddress, '');
      if (!ca) return '—';
      const ty = String(t.proxyType || '');
      if (ty === 'http' || ty === 'https') return ty + '://' + ca.replace(/^https?:\/\//, '');
      return ca;
    },
    async loadAuth() {
      try {
        const r = await this.F.invoke('openfrp_auth_status');
        if (r) this.auth = r;
      } catch (e) { /* ignore */ }
    },
    async refresh() {
      const self = this, g = this.F.guard, inv = this.F.invoke;
      this.loading = true;
      try {
        const u = await g(function () { return inv('openfrp_user_info'); });
        if (u && u.data) self.user = u.data;
        const n = await g(function () { return inv('openfrp_nodes'); });
        if (n && n.data && Array.isArray(n.data.list)) self.nodes = n.data.list;
        const t = await g(function () { return inv('openfrp_tunnel_list'); });
        if (t && t.data && Array.isArray(t.data.list)) self.tunnels = t.data.list;
        const r = await inv('openfrp_run_status').catch(function () { return null; });
        if (r) this.runStatus = r;
        const f = await inv('openfrp_frpc_info').catch(function () { return null; });
        if (f) this.frpc = f;
      } finally { this.loading = false; }
    },
    async startLogin() {
      const self = this;
      let r = null;
      try {
        r = await this.F.invoke('openfrp_login_start');
      } catch (e) { showToast(e && e.message ? e.message : String(e), 'error'); return; }
      if (!r || !r.authorizationUrl) { showToast('未获取到授权链接', 'error'); return; }
      this.authUrl = r.authorizationUrl;
      this.loginState = 'waiting';
      window.bridge.openExternal(r.authorizationUrl);
      this.stopPoll();
      this._pollTimer = setInterval(async function () {
        let pr = null;
        try { pr = await self.F.invoke('openfrp_login_poll'); } catch (e) {
          self.stopPoll(); self.loginState = 'idle';
          showToast(e && e.message ? e.message : String(e), 'error');
          return;
        }
        if (pr && pr.done && pr.status === 'success') {
          self.stopPoll(); self.loginState = 'idle';
          showToast('远程安全登录成功', 'success');
          await self.loadAuth(); await self.refresh();
        } else if (pr && pr.done) {
          self.stopPoll(); self.loginState = 'idle';
          showToast(pr.status === 'timeout' ? '授权已超时（5 分钟），请重新发起' : '授权请求已失效，请重新发起', 'info');
        }
      }, 5000);
    },
    stopPoll() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = 0; } },
    cancelLogin() {
      this.stopPoll();
      this.loginState = 'idle';
      showToast('已取消等待，可随时重新发起', 'info');
    },
    async logout() {
      try { await this.F.invoke('openfrp_logout'); } catch (e) { /* ignore */ }
      this.user = null; this.tunnels = []; this.nodes = []; this.runStatus = [];
      await this.loadAuth();
      showToast('已清除登录状态', 'success');
    },
    async startTunnel(t) {
      if (!this.frpcReady) {
        showToast('启动 OpenFrp 隧道需要先下载专用 frpc（简易启动只有官方客户端支持）', 'error');
        return;
      }
      await this.F.guard(function () { return window.VerseFrp.invoke('openfrp_tunnel_start', { ids: String(t.id), autoRestart: true }); }, '隧道「' + t.proxyName + '」已启动');
      this.refresh();
    },
    async stopTunnel(t) {
      await this.F.guard(function () { return window.VerseFrp.invoke('openfrp_tunnel_stop', { ids: String(t.id) }); }, '隧道「' + t.proxyName + '」已停止');
      this.refresh();
    },
    openCreate() {
      this.createForm = { name: '', type: 'tcp', node_id: this.nodeOptions.length ? this.nodeOptions[0].value : null, local_addr: '127.0.0.1', local_port: '25565', remote_port: 0 };
      this.createOpen = !this.createOpen;
      this.editOpen = false;
    },
    async submitCreate() {
      const f = this.createForm, self = this;
      if (!f.name.trim()) { showToast('请填写隧道名', 'error'); return; }
      if (!f.node_id) { showToast('请选择节点', 'error'); return; }
      const ok = await this.F.guard(function () {
        return self.F.invoke('openfrp_tunnel_create', { name: f.name.trim(), tunnelType: f.type, nodeId: f.node_id, localAddr: f.local_addr, localPort: String(f.local_port), remotePort: Number(f.remote_port) || 0, domainBind: '', forceHttps: false, dataEncrypt: false, dataGzip: false, proxyProtocol: false, custom: '' });
      }, '隧道已创建');
      if (ok !== undefined) { this.createOpen = false; this.refresh(); }
    },
    openEdit(t) {
      this.editForm = { id: t.id, name: this.F.fmtText(t.proxyName, ''), type: String(t.proxyType || 'tcp'), node_id: this.F.num(t.nid, 0), local_addr: this.F.fmtText(t.localIp, '127.0.0.1'), local_port: String(t.localPort != null ? t.localPort : ''), remote_port: this.F.num(t.remotePort, 0) };
      this.editOpen = true;
      this.createOpen = false;
    },
    async submitEdit() {
      const f = this.editForm, self = this;
      const ok = await this.F.guard(function () {
        return self.F.invoke('openfrp_tunnel_edit', { proxyId: f.id, name: f.name.trim(), tunnelType: f.type, nodeId: f.node_id, localAddr: f.local_addr, localPort: String(f.local_port), remotePort: Number(f.remote_port) || 0, domainBind: '', forceHttps: false, dataEncrypt: false, dataGzip: false, proxyProtocol: false, custom: '' });
      }, '隧道已更新');
      if (ok !== undefined) { this.editOpen = false; this.refresh(); }
    },
    async removeTunnel(t) {
      if (!confirm('确定删除隧道「' + t.proxyName + '」？此操作不可恢复。')) return;
      await this.F.guard(function () { return window.VerseFrp.invoke('openfrp_tunnel_delete', { proxyId: t.id }); }, '隧道已删除');
      this.refresh();
    },
    copyAddr(t) {
      const a = this.addrOf(t);
      if (a && a !== '—') { navigator.clipboard.writeText(a).then(function () { showToast('已复制联机地址', 'success'); }).catch(function () {}); }
    },
    downloadFrpc() {
      window.VerseFrp.startOpenfrpFrpcDownload();
    },
    async removeFrpc() {
      if (!confirm('确定删除 OpenFrp 专用 frpc？删除后需重新下载才能启动隧道。')) return;
      await this.F.guard(function () { return window.VerseFrp.invoke('openfrp_frpc_remove'); }, '已删除专用 frpc');
      const f = await this.F.invoke('openfrp_frpc_info').catch(function () { return null; });
      if (f) this.frpc = f;
    },
    openLogs(t) {
      const self = this;
      this.logTunnel = String(t.id);
      this.logs = [];
      this.logOpen = true;
      this.F.invoke('openfrp_tunnel_logs', { ids: this.logTunnel }).then(function (r) { if (r) self.logs = r; }).catch(function () {});
      this.stopLogTimer();
      this._logTimer = setInterval(function () {
        self.F.invoke('openfrp_tunnel_logs', { ids: self.logTunnel }).then(function (r) { if (r) self.logs = r; }).catch(function () {});
      }, 2000);
    },
    stopLogTimer() { if (this._logTimer) { clearInterval(this._logTimer); this._logTimer = 0; } },
    closeLogs() { this.logOpen = false; this.stopLogTimer(); }
  },
  mounted() {
    const self = this;
    this._unlisten = window.VerseFrp.onFrpLog('openfrp-log', function (line) {
      if (self.logOpen && line.tunnel === self.logTunnel) {
        self.logs = self.logs.concat([line]).slice(-1000);
      }
    });
    window.addEventListener('frp-frpc-changed', this._onFrpcChanged = function () {
      self.F.invoke('openfrp_frpc_info').then(function (f) { if (f) self.frpc = f; }).catch(function () {});
    });
    const boot = async function () {
      await self.loadAuth();
      if (self.auth.loggedIn) await self.refresh();
      else {
        // 未登录也拉一下 frpc 信息，客户端卡片能显示内置状态
        const f = await self.F.invoke('openfrp_frpc_info').catch(function () { return null; });
        if (f) self.frpc = f;
      }
    };
    boot();
  },
  beforeUnmount() {
    this.stopPoll(); this.stopLogTimer();
    if (this._unlisten) this._unlisten();
    if (this._onFrpcChanged) window.removeEventListener('frp-frpc-changed', this._onFrpcChanged);
  },
  template: `
          <div class="frp-wrap">
            <!-- 本地客户端（登录前后都可见） -->
            <div class="frp-card">
              <div class="frp-card-head">
                <span class="frp-card-title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="9" x2="10" y2="9"/><line x1="6" y1="13" x2="10" y2="13"/><line x1="14" y1="15" x2="18" y2="15"/></svg>
                  OpenFrp 专用 frpc
                </span>
                <span v-if="frpcReady" class="frp-badge frp-badge--ok">已安装 · {{ frpc.version }}</span>
                <span v-else class="frp-badge frp-badge--err">未下载</span>
              </div>
              <p class="frp-card-hint">OpenFrp 的简易启动（-u -p）只有官方专用 frpc 支持，内置标准 frpc 无法启动 OpenFrp 隧道。下载会作为一条<b>下载任务</b>在「下载」页进行，完成后自动解压安装。</p>
              <div class="frp-row">
                <button v-if="!frpcReady" class="btn btn-primary btn-sm" @click="downloadFrpc()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  下载专用 frpc
                </button>
                <template v-else>
                  <button class="btn btn-secondary btn-sm" @click="downloadFrpc()">重新下载</button>
                  <button class="btn btn-secondary btn-sm" style="color:#dc2626" @click="removeFrpc()">删除</button>
                </template>
              </div>
            </div>

            <!-- 未登录 -->
            <div v-if="!auth.loggedIn" class="frp-card" style="max-width:560px;margin:0 auto;width:100%">
              <div class="frp-card-head">
                <span class="frp-card-title">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 0 1 0 10h-3"/><path d="M9 17H6a5 5 0 0 1 0-10h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                  OpenFrp 远程安全登录
                </span>
              </div>
              <p class="frp-card-hint">官方推荐的唯一登录方式：本机生成临时密钥，浏览器打开授权页确认后密钥自动回传，全程不在界面上出现明文凭据。登录需要先在 <b>console.openfrp.net</b> 登录过账号。</p>
              <div v-if="loginState === 'waiting'" class="frp-alert">
                <div class="frp-row"><span class="spinner" style="width:16px;height:16px"></span>等待浏览器授权中... 授权页没打开？<a :href="authUrl" target="_blank" rel="noopener" style="color:var(--accent)">手动打开授权页</a></div>
              </div>
              <div class="frp-row" style="margin-top:12px">
                <button v-if="loginState !== 'waiting'" class="btn btn-primary" @click="startLogin()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  远程安全登录
                </button>
                <button v-else class="btn btn-secondary" @click="cancelLogin()">取消等待</button>
              </div>
            </div>

            <!-- 已登录 -->
            <template v-else>
              <!-- 账号概览 -->
              <div class="frp-card">
                <div class="frp-card-head">
                  <span class="frp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    OpenFrp 账号
                  </span>
                  <div class="frp-row" style="gap:8px">
                    <button class="btn btn-secondary btn-sm" :disabled="loading" @click="refresh()">刷新</button>
                    <button class="btn btn-secondary btn-sm" @click="logout()">退出登录</button>
                  </div>
                </div>
                <div class="frp-grid" v-if="user">
                  <div class="frp-stat"><div class="frp-stat-label">用户名</div><div class="frp-stat-value">{{ user.username || '—' }}</div></div>
                  <div class="frp-stat" v-if="user.traffic !== undefined"><div class="frp-stat-label">剩余流量</div><div class="frp-stat-value">{{ F.num(user.traffic, 0) >= 1024 ? (F.num(user.traffic, 0) / 1024).toFixed(2) + ' GiB' : F.num(user.traffic, 0).toFixed(0) + ' MiB' }}</div></div>
                  <div class="frp-stat"><div class="frp-stat-label">凭据</div><div class="frp-stat-value">{{ auth.tokenPreview || '—' }}</div></div>
                </div>
              </div>

              <!-- 隧道列表 -->
              <div class="frp-card">
                <div class="frp-card-head">
                  <span class="frp-card-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 17h16"/><ellipse cx="9" cy="7" rx="5" ry="3"/><ellipse cx="15" cy="17" rx="5" ry="3"/></svg>
                    我的隧道
                  </span>
                  <button class="btn btn-primary btn-sm" @click="openCreate()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    新建隧道
                  </button>
                </div>

                <transition name="frp-collapse">
                <div v-if="createOpen" class="frp-collapse" style="margin-bottom:12px">
                  <div class="frp-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                    <label class="frp-field"><span>节点</span>
                      <select class="select-input" v-model="createForm.node_id">
                        <option v-for="n in nodeOptions" :key="n.value" :value="n.value">{{ n.text }}</option>
                      </select>
                    </label>
                    <label class="frp-field"><span>协议类型</span>
                      <select class="select-input" v-model="createForm.type">
                        <option value="tcp">TCP</option><option value="udp">UDP</option><option value="http">HTTP</option><option value="https">HTTPS</option>
                      </select>
                    </label>
                    <label class="frp-field"><span>本地地址</span><input class="text-input" v-model="createForm.local_addr"></label>
                    <label class="frp-field"><span>本地端口</span><input class="text-input" v-model="createForm.local_port" placeholder="25565"></label>
                    <label class="frp-field" v-if="createForm.type === 'tcp' || createForm.type === 'udp'"><span>远程端口（0 自动）</span><input class="text-input" type="number" v-model="createForm.remote_port" placeholder="0"></label>
                    <label class="frp-field"><span>隧道名</span><input class="text-input" v-model="createForm.name" placeholder="我的 MC 服务器"></label>
                  </div>
                  <div class="frp-row" style="margin-top:10px">
                    <button class="btn btn-primary btn-sm" @click="submitCreate()">创建</button>
                    <button class="btn btn-secondary btn-sm" @click="createOpen = false">取消</button>
                  </div>
                </div>
                </transition>

                <div v-if="tunnels.length" style="display:flex;flex-direction:column;gap:10px">
                  <div v-for="t in tunnels" :key="t.id" class="frp-tunnel" :class="{ 'is-running': runMap[String(t.id)] && runMap[String(t.id)].running }">
                    <div class="frp-tunnel-head">
                      <span class="frp-badge frp-badge--type">{{ t.proxyType }}</span>
                      <span class="frp-tunnel-name">{{ t.proxyName }}</span>
                      <span v-if="runMap[String(t.id)] && runMap[String(t.id)].running" class="frp-badge frp-badge--ok"><span class="frp-dot frp-dot--live"></span>本地运行中 · {{ F.fmtUptime(runMap[String(t.id)].uptimeSecs) }}</span>
                    </div>
                    <div class="frp-tunnel-meta">
                      <span>节点：{{ nodeName(t.nid) }}</span>
                      <span>本地 {{ t.localIp }}:{{ t.localPort }}</span>
                    </div>
                    <div class="frp-tunnel-addr">
                      <code>{{ addrOf(t) }}</code>
                      <button class="btn btn-secondary btn-sm" @click="copyAddr(t)">复制</button>
                    </div>
                    <div class="frp-tunnel-actions">
                      <button v-if="!(runMap[String(t.id)] && runMap[String(t.id)].running)" class="btn btn-primary btn-sm" :disabled="!frpcReady" :title="frpcReady ? '启动隧道' : '需要先下载专用 frpc'" @click="startTunnel(t)">启动</button>
                      <button v-else class="btn btn-secondary btn-sm" @click="stopTunnel(t)">停止</button>
                      <button class="btn btn-secondary btn-sm" @click="openLogs(t)">日志</button>
                      <button class="btn btn-secondary btn-sm" @click="openEdit(t)">编辑</button>
                      <button class="btn btn-secondary btn-sm" style="color:#dc2626" @click="removeTunnel(t)">删除</button>
                    </div>
                  </div>
                </div>
                <div v-else-if="!loading" class="frp-card-hint" style="margin:0">还没有隧道，点右上角「新建隧道」创建一个吧。Minecraft 联机建议选 TCP 协议、本地端口 25565。</div>
                <div v-else class="frp-skeleton"></div>

                <transition name="frp-collapse">
                <div v-if="editOpen" class="frp-collapse" style="margin-top:12px">
                  <div class="frp-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                    <label class="frp-field"><span>节点</span>
                      <select class="select-input" v-model="editForm.node_id">
                        <option v-for="n in nodeOptions" :key="n.value" :value="n.value">{{ n.text }}</option>
                      </select>
                    </label>
                    <label class="frp-field"><span>本地地址</span><input class="text-input" v-model="editForm.local_addr"></label>
                    <label class="frp-field"><span>本地端口</span><input class="text-input" v-model="editForm.local_port"></label>
                    <label class="frp-field" v-if="editForm.type === 'tcp' || editForm.type === 'udp'"><span>远程端口</span><input class="text-input" type="number" v-model="editForm.remote_port"></label>
                  </div>
                  <div class="frp-row" style="margin-top:10px">
                    <button class="btn btn-primary btn-sm" @click="submitEdit()">保存</button>
                    <button class="btn btn-secondary btn-sm" @click="editOpen = false">取消</button>
                  </div>
                </div>
                </transition>
              </div>
            </template>

            <!-- 日志抽屉 -->
            <transition name="frp-drawer">
              <div class="frp-log" v-if="logOpen" @mousedown.self="closeLogs()">
                <div class="frp-log-panel">
                  <div class="frp-log-head">
                    <h4>隧道日志 · {{ logTunnel }}</h4>
                    <button class="btn btn-secondary btn-sm" @click="closeLogs()">&times;</button>
                  </div>
                  <div class="frp-log-body">
                    <div v-if="!logs.length" class="frp-log-empty">暂无日志，启动隧道后这里会实时滚动输出</div>
                    <div v-for="(l, i) in logs" :key="i" class="frp-log-line" :class="'log-' + l.level">{{ l.message }}</div>
                  </div>
                  <div class="frp-log-foot">
                    <button class="btn btn-secondary btn-sm" @click="logs = []">清空显示</button>
                  </div>
                </div>
              </div>
            </transition>
          </div>
  `
};

window.VersePC = window.VersePC || {};
window.VersePC.PageLanOpenfrp = PageLanOpenfrp;
