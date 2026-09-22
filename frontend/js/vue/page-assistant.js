/* page-assistant.js - 「Verse 助手」页 Vue 组件
 * 原则：
 *   1. 模板只做编排，业务逻辑全在 js/app/assistant.js（window.VerseAssistant）
 *      与工具层 js/app/ai-tools.js（window.VerseAITools）
 *   2. CSS 全部来自 css/assistant.css，类名统一 va- 前缀
 *   3. 会话数据本地持久化（localStorage），刷新/重启后仍在
 *   4. AI 配置就在本页：右上角模型按钮可换模型，左下角「AI 配置」开设置面板
 *
 * ⚠ 三个踩过的坑，改模板时务必守住：
 *   a) 逐字上屏必须改「响应式代理」，不能改原始对象（Vue 3 不追踪原始对象的写入）
 *      —— 统一走 pushMsg() 拿返回值，它就是代理。
 *   b) 同一父节点下 v-if / v-else 若标签相同、class 又是静态的，Vue 会原地复用元素，
 *      分支切换时 patchFlag 为 0 → 属性不会被重打（表现为按钮/正文状态卡住）。
 *      所以：要么用「不同标签」，要么用「单元素 + 动态 :class」，要么用 v-show。
 *   c) 工具卡片的执行 Promise 存在组件实例的 Map 里（_toolWaiters），
 *      **不能**挂在响应式消息对象上 —— 函数会被 JSON.stringify 丢掉/报错。
 */
