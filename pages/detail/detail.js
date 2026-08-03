const { getBeijingDateStr } = require('../../utils/dateUtil.js');
const config = require('../../utils/config.js');

Page({
  data: {
    qian: null,
    hasDrawn: false,
    chatMessages: [],
    inputValue: '',
    showLogin: false,
    isLoggedIn: false,
    userInfo: null,
    scrollToId: '',
    _thinkingId: null,
    _hasShownBasic: true,  // 详情页自动展示解答，标记为已展示
    localMode: true,       // 纯本地模式(默认true=隐藏输入框)；false=开启深度解读
    remainCount: null      // 当日剩余咨询次数（null=不适用/未登录/本地模式）
  },

  onLoad(options) {
    // 从缓存读取今日签数据（首页抽签时已存入）
    const cachedQian = wx.getStorageSync('cachedQian');
    // 历史页传入的日期（点记录跳转时带过来）
    const historyDate = options && options.date ? decodeURIComponent(options.date) : '';

    if (cachedQian) {
      this.setData({
        qian: cachedQian,
        hasDrawn: true,
        drawnId: cachedQian.id,
        drawnLevel: cachedQian.level,
        drawnPoem: cachedQian.poemText,
        drawnBasic: cachedQian.basic
      });
      // 聊天记录按"抽签日期"隔离：同一天的签共享同一段对话，跨天/换签则开新会话
      this._chatDate = historyDate || cachedQian.date || getBeijingDateStr();
    } else if (options && options.id) {
      // 兜底：从参数构建（仅基本信息）
      this.setData({
        qian: {
          id: options.id,
          level: decodeURIComponent(options.level || '未知'),
          poemText: '',
          basic: null
        },
        hasDrawn: true,
        drawnId: options.id,
        drawnLevel: decodeURIComponent(options.level || '未知')
      });
      this._chatDate = historyDate || getBeijingDateStr();
    }

    this.appConfig = config.getCachedConfig();
    this.setData({ localMode: this.appConfig.localMode !== false });  // 默认true（纯本地）
    this.checkLogin();
    this.loadLocalChat();
    this._loadSerifFont();

    // 从历史页进入 → 尝试加载当天云端聊天记录
    if (historyDate && this.data.isLoggedIn) {
      this._loadCloudChat(historyDate);
    }

    // 拉取后台开关，拿到最新值后用最新开关重算登录态（热更新）
    config.fetchConfig().then((cfg) => {
      this.appConfig = cfg;
      this.setData({ localMode: cfg.localMode !== false });  // 热更新本地模式开关
      this.checkLogin();
      // 热更新后如果刚登录且有历史日期，补拉聊天
      if (historyDate && this.data.isLoggedIn && this.data.chatMessages.length === 0) {
        this._loadCloudChat(historyDate);
      }
    });
  },

  onShow() {
    // 每次显示时刷新签到状态（可能从历史页点进来）
    const cachedQian = wx.getStorageSync('cachedQian');
    if (cachedQian && !this.data.qian) {
      this.setData({
        qian: cachedQian,
        hasDrawn: true,
        drawnId: cachedQian.id,
        drawnLevel: cachedQian.level,
        drawnPoem: cachedQian.poemText,
        drawnBasic: cachedQian.basic
      });
      this._chatDate = cachedQian.date || getBeijingDateStr();
    }
  },

  /* ========== 加载思源宋体 ========== */
  _loadSerifFont() {
    wx.loadFontFace({
      family: 'SourceHanSerifSC',
      source: 'url("https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.2.5/files/noto-serif-sc-chinese-simplified-400-normal.woff")',
      desc: { weight: 'normal', style: 'normal' },
      success: () => console.log('[详情页] 思源宋体加载成功'),
      fail: () => {}
    });
  },

  /* ========== 导航 ========== */
  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  /* ========== 本地聊天持久化 ========== */
  loadLocalChat() {
    // 聊天记录按"抽签日期"隔离（key 含日期），新的一天/换签自动从空白会话开始，
    // 不再把昨天的对话载入，也不会被当成上下文发送
    const key = 'detailChat_' + (this._chatDate || getBeijingDateStr());
    const saved = wx.getStorageSync(key);
    if (saved && Array.isArray(saved) && saved.length > 0) {
      this.setData({
        chatMessages: saved,
        scrollToId: `msg-${saved[saved.length - 1].id}`
      });
    }
  },

  _persistChat() {
    const key = 'detailChat_' + (this._chatDate || getBeijingDateStr());
    const list = this.data.chatMessages.slice(-100);
    wx.setStorageSync(key, list);
  },

  /* ========== 登录相关（登录门槛由 localMode 派生：localMode=true 不登录，false 需登录）========== */
  checkLogin() {
    const cfg = this.appConfig || config.getCachedConfig();
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      // 已登录（有账号 token）：使用云端记忆同步
      this.setData({ isLoggedIn: true, userInfo });
      this.loadMemories();
      this.fetchQuota();
    } else if (this.data.localMode) {
      // 纯本地模式：无需登录，视为已登录（仅本地记忆），不弹登录框、不强制登录
      this.setData({ isLoggedIn: true });
    }
  },

  loadMemories() {
    const userInfo = this.data.userInfo || wx.getStorageSync('userInfo') || {};
    const token = userInfo.token || '';
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'getMemories', token: token }
    }).then(res => {
      const memories = res.result?.memories || [];
      wx.setStorageSync('userMemories', memories);
      console.log('[loadMemories] 拉取到', memories.length, '条记忆');
    }).catch((err) => { console.error('[loadMemories] 失败', err); });
  },

  // 拉取当日剩余咨询次数（仅登录账号 + 云端模式有效）
  fetchQuota() {
    const token = this.data.userInfo && this.data.userInfo.token
    if (!token || this.data.localMode) {
      this.setData({ remainCount: null })
      return
    }
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'getQuota', token: token }
    }).then(res => {
      if (res.result && res.result.code === 0 && typeof res.result.remain === 'number') {
        this.setData({ remainCount: res.result.remain })
      } else {
        this.setData({ remainCount: null })
      }
    }).catch(() => { this.setData({ remainCount: null }) })
  },

  onLogin(e) {
    const { phone, token } = e.detail;
    if (!token) return;
    const userInfo = { phone, token };
    wx.setStorageSync('userInfo', userInfo);
    this.setData({ isLoggedIn: true, userInfo, showLogin: false });
    this.loadMemories();
    this.fetchQuota();
    wx.showToast({ title: '登录成功', icon: 'success' });

    if (this._pendingQuestion) {
      const q = this._pendingQuestion;
      this._pendingQuestion = null;
      // 登录前缓存的问题：先追加用户消息到聊天窗口，再补做记忆提取 + AI 解读
      const pendingMsg = {
        id: Date.now(),
        role: 'user',
        content: '<div style="color:#4a3728;font-size:14px;line-height:1.6;">' + this._escHtml(q) + '</div>'
      };
      this.setData({
        chatMessages: [...this.data.chatMessages, pendingMsg],
        scrollToId: `msg-${pendingMsg.id}`
      });
      this._persistChat();
      this.extractMemory(q);
      this._pendingUserText = q;  // 云端聊天记录用
      this._showThinking();       // 显示"思考中"动画
      setTimeout(() => this.callInterp(q), 300);
    }
  },

  onCloseLogin() {
    if (this._pendingQuestion) {
      const q = this._pendingQuestion;
      this._pendingQuestion = null;
      const pendingMsg = {
        id: Date.now(),
        role: 'user',
        content: '<div style="color:#4a3728;font-size:14px;line-height:1.6;">' + this._escHtml(q) + '</div>'
      };
      const replyMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        content: '<div style="color:#A8201A;font-size:13px;line-height:1.6;">🙏 请先登录，阿鹏才能记得您的故事</div>'
      };
      this.setData({
        showLogin: false,
        chatMessages: [...this.data.chatMessages, pendingMsg, replyMsg],
        scrollToId: `msg-${replyMsg.id}`
      });
      this._persistChat();
    } else {
      this.setData({ showLogin: false });
    }
  },

  /* ========== 消息发送核心逻辑 ========== */
  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  sendMessage() {
    let content = this.data.inputValue.trim();
    if (!content) return;

    const userMsg = {
      id: Date.now(),
      role: 'user',
      content: '<div style="color:#4a3728;font-size:14px;line-height:1.6;">' + this._escHtml(content) + '</div>'
    };

    // 未抽签 → 提示
    if (!this.data.hasDrawn) {
      const tipMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        content: '<div style="color:#A8201A;font-size:13px;line-height:1.6;">🙏 请先返回首页抽一签...</div>'
      };
      this.setData({
        chatMessages: [...this.data.chatMessages, userMsg, tipMsg],
        inputValue: '',
        scrollToId: `msg-${tipMsg.id}`
      });
      this._persistChat();
      return;
    }

    // 已抽签 → 先检查登录状态，未登录则只弹框不加消息（等取消/登录后再处理）
    if (!this.data.localMode && !this.data.isLoggedIn) {
      this._pendingQuestion = content;
      this.setData({ showLogin: true, inputValue: '' });
      return;
    }

    // 登录通过（或本地模式）→ 追加用户消息
    this.setData({
      chatMessages: [...this.data.chatMessages, userMsg],
      inputValue: '',
      scrollToId: `msg-${userMsg.id}`
    });
    this._persistChat();
    this._pendingUserText = content;  // 暂存纯文本，供云端聊天记录使用

    // 显示"思考中"
    this._showThinking();

    // 提取记忆关键词
    this.extractMemory(content);

    // 本地模式（localMode=true）→ 返回本地提示
    if (this.data.localMode) {
      const localTip = {
        id: Date.now() + 2,
        role: 'assistant',
        content: '<div style="color:#A8201A;font-size:13px;line-height:1.6;">🙏 当前为本地模式，暂不支持在线咨询。签诗与解答均为本地预置数据，感谢您的使用。</div>'
      };
      this._replaceThinking(localTip);
      this._persistChat();
      return;
    }

    // 调用深度解读
    this.callInterp(content);
  },

  /* ========== "思考中"气泡 ========== */
  _showThinking() {
    const id = Date.now();
    this.setData({ _thinkingId: id });
    const thinkingMsg = {
      id: id,
      role: 'assistant',
      content: '<div class="thinking-bubble"><span class="thinking-dots">···</span></div>'
    };
    this.setData({
      chatMessages: [...this.data.chatMessages, thinkingMsg],
      scrollToId: `msg-${id}`
    });
    return id;
  },

  _replaceThinking(actualMsg) {
    if (!this.data._thinkingId) {
      this.setData({
        chatMessages: [...this.data.chatMessages, actualMsg],
        scrollToId: `msg-${actualMsg.id}`
      });
      return;
    }
    const msgs = this.data.chatMessages.map(m =>
      m.id === this.data._thinkingId ? actualMsg : m
    );
    this.setData({
      chatMessages: msgs,
      _thinkingId: null,
      scrollToId: `msg-${actualMsg.id}`
    });
  },

  /* ========== 深度解读 ========== */
  callInterp(userQuestion) {
    const memories = this.getInterpMemory();
    const qianInfo = this.data.hasDrawn ? {
      id: this.data.drawnId,
      level: this.data.drawnLevel,
      poem: this.data.drawnPoem,
      basic: this.data.drawnBasic
    } : null;

    let finalQuestion = userQuestion;
    if (this.data.hasDrawn && this.data.drawnPoem) {
      finalQuestion = `[用户当前签运] 第${this.data.drawnId}签（${this.data.drawnLevel}），签诗：${this.data.drawnPoem}\n用户提问：${userQuestion}`;
    }

    const recentMsgs = this.data.chatMessages.slice(-8).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: this._stripHtml(typeof m.content === 'string' ? m.content : '[消息内容]')
    }));

    wx.cloud.callFunction({
      name: 'jieqian',
      data: {
        action: 'chat',
        token: this.data.userInfo ? this.data.userInfo.token : '',
        messages: recentMsgs,
        question: finalQuestion,
        memories: memories,
        currentQian: qianInfo
      }
    }).then(res => {
      if (res.result && res.result.code && res.result.code !== 0) {
        const errText = res.result.msg || res.result.content || '请求失败';
        const errMsg = {
          id: Date.now() + 1,
          role: 'assistant',
          content: '<div style="color:#c0392b;font-size:13px;line-height:1.6;">⚠️ 阿鹏暂时无法解答：' + this._escHtml(errText) + '</div>'
        };
        this._replaceThinking(errMsg);
        this._persistChat();
        return;
      }
      const reply = res.result?.content || '阿鹏正在思考，请稍后再试...';
      const interpMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        content: this.formatReply(reply)
      };
      this._replaceThinking(interpMsg);
      this._persistChat();
      // 更新当日剩余咨询次数
      if (typeof res.result?.remain === 'number') {
        this.setData({ remainCount: res.result.remain });
      }
      // 云端记录当日聊天（仅登录且非本地模式）
      this._recordCloudChat(reply);
    }).catch(err => {
      console.error('[callInterp] error:', err);
      const errMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        content: '<div style="color:#c0392b;font-size:13px;line-height:1.6;">⚠️ 调用失败：' + this._escHtml(err.errMsg || err.message || '未知错误') + '</div>'
      };
      this._replaceThinking(errMsg);
      this._persistChat();
    });
  },

  /* ========== 云端记录当日聊天（登录 + 非本地模式才写）========== */
  _recordCloudChat(reply) {
    const token = this.data.userInfo ? this.data.userInfo.token : ''
    if (!token || this.data.localMode) return
    const userText = this._stripHtml(this._pendingUserText || '')
    this._pendingUserText = null
    const aiText = this._stripHtml(typeof reply === 'string' ? reply : '')
    if (!userText && !aiText) return
    const now = new Date()
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    const t = pad(now.getHours()) + ':' + pad(now.getMinutes())
    const msgs = []
    if (userText) msgs.push({ role: 'user', content: userText, t })
    if (aiText) msgs.push({ role: 'assistant', content: aiText, t })
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'recordChat', token, date: this._chatDate, messages: msgs }
    }).catch(() => {})
  },

  /* ========== 从云端加载某天的聊天记录（历史页点进来时用）========== */
  _loadCloudChat(dateStr) {
    const token = this.data.userInfo ? this.data.userInfo.token : ''
    if (!token || this.data.localMode) return
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'getHistory', token, date: dateStr }
    }).then(res => {
      if (!res.result || res.result.code !== 0) return
      const chats = res.result.chats && res.result.chats[dateStr]
      if (!chats || chats.length === 0) return
      // 将云端消息转为聊天窗口格式
      const msgs = chats.map((m, i) => ({
        id: Date.now() + i,
        role: m.role,
        content: m.role === 'user'
          ? ('<div style="color:#4a3728;font-size:14px;line-height:1.6;">' + this._escHtml(m.content) + '</div>')
          : this.formatReply(m.content)
      }))
      this.setData({
        chatMessages: msgs,
        scrollToId: `msg-${msgs[msgs.length - 1].id}`
      })
    }).catch(() => {})
  },

  /* ========== 格式化解读回复为 HTML ========== */
  formatReply(text) {
    if (!text) return '';
    // 1. 清洗前缀与 HTML/Markdown 标签残留
    var s = String(text)
      .replace(/^(?:【?解签大师?】?|【?阿鹏趣签?】?|【?解读?】?|【?解答?】?)[：:，,\s]*/i, '')
      .replace(/^(?:您好|你好|福主您好|福主你好)[，,。.\s]*/i, '')
      .replace(/<\/?(div|span|p|br|section|article|h[1-6]|ul|ol|li|blockquote|pre|code)\b[^>]*>/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!s) return '';

    // 2. 严格去掉 Markdown 标题符号 # / ## / ###（仅行首），避免显示 # 号
    s = s.replace(/^[#\s]+/gm, '').replace(/^\s+|\s+$/gm, '');

    // 3. Markdown **加粗** → <strong>
    s = s.replace(/\*\*([^*]+?)\*\*:?/g, '<strong>$1</strong>');

    // 4. 智能断行（兼容有/无 ** 两种格式）
    s = s.replace(/(?=\d+[\.\、\s]\*?(?:方面|建议|提醒|注意|运势|财运|感情|健康|事业|学业|解读|签意))/gi, '\n');
    s = s.replace(/(?=(?:此外|另外|同时|综上|总之|最后|需要注意的是|值得一提的是)\s*[，,：:])/g, '\n');

    // 5. 重点词加粗（在断行后、按行渲染前统一处理）
    s = this._boldKeywords(s);

    // 6. 按行渲染 —— 严格控制样式，标题才红，正文恢复深灰
    var lines = s.split('\n');
    var parts = [];
    var hasSummaryDivider = false;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) continue;

      // 独立小标题行（**xxx** 独立成行）
      if (/^<strong>[^<]*?<\/strong>\s*:?\s*$/.test(t)) {
        parts.push('<div style="color:#A8201A;font-weight:bold;font-size:15px;margin:18px 0 10px 0;padding-bottom:6px;border-bottom:1px solid rgba(168,32,26,0.12);">' + t + '</div>');
        continue;
      }

      // 数字序号行："1. 标题：正文" → 标题前缀红色加粗，后面正文深灰
      // 标题里可能含 _boldKeywords 加的 <strong>...</strong>，故字符集只排除冒号、允许 <>
      var numMatch = t.match(/^(\d+[\.\、])\s*((?:<strong>)?[^：:]+(?:<\/strong>)?)[：:]\s*(.*)$/);
      if (numMatch) {
        var numPrefix = numMatch[1] + ' ' + numMatch[2] + '：';
        var numBody = numMatch[3];
        parts.push('<div style="margin:12px 0 8px 0;line-height:1.85;font-size:13px;"><span style="color:#A8201A;font-weight:bold;font-size:14px;">' + numPrefix + '</span><span style="color:#444;">' + numBody + '</span></div>');
        continue;
      }

      // 短行标题（无句号逗号、较短，如"事业解析："）
      if (t.length <= 20 && t.indexOf('。') < 0 && t.indexOf('，') < 0 && !/^<strong>/.test(t)) {
        parts.push('<div style="color:#A8201A;font-weight:bold;font-size:15px;margin:18px 0 10px 0;padding-bottom:6px;border-bottom:1px solid rgba(168,32,26,0.12);">' + t + '</div>');
        continue;
      }

      // 总结段落（总的来说/总之/综上）→ 前加分隔线
      if (/^(?:总的来说|总而言之|综上所述|总之|综上|一言以蔽之)[，,：:]/.test(t)) {
        hasSummaryDivider = true;
        parts.push('<div style="margin:18px 0 10px 0;border-top:1px solid rgba(168,32,26,0.15);"></div>');
        parts.push('<div style="color:#555;margin:5px 0;line-height:1.85;font-size:13px;">' + t + '</div>');
        continue;
      }

      // 普通正文：深灰色，不再全红
      parts.push('<div style="color:#444;margin:5px 0;line-height:1.85;font-size:13px;">' + t + '</div>');
    }

    // 兜底：最后一行若不是“总的来说/总之”等已加分隔线，则统一在文末总结前补一条分隔线
    if (!hasSummaryDivider && parts.length > 0) {
      var lastIdx = parts.length - 1;
      parts.splice(lastIdx, 0, '<div style="margin:18px 0 10px 0;border-top:1px solid rgba(168,32,26,0.15);"></div>');
    }

    return '<div style="padding:2px 0;">' + parts.join('') + '</div>';
  },

  /* ========== 重点词自动加粗 ========== */
  _boldKeywords(text) {
    var s = text;
    // 「引号内容」加粗（中文直角引号、弯引号、英文引号）
    s = s.replace(/「([^」]+)」/g, '<strong>「$1」</strong>');
    s = s.replace(/“([^”]+)”/g, '<strong>“$1”</strong>');
    s = s.replace(/"([^"]+)"/g, '<strong>"$1"</strong>');
    // 常见关键语义词组加粗（签文解读中的高频核心词）
    var keyPatterns = [
      /(?:当前困境|潜在转机|时间预期|应对建议|核心提示|总体研判|转折点|突破口|关键节点)(?=[:：])/g,
      /(?:风梅初隐|月累已喜|水星自聚|凤星黎闲)/g,
      /(?:低谷蓄力|真心换真心|切忌猜疑|极度困顿|投资入出|量入为出|需自省|当速就医|早睡早起|身心自安)/g,
    ];
    for (var k = 0; k < keyPatterns.length; k++) {
      s = s.replace(keyPatterns[k], '<strong>$&</strong>');
    }
    return s;
  },

  /* ========== 记忆系统 ========== */
  extractMemory(text) {
    if (!text || typeof text !== 'string') return;

    const now = new Date();
    const year = now.getFullYear();          // 当前年份，如 2026
    const yearStr = year.toString();

    // 带上下文提取规则：每个条目 [正则, 分类, 标签生成函数]
    const rules = [
      // 本命年（捕获年份前缀：今年/202x年/本命年）
      { re: /(\d{4})?年?本命年/, cat: 'life', fmt: (m) => ((m[1] || yearStr) + '年本命年') },
      { re: /今年本命年/, cat: 'life', fmt: () => (yearStr + '年本命年') },
      // 感情
      { re: /(刚|最近|正在)?(失恋|分手|离婚)/, cat: 'love', fmt: (m) => (m[0]) },
      { re: /(想|准备|计划)?(结婚|领证|订婚)/, cat: 'love', fmt: (m) => (m[0]) },
      { re: /单身/, cat: 'love', fmt: () => ('单身') },
      { re: /(在谈|有|找|想找|相亲)?(对象|男友|女友|伴侣|另一半)/, cat: 'love', fmt: (m) => (m.filter(Boolean).join('')) },
      // 事业
      { re: /(想|准备|打算|正在)?(升职|跳槽|辞职|创业|转正|面试|入职)/, cat: 'career', fmt: (m) => (m.filter(Boolean).join('')) },
      { re: /(被|遭)?(裁员|降薪|失业|欠薪)/, cat: 'career', fmt: (m) => (m[0]) },
      { re: /考研|考公|考编|出国|留学|毕业|乔迁|搬家/, cat: 'life', fmt: (m) => (m[0]) },
      // 财富
      { re: /(想|准备|打算)?(投资|理财|买房|买车|买基金|买股票)/, cat: 'wealth', fmt: (m) => (m.filter(Boolean).join('')) },
      { re: /(有|背)?(贷款|欠债|债务)/, cat: 'wealth', fmt: (m) => (m.filter(Boolean).join('')) },
      // 健康
      { re: /(长期|经常|严重)?(失眠|焦虑|抑郁|脱发)/, cat: 'health', fmt: (m) => (m.filter(Boolean).join('')) },
      { re: /(做过|要做|准备做)?(手术|体检)/, cat: 'health', fmt: (m) => (m.filter(Boolean).join('')) },
    ];

    const extracted = [];
    rules.forEach(rule => {
      const match = text.match(rule.re);
      if (match) {
        const tag = rule.fmt(match);
        if (tag) extracted.push({ tag, cat: rule.cat, time: now.toISOString() });
      }
    });

    console.log('[extractMemory] 输入:', text.slice(0, 40), '→ 提取到:', extracted.length > 0 ? extracted.map(e => e.tag).join(', ') : '(无)');
    console.log('[extractMemory] localMode=', this.data.localMode, 'isLoggedIn=', this.data.isLoggedIn, 'hasToken=', !!((this.data.userInfo || wx.getStorageSync('userInfo') || {}).token));

    if (extracted.length > 0) {
      // 记忆标签永远写入本地（关闭登录时仅本地，无需跨设备同步）
      const localMemories = wx.getStorageSync('localMemories') || [];
      localMemories.push(...extracted.map(e => `${e.time.slice(0,10)} ${e.tag}`));
      wx.setStorageSync('localMemories', localMemories.slice(-30));

      // 只要用户已登录（有token），就同步到云端实现跨设备/多端一致
      // 注意：localMode=false 才需要登录（有token），localMode=true 免登录仅本地
      const userInfo = this.data.userInfo || wx.getStorageSync('userInfo') || {};
      if (userInfo.token) {
        console.log('[saveMemory] 准备保存到云端:', extracted.map(e => e.tag).join(', '));
        this._saveMemory(extracted);
      } else {
        console.log('[saveMemory] 用户未登录，跳过云端保存（仅本地）');
      }
    }
  },

  getInterpMemory() {
    const cfg = this.appConfig || config.getCachedConfig();
    // 完整功能模式(localMode=false，已登录) → 云端记忆(已同步) + 本地兜底；纯本地模式 → 仅本地记忆
    const cloudMemories = !this.data.localMode ? (wx.getStorageSync('userMemories') || []) : [];
    const localMemories = wx.getStorageSync('localMemories') || [];
    const all = [...cloudMemories, ...localMemories];
    if (all.length === 0) return '';
    const unique = [...new Set(all)].slice(-10);
    return '【用户的个人背景与历史信息】以下是根据用户过往对话自动整理的关键信息，请在解读时自然地引用这些信息来拉近与用户的距离：\n' +
      unique.map(m => `- ${m}`).join('\n');
  },

  _saveMemory(extracted) {
    // extracted: [{ tag, cat }, ...]  来自 extractMemory 的提取结果
    const userInfo = this.data.userInfo || wx.getStorageSync('userInfo') || {};
    const token = userInfo.token || '';
    if (!token) {
      console.warn('[saveMemory] 无token，跳过云端保存（仅本地）');
      return;
    }
    if (!extracted || extracted.length === 0) return;
    // 批量传给服务端，由服务端逐条写入（单次网络请求）
    wx.cloud.callFunction({
      name: 'jieqian',
      data: {
        action: 'saveMemory',
        token: token,
        items: extracted.map(e => ({ tag: e.tag, cat: e.cat }))
      }
    }).then(res => {
      console.log('[saveMemory] 已保存', extracted.length, '条:', extracted.map(e => e.tag).join(', '));
    }).catch(err => {
      console.error('[saveMemory] 保存失败:', err);
    });
  },

  /* ========== 工具方法 ========== */
  _escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  /* 去除 HTML 标签，提取纯文本（发送解读时用） */
  _stripHtml(html) {
    if (!html) return '';
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(div|span|p|section|article|strong|em|b|i|u|h[1-6]|ul|ol|li|blockquote|pre|code)\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  /* ========== 分享 ========== */
  onShareAppMessage() {
    return {
      title: `阿鹏趣签 - 第${this.data.drawnId || ''}签`,
      path: '/pages/index/index',
      imageUrl: '/images/jieqian-logo-peng.png'
    };
  }
});