const PageAssistant = {
  template: `
    <div class="va-shell" :class="{ 'va-shell--side-hidden': !showSide }">
      <!-- ============ 左：会话列表 ============ -->
      <aside class="va-side">
        <div class="va-side-head">
          <button class="va-new-btn" @click="newChat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>新建对话</span>
          </button>
        </div>
        <div class="va-side-label">历史对话</div>
        <div class="va-convo-list">
          <div v-for="c in orderedConvos" :key="c.id" class="va-convo" :class="{ 'is-active': c.id === activeId }" @click="selectConvo(c.id)">
            <span class="va-convo-title" :title="c.title">{{ c.title }}</span>
            <button class="va-convo-del" title="删除这条对话" @click.stop="deleteConvo(c.id)">&times;</button>
          </div>
          <div v-if="!convos.length" class="va-side-empty">还没有历史对话</div>
        </div>
        <div class="va-side-foot">
          <div class="va-model" :class="{ 'is-off': !cfg.ok }" :title="cfg.ok ? cfg.label : cfg.hint">
            <span class="va-model-dot"></span>
            <span class="va-model-name">{{ cfg.label }}</span>
          </div>
          <button class="va-side-btn" :class="{ 'is-active': settingsOpen }" @click="openSettings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.6 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <span>AI 配置</span>
          </button>
        </div>
      </aside>

      <!-- ============ 右：聊天区 ============ -->
      <section class="va-main">
        <header class="va-head">
          <button class="va-icon-btn" title="显示 / 隐藏会话列表" @click="showSide = !showSide">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <div class="va-head-title">
            <span class="va-head-name"><span class="va-dot"></span>Verse 助手</span>
            <span class="va-head-sub">{{ toolsReady ? '能直接帮你操作启动器 · 只回答 VersePC / Minecraft 相关问题' : '只回答 VersePC / Minecraft 相关问题' }}</span>
          </div>
          <div class="va-head-actions">
            <!-- 模型切换 / 保存 -->
            <div class="va-model-switch" ref="modelSwitch">
              <button class="va-model-btn" :title="cfg.ok ? '当前模型：' + cfg.model + '，点击切换' : (cfg.hint || '未配置 AI')" @click="toggleModelMenu">
                <svg class="va-model-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
                <span class="va-model-btn-text">{{ cfg.model || '未选择模型' }}</span>
                <svg class="va-model-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div class="va-model-menu" v-show="modelMenuOpen">
                <div class="va-model-menu-head">
                  <span>{{ cfg.ok ? cfg.providerName : '未配置 AI' }}</span>
                  <span v-if="cfg.ok" class="va-model-menu-hint">与模组汉化共用</span>
                </div>
                <div class="va-model-menu-list" v-if="modelOptions.length">
                  <button v-for="mo in modelOptions" :key="mo.id" class="va-model-item" :class="{ 'is-active': mo.id === cfg.model }" :data-model-id="mo.id" @click="pickModel(mo.id)">
                    <span class="va-model-item-name">{{ mo.name }}</span>
                    <span v-if="mo.free" class="va-model-tag">免费</span>
                    <span v-if="mo.id === cfg.model" class="va-model-check">✓</span>
                  </button>
                </div>
                <!-- 提示只看「供应商有没有预设模型」，不看列表是否为空：
                     已存的模型会被并进上面的列表，两者可以同时出现 -->
                <div v-if="!hasPresets" class="va-model-menu-empty">当前供应商没有预设模型，请在下面手动填写模型 ID</div>
                <div class="va-model-custom">
                  <input class="va-model-input" v-model="customModel" placeholder="自定义模型 ID" @keydown.enter.exact.prevent="saveCustomModel" />
                  <button class="va-model-save" :disabled="!customModel.trim()" @click="saveCustomModel">保存</button>
                </div>
                <div class="va-model-menu-foot">
                  <span class="va-model-flash" v-show="modelFlash">{{ modelFlash }}</span>
                  <button class="va-model-link" @click="openSettings">完整 AI 配置 →</button>
                </div>
              </div>
            </div>
            <button class="va-icon-btn" title="清空当前对话" :disabled="!hasMessages" @click="clearCurrent">清空</button>
          </div>
        </header>

        <div class="va-scroll" ref="scroll">
          <!-- 空态（用 section 而不是 div：与下方 .va-msgs 标签不同，避免 v-if/v-else 原地复用） -->
          <section v-if="!hasMessages && !thinking" class="va-welcome">
            <div class="va-welcome-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-assistant"/></svg>
            </div>
            <h3>你好，我是 Verse 助手</h3>
            <p>我住在 VersePC-CE 里，只负责启动器和 Minecraft 的事——而且**能直接动手**：查版本、看模组、读崩溃日志、切页面、开文件夹，你确认后还能帮你装模组、启动游戏。<br>点下面的问题直接开始，或者在下面输入你自己的问题。</p>
            <div class="va-chips">
              <button v-for="(s, si) in suggestions" :key="si" class="va-chip" :style="{ animationDelay: (si * 45) + 'ms' }" @click="ask(s.q)">{{ s.label }}</button>
            </div>
          </section>

          <!-- 消息流 -->
          <div v-else class="va-msgs">
            <div v-for="(m, i) in currentMessages" :key="i"
                 class="va-msg"
                 :class="['va-msg--' + m.role, { 'va-msg--error': m.error, 'va-msg--last': i === currentMessages.length - 1 }]">
              <div class="va-avatar">
                <svg v-if="m.role === 'assistant'" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-assistant"/></svg>
                <span v-else>我</span>
              </div>
              <div class="va-bubble" :class="{ 'va-bubble--thinking': isThinkingMsg(m) }">
                <!-- 工具调用卡片：先执行、后正文，顺序符合直觉 -->
                <div v-if="m.tools && m.tools.length" class="va-tools">
                  <!-- 一条消息里攒了多个待确认操作 → 给一次性的批处理，不用一张张点 -->
                  <div v-if="pendingCount(m) > 1" class="va-tools-batch">
                    <span class="va-tools-batch-text">{{ pendingCount(m) }} 个操作待你确认</span>
                    <button class="va-tool-run" @click="runAllPending(m)">全部执行</button>
                    <button class="va-tool-skip" @click="cancelAllPending(m)">全部取消</button>
                  </div>
                  <div v-for="(t, ti) in m.tools" :key="t.id || ti" class="va-tool" :class="'is-' + t.status">
                    <div class="va-tool-icon">
                      <svg v-if="t.status === 'done'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      <svg v-else-if="t.status === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg>
                      <svg v-else-if="t.status === 'cancelled' || t.status === 'expired'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                      <svg v-else-if="t.status === 'await'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <span v-else class="va-tool-spin"></span>
                    </div>
                    <div class="va-tool-main">
                      <div class="va-tool-label">{{ t.label || t.name }}</div>
                      <!-- 待确认时把关键参数摊开，用户不用猜要执行的是什么 -->
                      <div v-if="t.status === 'await' && toolArgsText(t)" class="va-tool-args">{{ toolArgsText(t) }}</div>
                      <div v-if="t.result" class="va-tool-result">{{ toolShort(t) }}</div>
                    </div>
                    <div v-if="t.status === 'running' && elapsedText(t)" class="va-tool-time">{{ elapsedText(t) }}</div>
                    <div v-if="t.status === 'await'" class="va-tool-actions">
                      <button class="va-tool-run" @click="runPendingTool(m, t)">执行</button>
                      <button class="va-tool-skip" @click="cancelPendingTool(m, t)">取消</button>
                    </div>
                  </div>
                </div>

                <!-- 助手正文：流式用 p，完成用 div（标签不同 → 分支切换一定重建元素）
                     思考中 → 动画直接放在气泡内部，不再单独占一行，也不重复头像 -->
                <template v-if="m.role === 'assistant'">
                  <div v-if="isThinkingMsg(m)" class="va-thinking">
                    <span class="va-thinking-dots"><i></i><i></i><i></i></span>
                    <span class="va-thinking-text">正在思考</span>
                  </div>
                  <p v-else-if="m.streaming" class="va-plain va-plain--stream">{{ m.content }}<span class="va-caret"></span></p>
                  <div v-else-if="m.content" class="va-md" v-html="md(m)"></div>
                  <p v-else-if="!m.tools || !m.tools.length" class="va-plain va-plain--muted">（空回复）</p>
                </template>
                <p v-else class="va-plain">{{ m.content }}</p>

                <!-- 消息操作 -->
                <div v-if="m.role === 'assistant' && !m.streaming && !m.error && !hasPendingTool(m)" class="va-msg-tools">
                  <button :class="{ 'is-ok': copiedIdx === i }" @click="copyMsg(i, m)">{{ copiedIdx === i ? '已复制' : '复制' }}</button>
                  <button v-if="i === currentMessages.length - 1 && !busy" @click="regenerate">重新生成</button>
                </div>
              </div>
            </div>

            <!-- 思考态不再单起一行：动画已并入当前这条 assistant 气泡内部，
                 避免「一个图标 + 一个气泡」的重复出现 -->
          </div>
        </div>

        <!-- 输入区 -->
        <div class="va-compose-wrap">
          <div class="va-compose-inner">
            <div v-if="!cfg.ok" class="va-config-tip">
              <span>{{ cfg.hint || '还没配置 AI，当前只能回答内置的常见问题。' }}</span>
              <button @click="openSettings">去配置</button>
            </div>
            <div class="va-compose">
              <textarea ref="input" class="va-input" rows="1" v-model="input"
                        placeholder="问点 VersePC 或 Minecraft 的事…（Enter 发送，Shift+Enter 换行）"
                        @input="autoGrow"
                        @keydown.enter.exact.prevent="send()"></textarea>
              <!-- 单元素 + 动态 class / 动态图标（v-show），避免 v-if/v-else 原地复用导致状态卡住 -->
              <button class="va-send" :class="{ 'va-send--stop': busy }" :disabled="!busy && !canSend"
                      :title="busy ? '停止' : '发送'" @click="busy ? stop() : send()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <g v-show="!busy"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></g>
                  <rect v-show="busy" x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>
                </svg>
              </button>
            </div>
            <div class="va-foot-hint">
              <span v-if="toolsReady">助手可以直接操作启动器，改状态的操作会先让你确认</span>
              <span v-else>仅回答 VersePC 与 Minecraft 相关问题 · 内容由 AI 生成，仅供参考</span>
            </div>
          </div>
        </div>

        <!-- ============ AI 配置面板（页内抽屉，替代原来的「设置 → 其他 → V 岛 · AI 配置」） ============ -->
        <transition name="va-drawer">
          <div class="va-settings" v-if="settingsOpen" @mousedown.self="closeSettings">
          <div class="va-settings-panel">
            <div class="va-settings-head">
              <div>
                <h4>AI 配置</h4>
                <p>密钥只保存在本机，不会上传到任何服务器。这份配置与模组汉化共用。</p>
              </div>
              <button class="va-settings-close" title="关闭" @click="closeSettings">&times;</button>
            </div>

            <div class="va-settings-body">
              <label class="va-field">
                <span class="va-field-label">供应商</span>
                <select class="va-select" v-model="sf.provider" @change="onProviderChange">
                  <option v-for="p in providerList" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </label>

              <label class="va-field">
                <span class="va-field-label">API Key</span>
                <div class="va-key-row">
                  <input class="va-input-text" :type="sfShowKey ? 'text' : 'password'" v-model="sf.apiKey"
                         placeholder="粘贴你的 API Key" autocomplete="off" spellcheck="false">
                  <button class="va-key-toggle" @click="sfShowKey = !sfShowKey">{{ sfShowKey ? '隐藏' : '显示' }}</button>
                </div>
              </label>

              <label class="va-field">
                <span class="va-field-label">模型</span>
                <input class="va-input-text" v-model="sf.model" :placeholder="sfProvider.isCustom ? '例如 gpt-4o-mini' : '选择或手填模型 ID'" autocomplete="off" spellcheck="false">
                <span class="va-field-hint" v-if="sfPresetModels.length">常用：{{ sfPresetModels.join(' / ') }}</span>
                <span class="va-field-hint" v-else-if="sfProvider.isCustom">自定义供应商没有预设模型，按接口文档填模型 ID</span>
              </label>

              <template v-if="sfProvider.isCustom">
                <label class="va-field">
                  <span class="va-field-label">接口地址</span>
                  <input class="va-input-text" v-model="sf.endpoint" placeholder="https://example.com/v1/chat/completions" autocomplete="off" spellcheck="false">
                </label>
                <label class="va-field">
                  <span class="va-field-label">接口格式</span>
                  <select class="va-select" v-model="sf.apiFormat">
                    <option value="openai">OpenAI 兼容（绝大部分）</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google Gemini</option>
                  </select>
                </label>
              </template>

              <div class="va-field">
                <span class="va-field-label">工具能力</span>
                <div class="va-tools-state" :class="{ 'is-on': toolsReady }">
                  <span class="va-tools-dot"></span>
                  <span v-if="toolsReady">已开启 —— 助手可以查版本 / 读日志 / 切页面 / 开文件夹；装模组、启动游戏这类操作会先弹确认</span>
                  <span v-else>{{ toolsNote }}</span>
                </div>
              </div>

              <div class="va-settings-result" v-show="sfMessage" :class="{ 'is-error': sfError }">{{ sfMessage }}</div>
            </div>

            <div class="va-settings-foot">
              <button class="va-btn va-btn-ghost" :disabled="sfTesting" @click="testConn">{{ sfTesting ? '测试中…' : '测试连接' }}</button>
              <button class="va-btn va-btn-primary" @click="saveSettings">保存配置</button>
            </div>
          </div>
        </div>
        </transition>
      </section>
    </div>
  `,

  data() {
    return {
      convos: [],
      activeId: '',
      input: '',
      thinking: false,
      cfg: { ok: false, label: '未配置 AI', hint: '', model: '', providerName: '' },
      showSide: true,
      copiedIdx: -1,
      suggestions: [],
      modelMenuOpen: false,
      modelOptions: [],
      hasPresets: false,
      customModel: '',
      modelFlash: '',
      toolsReady: false,
      toolsNote: '',
      // AI 配置面板
      settingsOpen: false,
      sfShowKey: false,
      sfTesting: false,
      sfMessage: '',
      sfError: false,
      sf: { provider: 'openai', apiKey: '', model: '', endpoint: '', apiFormat: 'openai' },
      _initialized: false,
      _abort: null,
      _liveMsg: null,
      _runSeq: 0,
      _streamSeq: 0,
      _streamToken: 0,
      _streamMsg: null,
      _streamFull: '',
      _flashTimer: null,
      _onDocDown: null,
      _toolWaiters: null,
      _tickTimer: null,
      _now: Date.now()
    };
  },

  computed: {
    current() {
      return this.convos.find((c) => c.id === this.activeId) || null;
    },
    currentMessages() {
      return (this.current && this.current.messages) || [];
    },
    hasMessages() {
      return this.currentMessages.length > 0;
    },
    orderedConvos() {
      return this.convos.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    busy() {
      return this.thinking || this.currentMessages.some((m) => m.streaming);
    },
    canSend() {
      return !this.busy && !!this.input.trim();
    },
    providerList() {
      const VA = window.VerseAssistant;
      const table = (VA && VA.AI_PROVIDERS) || {};
      return Object.keys(table).map((k) => ({ id: k, name: table[k].name || k }));
    },
    sfProvider() {
      const VA = window.VerseAssistant;
      const p = VA && VA.providerInfo ? VA.providerInfo(this.sf.provider) : null;
      return { isCustom: this.sf.provider === 'custom', info: p };
    },
    sfPresetModels() {
      const p = this.sfProvider.info;
      if (!p || !p.models) return [];
      return p.models.map((m) => m.id);
    }
  },

  mounted() {
    this.init();
    // 供 navigateToPage('assistant') 在进入页面时调用 refresh()
    window.VerseAssistantPage = this;
    // 点击面板外关闭模型菜单
    this._onDocDown = (e) => {
      if (!this.modelMenuOpen) return;
      const box = this.$refs.modelSwitch;
      if (box && !box.contains(e.target)) this.modelMenuOpen = false;
    };
    document.addEventListener('mousedown', this._onDocDown);
  },

  unmounted() {
    if (this._onDocDown) document.removeEventListener('mousedown', this._onDocDown);
    this.stopTick();
  },

  methods: {
    // ---------------- 初始化 ----------------
    init() {
      if (this._initialized) return;
      this._initialized = true;
      if (!this._toolWaiters) this._toolWaiters = new Map();
      // 刷新 / 重开后，落盘时还是「待确认」的卡片已经没人能执行了 —— 标成失效，
      // 否则用户会看到一排永远点不动的「执行 / 取消」按钮。
      this.markExpiredTools();
      const VA = window.VerseAssistant;
      if (!VA) {
        this.cfg = { ok: false, label: '助手未加载', hint: '助手脚本未加载，请重启应用。', model: '', providerName: '' };
        return;
      }
      this.suggestions = VA.SUGGESTIONS;
      const st = VA.load();
      this.convos = st.convos;
      this.activeId = st.activeId;
      this.refreshCfg();
      VA.refreshContext();
      VA.ensureMarked();
      this.refreshToolsState();
    },

    /** 由 navigateToPage 在每次进入本页时调用 */
    refresh() {
      this.init();
      const VA = window.VerseAssistant;
      if (!VA) return;
      this.refreshCfg();
      VA.refreshContext();
      VA.ensureMarked();
      this.refreshToolsState();
      this.scrollBottom();
      this.$nextTick(() => {
        try { if (this.$refs.input) this.$refs.input.focus(); } catch (e) {}
      });
    },

    refreshCfg() {
      const VA = window.VerseAssistant;
      if (!VA) return;
      this.cfg = VA.configStatus();
      this.modelOptions = VA.modelOptions();
      this.hasPresets = typeof VA.hasPresetModels === 'function'
        ? !!VA.hasPresetModels()
        : this.modelOptions.length > 0;
      this.customModel = this.cfg.model || '';
    },

    refreshToolsState() {
      const VA = window.VerseAssistant;
      const hasTools = !!(window.VerseAITools && VA && VA.toolsAvailable && VA.toolsAvailable());
      this.toolsReady = hasTools;
      this.toolsNote = !window.VerseAITools
        ? '工具模块未加载（js/app/ai-tools.js）'
        : (!VA || !VA.isConfigured()
          ? '配置 AI 后可用'
          : '当前供应商不支持工具调用，助手只能给你文字步骤');
    },

    // ---------------- AI 配置面板 ----------------
    openSettings() {
      this.modelMenuOpen = false;
      const VA = window.VerseAssistant;
      if (VA) {
        const c = VA.getAIConfig();
        this.sf = {
          provider: c.provider || 'openai',
          apiKey: c.apiKey || '',
          model: c.model || '',
          endpoint: c.endpoint || '',
          apiFormat: c.apiFormat || 'openai'
        };
        if (this.sf.provider !== 'custom') {
          const p = VA.providerInfo(this.sf.provider);
          if (p && !this.sf.endpoint) this.sf.endpoint = p.endpoint || '';
          if (p && p.models && p.models.length && !this.sf.model) this.sf.model = p.models[0].id;
        }
        this.refreshToolsState();
      }
      this.sfShowKey = false;
      this.sfMessage = '';
      this.sfError = false;
      this.settingsOpen = true;
      this.$nextTick(() => this.scrollBottom());
    },

    closeSettings() {
      this.settingsOpen = false;
    },

    onProviderChange() {
      const VA = window.VerseAssistant;
      if (!VA) return;
      const p = VA.providerInfo(this.sf.provider);
      if (!p) return;
      if (this.sf.provider === 'custom') {
        this.sf.endpoint = this.sf.endpoint || '';
        this.sf.apiFormat = this.sf.apiFormat || 'openai';
      } else {
        this.sf.endpoint = p.endpoint || '';
        this.sf.apiFormat = p.apiFormat || 'openai';
        // 换供应商时模型 ID 一般不通用，用第一个预设模型兜底
        const preset = (p.models || []).map((m) => m.id);
        if (preset.length && preset.indexOf(this.sf.model) === -1) this.sf.model = preset[0];
      }
      this.sfMessage = '';
    },

    /** 收集表单为待保存的配置对象 */
    collectSettings() {
      const c = {
        provider: this.sf.provider,
        apiKey: (this.sf.apiKey || '').trim(),
        model: (this.sf.model || '').trim()
      };
      if (this.sf.provider === 'custom') {
        c.endpoint = (this.sf.endpoint || '').trim();
        c.apiFormat = this.sf.apiFormat || 'openai';
      }
      return c;
    },

    saveSettings() {
      const VA = window.VerseAssistant;
      if (!VA) return;
      const c = this.collectSettings();
      if (!c.provider) { this.sfResult('请选择供应商', true); return; }
      if (!c.apiKey) { this.sfResult('请填写 API Key', true); return; }
      if (!c.model) { this.sfResult('请填写或选择模型', true); return; }
      if (c.provider === 'custom' && !c.endpoint) { this.sfResult('自定义供应商需要填接口地址', true); return; }
      const r = VA.saveConfig(c);
      if (!r.ok) { this.sfResult(r.error || '保存失败', true); return; }
      this.refreshCfg();
      this.refreshToolsState();
      this.sfResult('配置已保存', false);
      this.flash('已保存');
    },

    testConn() {
      const VA = window.VerseAssistant;
      if (!VA || this.sfTesting) return;
      const c = this.collectSettings();
      if (!c.apiKey || !c.model) { this.sfResult('先填好 API Key 和模型再测试', true); return; }
      this.sfTesting = true;
      this.sfResult('正在测试连接…', false);
      VA.testConnection(c).then((r) => {
        this.sfTesting = false;
        if (r.ok) this.sfResult('连接正常，模型回复：' + (r.reply || '(空)'), false);
        else this.sfResult(r.error || '连接失败', true);
      }).catch((e) => {
        this.sfTesting = false;
        this.sfResult('测试失败：' + ((e && e.message) || e), true);
      });
    },

    sfResult(text, isError) {
      this.sfMessage = text;
      this.sfError = !!isError;
    },

    // ---------------- 模型切换 / 保存 ----------------
    toggleModelMenu() {
      this.modelMenuOpen = !this.modelMenuOpen;
      if (this.modelMenuOpen) {
        this.refreshCfg();
        this.modelFlash = '';
      }
    },

    pickModel(id) {
      const VA = window.VerseAssistant;
      const r = VA.setModel(id);
      if (!r.ok) { this.flash(r.error, true); return; }
      this.refreshCfg();
      this.customModel = r.model;
      this.flash('已保存');
    },

    saveCustomModel() {
      const VA = window.VerseAssistant;
      const id = this.customModel.trim();
      if (!id) return;
      const r = VA.setModel(id);
      if (!r.ok) { this.flash(r.error, true); return; }
      this.refreshCfg();
      this.flash('已保存');
    },

    flash(text, isError) {
      this.modelFlash = (isError ? '⚠ ' : '✓ ') + text;
      if (this._flashTimer) clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => { this.modelFlash = ''; }, 2200);
    },

    // ---------------- 会话管理 ----------------
    persist() {
      const VA = window.VerseAssistant;
      if (VA) VA.save(this.convos, this.activeId);
    },

    ensureConvo() {
      let c = this.current;
      if (!c) {
        c = window.VerseAssistant.newConvo();
        this.convos.unshift(c);
        this.activeId = c.id;
        this.persist();
      }
      return c;
    },

    /** 推送消息并返回「响应式代理」——后续改它才会触发重渲染 */
    pushMsg(convo, msg) {
      convo.messages.push(msg);
      return convo.messages[convo.messages.length - 1];
    },

    /** 往消息里追加一张工具卡片，同样要拿「代理」 */
    pushTool(msg, tool) {
      if (!Array.isArray(msg.tools)) msg.tools = [];
      msg.tools.push(tool);
      return msg.tools[msg.tools.length - 1];
    },

    newChat() {
      const existingEmpty = this.convos.find((c) => !c.messages.length);
      if (existingEmpty) {
        this.activeId = existingEmpty.id;
      } else {
        const c = window.VerseAssistant.newConvo();
        this.convos.unshift(c);
        this.activeId = c.id;
      }
      this.persist();
      this.input = '';
      this.autoGrow();
      this.$nextTick(() => {
        try { if (this.$refs.input) this.$refs.input.focus(); } catch (e) {}
      });
    },

    selectConvo(id) {
      this.activeId = id;
      this.persist();
      this.copiedIdx = -1;
      this.scrollBottom();
    },

    deleteConvo(id) {
      const i = this.convos.findIndex((c) => c.id === id);
      if (i === -1) return;
      this.convos.splice(i, 1);
      if (this.activeId === id) {
        const next = this.orderedConvos[0];
        this.activeId = next ? next.id : '';
      }
      this.persist();
    },

    clearCurrent() {
      const c = this.current;
      if (!c || !c.messages.length) return;
      c.messages = [];
      c.title = '新对话';
      c.updatedAt = Date.now();
      this.persist();
    },

    // ---------------- 发送 / 停止 ----------------
    ask(text) {
      this.input = text;
      this.autoGrow();
      this.send();
    },

    async send() {
      const VA = window.VerseAssistant;
      const text = this.input.trim();
      if (!text || this.busy || !VA) return;
      // 本次发送的流水号：点「停止」或又发了一条，都会让这个号失效
      const runToken = ++this._runSeq;

      this.input = '';
      this.autoGrow();

      const convo = this.ensureConvo();
      convo.messages.push({ role: 'user', content: text });
      if (!convo.title || convo.title === '新对话') convo.title = VA.titleFrom(text);
      convo.updatedAt = Date.now();
      this.persist();
      this.scrollBottom();

      // ① 本地闸门：越界 / 提示词注入
      const gated = VA.gate(text);
      if (gated) { this.pushReply(convo, gated.reply); return; }

      // ② 本地实时查询：只保留「不需要模型也准」的两条，其余交给 AI 走工具
      const queried = VA.localQuery(text);
      if (queried) { this.pushReply(convo, queried); return; }

      // ③ 没配 AI：内置常见问题兜底
      if (!VA.isConfigured()) {
        const local = VA.localReply(text);
        this.pushReply(convo, local || (
          '我还没接入 AI，目前只能回答内置的常见问题。\n\n' +
          '想聊得更自由、还想让我直接帮你操作启动器，点左下角 **AI 配置** 填一次即可（这份配置和模组汉化共用）。\n\n' +
          '现在可以直接问我：怎么装模组、光影怎么开、启动崩溃怎么排查、Java 选哪个版本、内存给多少、联机怎么用、文件夹在哪。'
        ));
        return;
      }

      // ④ 走 AI + Agent 循环
      this.thinking = true;
      const signal = { aborted: false };
      this._abort = signal;
      this.scrollBottom();

      // 建一条空的 assistant 消息，工具卡片与正文都挂在它上面
      const msg = this.pushMsg(convo, { role: 'assistant', content: '', streaming: true, tools: [] });
      this._liveMsg = msg;
      await this.$nextTick();

      const messages = VA.buildMessages(convo.messages.filter((m) => !m.error && m.content));
      let res;
      try {
        res = await VA.runAgent(messages, {
          signal,
          onToolCall: (call) => this.handleToolCall(msg, call)
        });
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }

      // 这次发送已经被「停止」或新的发送取代 → 迟到的结果直接丢弃，
      // 否则会把新一轮的「正在思考」状态一起清掉
      if (this._runSeq !== runToken) return;

      if (this._abort === signal) this._abort = null;
      if (this._liveMsg === msg) this._liveMsg = null;
      this.thinking = false;

      if (res.aborted) {
        msg.streaming = false;
        if (!msg.content && (!msg.tools || !msg.tools.length)) {
          const i = convo.messages.indexOf(msg);
          if (i >= 0) convo.messages.splice(i, 1);
        }
        this.persist();
        return;
      }

      if (!res.ok) {
        // 网络 / 额度等问题时，尽量用内置问答救回体验
        msg.streaming = false;
        const local = VA.localReply(text);
        msg.content = local || ('出错了：' + res.error);
        msg.error = !local;
        convo.updatedAt = Date.now();
        this.persist();
        this.scrollBottom();
        return;
      }

      await this.startStream(msg, res.text || '(空回复)');
      convo.updatedAt = Date.now();
      this.persist();
      this.scrollBottom();
    },

    /**
     * 工具调用的执行入口（由 runAgent 调用）。
     * read → 立即执行；write → 先落一张「待确认」卡片，等用户点「执行」。
     * 返回给模型的文本结果。
     */
    handleToolCall(msg, call) {
      const TA = window.VerseAITools;
      const VA = window.VerseAssistant;
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch (e) { args = {}; }
      const write = TA ? TA.isWrite(call.name) : false;
      const tool = this.pushTool(msg, {
        id: call.id,
        name: call.name,
        args: args,
        label: TA ? TA.describe(call.name, args) : call.name,
        write: write,
        status: write ? 'await' : 'running',
        result: ''
      });
      this.scrollBottom();

      return new Promise((resolve) => {
        const runIt = () => {
          tool.status = 'running';
          tool.startedAt = Date.now();
          this._now = Date.now();
          this.startTick();
          this.scrollBottom();
          let p;
          try {
            p = TA ? TA.run(call.name, args) : Promise.reject(new Error('工具模块未加载'));
          } catch (e) {
            p = Promise.reject(e);
          }
          p.then((out) => {
            tool.status = 'done';
            tool.result = out;
            this.scrollBottom();
            this.persist();
            resolve(out);
          }).catch((e) => {
            const m = (e && e.message) ? e.message : String(e);
            tool.status = 'error';
            tool.result = m;
            this.scrollBottom();
            this.persist();
            // 失败也要回灌，模型才能向用户解释
            resolve('工具执行失败：' + m);
          });
        };

        if (write) {
          // 把「怎么继续」交给按钮；resolve 会在用户点击后调用
          this._toolWaiters.set(call.id, { run: runIt, resolve: resolve, tool: tool });
          this.persist();
        } else {
          runIt();
        }
      });
    },

    hasPendingTool(m) {
      return !!(m && m.tools && m.tools.some((t) => t.status === 'await'));
    },

    /** 会话里所有还挂着「待确认」的卡片 —— 它们已经没有对应的执行器了 */
    markExpiredTools() {
      let changed = false;
      (this.convos || []).forEach((c) => {
        (c.messages || []).forEach((m) => {
          (m.tools || []).forEach((t) => {
            if (t.status === 'await' || t.status === 'running') {
              t.status = 'expired';
              t.result = t.result || '这次确认已失效（会话已重新加载），请重新提问。';
              changed = true;
            }
          });
        });
      });
      if (changed) this.persist();
    },

    pendingTools(m) {
      return (m && m.tools ? m.tools : []).filter((t) => t.status === 'await');
    },

    pendingCount(m) {
      return this.pendingTools(m).length;
    },

    /** 批量执行：按顺序来，避免两个写操作同时改同一处状态 */
    runAllPending(m) {
      const list = this.pendingTools(m);
      if (!list.length) return;
      const runNext = (i) => {
        if (i >= list.length) return;
        const t = list[i];
        this.runPendingTool(m, t);
        // 上一个真正跑完（waiter 被消费）再跑下一个
        setTimeout(() => runNext(i + 1), 60);
      };
      runNext(0);
    },

    cancelAllPending(m) {
      this.pendingTools(m).slice().forEach((t) => this.cancelPendingTool(m, t));
    },

    /** 待确认卡片的「关键参数」：帮用户判断这一下点下去会发生什么 */
    toolArgsText(t) {
      const a = t && t.args;
      if (!a || typeof a !== 'object') return '';
      const keys = Object.keys(a).filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== '');
      if (!keys.length) return '';
      return keys.slice(0, 3).map((k) => {
        let v = a[k];
        if (typeof v === 'boolean') v = v ? '是' : '否';
        v = String(v);
        return k + '：' + (v.length > 24 ? v.slice(0, 24) + '…' : v);
      }).join(' · ');
    },

    /** 执行耗时：只在超过 2 秒后才显示，短操作不打扰 */
    elapsedText(t) {
      if (!t || !t.startedAt) return '';
      const sec = Math.floor((this._now - t.startedAt) / 1000);
      return sec >= 2 ? (sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒') : '';
    },

    hasRunningTool() {
      const msgs = this.currentMessages || [];
      return msgs.some((m) => m.tools && m.tools.some((t) => t.status === 'running'));
    },

    /** 只有真的有工具在跑时才让 _now 跳动，避免无事每秒重渲染 */
    startTick() {
      if (this._tickTimer) return;
      this._tickTimer = setInterval(() => {
        if (this.hasRunningTool()) this._now = Date.now();
        else this.stopTick();
      }, 1000);
    },

    stopTick() {
      if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    },

    /**
     * 该条消息是否正处于「思考中」：在流式等待模型首个 token 之前，
     * 正文还是空的 —— 此时把思考动画放进它自己的气泡里，
     * 这样整行只有「一个头像 + 一个气泡」，不会再额外冒出一行。
     */
    isThinkingMsg(m) {
      return !!(m && m.role === 'assistant' && m.streaming && !m.content);
    },

    runPendingTool(m, tool) {
      const w = this._toolWaiters.get(tool.id);
      if (!w) {
        tool.status = 'error';
        tool.result = '这次确认已失效（页面可能被刷新过），请重新提问。';
        return;
      }
      this._toolWaiters.delete(tool.id);
      w.run();
    },

    cancelPendingTool(m, tool) {
      const w = this._toolWaiters.get(tool.id);
      if (w) this._toolWaiters.delete(tool.id);
      tool.status = 'cancelled';
      tool.result = '用户取消了这次操作';
      this.persist();
      if (w) w.resolve('用户取消了这次操作，不要重试，直接用中文告诉用户已取消。');
    },

    /** 工具卡片里展示的结果摘要（长结果折叠） */
    toolShort(t) {
      const s = String(t.result || '');
      if (t.status === 'error') return s;
      if (/^[\{\[]/.test(s.trim())) {
        try {
          const o = JSON.parse(s);
          if (o && typeof o === 'object') {
            if (Array.isArray(o)) return '返回 ' + o.length + ' 条';
            const keys = Object.keys(o);
            const hint = o.count !== undefined ? ('共 ' + o.count + ' 项')
              : (o.installedVersionsCount !== undefined ? ('共 ' + o.installedVersionsCount + ' 个版本') : '');
            return hint || ('返回 ' + keys.length + ' 个字段');
          }
        } catch (e) { /* 不是 JSON，按文本截断 */ }
      }
      return s.length > 90 ? s.slice(0, 90) + '…' : s;
    },

    pushReply(convo, content, isError) {
      this.pushMsg(convo, { role: 'assistant', content: content, error: !!isError });
      convo.updatedAt = Date.now();
      this.persist();
      this.scrollBottom();
    },

    stop() {
      // 作废本次发送流水号：迟到的 AI 回复一律丢弃，不会污染后面的对话
      this._runSeq++;
      // ① 打上中止标记：Agent 循环每一轮开始前都会检查，后续轮次不会再发请求
      if (this._abort) {
        this._abort.aborted = true;
        this._abort = null;
      }
      this.thinking = false;

      // ② 立刻给「正在进行的这条助手消息」收尾。
      //    否则它一直停留在 streaming=true —— 气泡里的「正在思考」动画会一直转到
      //    后台那次请求超时（最长 90s）为止，按钮也卡在「停止」态，用户会觉得停不下来。
      const live = this._liveMsg;
      this._liveMsg = null;
      if (live) {
        this._streamToken = 0;          // 打断逐字上屏
        live.streaming = false;
        // 既没正文也没工具卡片 → 这条空消息没有存在意义，直接移除
        const convo = this.current;
        if (!live.content && (!live.tools || !live.tools.length) && convo) {
          const idx = convo.messages.indexOf(live);
          if (idx >= 0) convo.messages.splice(idx, 1);
        }
        this.persist();
      }

      // ③ 还没确认的工具直接作废，避免流停住了却永远等不到 resolve
      if (this._toolWaiters) {
        this._toolWaiters.forEach((w) => {
          try {
            w.tool.status = 'cancelled';
            w.tool.result = '已停止';
            w.resolve('用户中止了本次请求，不要重试。');
          } catch (e) {}
        });
        this._toolWaiters.clear();
      }
      if (this._streamMsg) {
        this._streamToken = 0;
        this._streamMsg.content = this._streamFull;
        this._streamMsg.streaming = false;
        this._streamMsg = null;
        this.persist();
      }
      this.scrollBottom();
    },

    /** 逐字上屏：总时长约 1.2~1.6s，与文本长度无关（长回复按块推进） */
    startStream(msg, full) {
      const token = ++this._streamSeq;
      this._streamToken = token;
      this._streamMsg = msg;
      this._streamFull = full;
      return new Promise((resolve) => {
        const finish = () => {
          msg.content = full;
          msg.streaming = false;
          resolve();
        };
        if (!full) { finish(); return; }
        const step = Math.max(3, Math.ceil(full.length / 96));
        let i = 0;
        const tick = () => {
          if (this._streamToken !== token) { finish(); return; }
          i = Math.min(full.length, i + step);
          msg.content = full.slice(0, i);
          this.scrollBottom();
          if (i >= full.length) { finish(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },

    regenerate() {
      if (this.busy) return;
      const convo = this.current;
      if (!convo || !convo.messages.length) return;
      let idx = -1;
      for (let i = convo.messages.length - 1; i >= 0; i--) {
        if (convo.messages[i].role === 'user') { idx = i; break; }
      }
      if (idx === -1) return;
      const text = convo.messages[idx].content;
      convo.messages.splice(idx);
      this.persist();
      this.input = text;
      this.autoGrow();
      this.send();
    },

    // ---------------- 交互 ----------------
    copyMsg(i, m) {
      window.VerseAssistant.copyText(m.content).then((ok) => {
        if (!ok) return;
        this.copiedIdx = i;
        setTimeout(() => { if (this.copiedIdx === i) this.copiedIdx = -1; }, 1500);
      });
    },

    md(m) {
      return window.VerseAssistant.renderMarkdown(m.content);
    },

    autoGrow() {
      const el = this.$refs.input;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 156) + 'px';
    },

    scrollBottom() {
      this.$nextTick(() => {
        const el = this.$refs.scroll;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }
};

window.VersePC = window.VersePC || {};
window.VersePC.PageAssistant = PageAssistant;
