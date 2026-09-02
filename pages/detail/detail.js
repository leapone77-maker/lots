const { getBeijingDateStr } = require('../../utils/dateUtil.js');
const guest = require('../../utils/guest.js');
const config = require('../../utils/config.js');
const { convertEmoji } = require('../../utils/emoji.js');
const { QIAN_DB } = require('../../utils/qianData.js');

// 旧缓存/旧记录无 action 等字段时，从本地签文库按签号兜底补齐
function fillQianFields(qian) {
  if (!qian) return qian;
  const q = QIAN_DB.find(x => x.id === Number(qian.id));
  if (!q) return qian;
  if (!qian.action && q.action) qian.action = q.action;
  if (!qian.yiji && q.yiji) qian.yiji = q.yiji;
  return qian;
}

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
    remainCount: null,     // 当日剩余咨询次数（null=不适用/未登录/本地模式）
    dailyLimit: 1,         // 当日基础上限（恒为1）
    bonusEligible: false,  // 是否可通过分享再领1次（次数用完且今日未领过时为true，前端据此显示分享引导）
    centerToast: { show: false, text: '' },  // 屏幕中间 toast（内联实现）
    inputExpanded: false,  // 输入框是否展开为大文本域
    userProfile: '',       // 用户画像文本（从云端获取，不展示给用户）
    _shareId: '',          // 分享快照 ID（云函数返回）
    drawDate: ''           // 抽签日期（YYYY-MM-DD），显示在签号后面
  },

  onLoad(options) {
    // 从缓存读取今日签数据（首页抽签时已存入）
    const cachedQian = wx.getStorageSync('cachedQian');
    // 历史页传入的日期（点记录跳转时带过来）
    const historyDate = options && options.date ? decodeURIComponent(options.date) : '';

    if (cachedQian) {
      fillQianFields(cachedQian);
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
      this.setData({ drawDate: this._chatDate });
    } else if (options && options.id) {
      // 兜底：从参数构建（仅基本信息）
      const fallbackQian = fillQianFields({
        id: options.id,
        level: decodeURIComponent(options.level || '未知'),
        poemText: '',
        basic: null
      });
      this.setData({
        qian: fallbackQian,
        hasDrawn: true,
        drawnId: options.id,
        drawnLevel: decodeURIComponent(options.level || '未知')
      });
      this._chatDate = historyDate || getBeijingDateStr();
      this.setData({ drawDate: this._chatDate });
    }

    this.appConfig = config.getCachedConfig();
    this.setData({ localMode: this.appConfig.localMode !== false });  // 默认true（纯本地）
    this.checkLogin();
    this.loadLocalChat();
    this._loadSerifFont();
    // 已登录的云模式用户进入详情页仅预计算 shareId（不写 shares 库）
    if (!this.data.localMode && this.data.isLoggedIn) this._precomputeShareId();

    // 从历史页进入 → 尝试加载当天云端聊天记录
    if (historyDate && this.data.isLoggedIn) {
      this._loadCloudChat(historyDate);
    }

    // 拉取后台开关，拿到最新值后用最新开关重算登录态（热更新）
    config.fetchConfig().then((cfg) => {
      this.appConfig = cfg;
      this.setData({ localMode: cfg.localMode !== false });  // 热更新本地模式开关
      this.checkLogin();
      if (!this.data.localMode && this.data.isLoggedIn) this._precomputeShareId();  // 热更新后仅预计算 shareId，不写库
      // 热更新后如果刚登录且有历史日期，补拉聊天
      if (historyDate && this.data.isLoggedIn && this.data.chatMessages.length === 0) {
        this._loadCloudChat(historyDate);
      }
    });
  },

  onShow() {
    // 每次显示时刷新签到状态（可能从历史页点进来）
    const cachedQian = wx.getStorageSync('cachedQian');
    if (cachedQian) {
      fillQianFields(cachedQian);
    }
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

  /* ========== 登录相关（登录门槛由 localMode 派生：localMode=true 不登录，false 需登录）========== */
  checkLogin() {
    const cfg = this.appConfig || config.getCachedConfig();
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      // 已登录（有账号 token）：使用云端记忆同步
      this.setData({ isLoggedIn: true, userInfo });
      this.loadProfile();
      this.fetchQuota();
    } else if (this.data.localMode) {
      // 纯本地模式：无需登录，视为已登录（仅本地记忆），不弹登录框、不强制登录
      this.setData({ isLoggedIn: true });
    } else {
      // 云模式但无账号 → 未登录，后续 sendMessage 会弹登录框
      this.setData({ isLoggedIn: false });
    }
  },

  loadProfile() {
    const userInfo = this.data.userInfo || wx.getStorageSync('userInfo') || {};
    const token = userInfo.token || '';
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'getMemories', token: token }
    }).then(res => {
      const profile = res.result?.profile || '';
      this.setData({ userProfile: profile });
      console.log('[loadProfile] 加载用户画像:', profile.substring(0, 100) + (profile.length > 100 ? '...' : ''));
    }).catch((err) => { console.error('[loadProfile] 失败', err); });
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
        this.setData({ remainCount: res.result.remain, dailyLimit: res.result.dailyLimit || 1, bonusEligible: res.result.bonusEligible === true })
      } else {
        this.setData({ remainCount: null, dailyLimit: 1, bonusEligible: false })
      }
    }).catch(() => { this.setData({ remainCount: null }) })
  },

  onLogin(e) {
    const { account, token, nickname } = e.detail;
    if (!token) return;
    const userInfo = { account, token, nickname: nickname || '' };
    wx.setStorageSync('userInfo', userInfo);
    this.setData({ isLoggedIn: true, userInfo, showLogin: false });
    guest.mergeGuestOnLogin(token);   // 把登录前的游客抽签/聊天记录并入账号
    this._precomputeShareId();   // 登录后仅预计算 shareId，保证首次分享即有效（不写库）
    this.loadProfile();
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
        rawText: q,
        content: '<div style="color:#4a3728;font-size:14px;line-height:1.6;">' + this._escHtml(q) + '</div>'
      };
      const replyMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        rawText: '请先登录，每一签的记忆才能为你保留，才能更读懂你的故事，解锁更多专属解读。',
        content: '<div style="color:#A8201A;font-size:13px;line-height:1.6;"> 请先登录，每一签的记忆才能为你保留，才能更读懂你的故事，解锁更多专属解读。</div>'
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

  /* ========== 输入框展开/收起 ========== */
  onExpand() {
    this.setData({ inputExpanded: true });
  },

  onCollapse() {
    this.setData({ inputExpanded: false });
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
      rawText: content,
      content: '<div style="color:#4a3728;font-size:14px;line-height:1.6;">' + this._escHtml(convertEmoji(content)) + '</div>'
    };

    // 未抽签 → 提示
    if (!this.data.hasDrawn) {
      const tipMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        rawText: '请先返回首页抽一签...',
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
        rawText: '当前为本地模式，暂不支持在线咨询。签诗与解答均为本地预置数据，感谢您的使用。',
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
    const profile = this.getUserProfile();
    const q = this.data.qian || {}
    const qianInfo = this.data.hasDrawn ? {
      id: this.data.drawnId,
      level: this.data.drawnLevel,
      poem: this.data.drawnPoem,
      basic: this.data.drawnBasic,
      yiji: q.yiji || '',
      action: q.action || ''
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
        profile: profile,
        currentQian: qianInfo
      }
    }).then(res => {
      if (res.result && res.result.code && res.result.code !== 0) {
        const errText = res.result.msg || res.result.content || '请求失败';
        const errMsg = {
          id: Date.now() + 1,
          role: 'assistant',
          rawText: '阿鹏暂时无法解答：' + errText,
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
        rawText: reply,
        content: this.formatReply(reply)
      };
      this._replaceThinking(interpMsg);
      this._persistChat();
      // 更新当日剩余咨询次数
      if (typeof res.result?.remain === 'number') {
        this.setData({ remainCount: res.result.remain, dailyLimit: res.result.dailyLimit || this.data.dailyLimit, bonusEligible: typeof res.result.bonusEligible === 'boolean' ? res.result.bonusEligible : this.data.bonusEligible });
      }
      // 云端记录当日聊天（仅登录且非本地模式）
      this._recordCloudChat(reply);
    }).catch(err => {
      console.error('[callInterp] error:', err);
      const errMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        rawText: '调用失败：' + (err.errMsg || err.message || '未知错误'),
        content: '<div style="color:#c0392b;font-size:13px;line-height:1.6;">⚠️ 调用失败：' + this._escHtml(err.errMsg || err.message || '未知错误') + '</div>'
      };
      this._replaceThinking(errMsg);
      this._persistChat();
    });
  },

  /* ========== 长按消息复制 ========== */
  onLongPressMsg(e) {
    const rawText = e.currentTarget.dataset.rawtext
    if (!rawText) return
    wx.showActionSheet({
      itemList: ['复制'],
      success: () => {
        wx.setClipboardData({
          data: rawText,
          success: () => {
            wx.showToast({ title: '已复制', icon: 'success', duration: 1500 })
          }
        })
      }
    })
  },

  /* ========== 长按签诗卡片复制 ========== */
  onLongPressQian() {
    const q = this.data.qian
    if (!q) return
    const lines = []
    lines.push('第 ' + q.id + ' 签 · ' + q.level)
    lines.push('签诗：' + q.poemText)
    if (q.basic) {
      lines.push('解签：' + q.basic)
    }
    if (q.yiji) {
      lines.push('宜忌：' + q.yiji)
    }
    if (q.action) {
      lines.push('行动：' + q.action)
    }
    const text = lines.join('\n')
    wx.showActionSheet({
      itemList: ['复制'],
      success: () => {
        wx.setClipboardData({
          data: text,
          success: () => {
            wx.showToast({ title: '已复制', icon: 'success', duration: 1500 })
          }
        })
      }
    })
  },

  /* ========== 云端记录当日聊天（非本地模式才写：已登录用 token，未登录用游客ID）========== */
  _recordCloudChat(reply) {
    if (this.data.localMode) return
    const token = this.data.userInfo ? this.data.userInfo.token : ''
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
      data: {
        action: 'recordChat',
        token,
        guestId: token ? '' : guest.getGuestId(),
        date: this._chatDate,
        messages: msgs
      }
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
        rawText: m.content,
        content: m.role === 'user'
          ? ('<div style="color:#4a3728;font-size:14px;line-height:1.6;">' + this._escHtml(convertEmoji(m.content)) + '</div>')
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
        parts.push('<div style="margin:12px 0 8px 0;line-height:1.85;font-size:14px;"><span style="color:#A8201A;font-weight:bold;font-size:14px;">' + numPrefix + '</span><span style="color:#444;">' + numBody + '</span></div>');
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
        parts.push('<div style="color:#555;margin:5px 0;line-height:1.85;font-size:14px;">' + t + '</div>');
        continue;
      }

      // 普通正文：深灰色，不再全红
      parts.push('<div style="color:#444;margin:5px 0;line-height:1.85;font-size:14px;">' + t + '</div>');
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
  getUserProfile() {
    // 返回用户画像文本（从 data 中获取）
    return this.data.userProfile || '';
  },

  extractMemory(text) {
    // 旧版关键词提取已废弃，画像由 AI 在 chat 时自动提取并保存
    return;
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
    // 旧版保存已废弃，画像由 AI 在 chat 时自动保存到云端
    return;
  },

  // 分享奖励发放：进入转发流程时调用（用户发起转发那一刻触发 onShareAppMessage）。
  // 云函数侧校验发奖条件（次数用完且当天未领过）并用条件更新防并发
  grantShareBonus() {
    const token = this.data.userInfo && this.data.userInfo.token
    if (!token || this.data.localMode || !this.data.isLoggedIn) return
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'grantShareBonus', token: token }
    }).then(res => {
      if (res.result && res.result.code === 0) {
        this.setData({ remainCount: res.result.remain, dailyLimit: res.result.dailyLimit || this.data.dailyLimit, bonusEligible: typeof res.result.bonusEligible === 'boolean' ? res.result.bonusEligible : this.data.bonusEligible })
        if (res.result.granted) {
          this.showCenterToast('分享成功，新获得 1 次咨询！')
        }
      }
    }).catch(() => {})
  },

  /* ========== 分享 ========== */

  // 预计算 shareId（只读，不写 shares 库）：进入详情页/登录成功时调用，
  // 让右上角"..."转发也能带上有效路径；真正写库只发生在点击分享按钮时
  _precomputeShareId() {
    if (this.data._shareId) return              // 已算过，不重复请求
    if (!this.data.hasDrawn) return
    if (this.data.localMode) return             // 本地模式不分享
    const token = this.data.userInfo && this.data.userInfo.token
    if (!token) return
    const q = this.data.qian || {}
    if (!q.id) return
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'getShareId', token: token, signId: q.id }
    }).then(res => {
      if (res.result && res.result.code === 0 && res.result.shareId) {
        this.setData({ _shareId: res.result.shareId })
      }
    }).catch(() => {})
  },

  // 点击分享按钮时才真正写库生成/刷新分享快照（仅已登录可用）
  _refreshShare(callback) {
    if (!this.data.hasDrawn) return
    if (this.data.localMode) return            // 本地模式不分享
    const token = this.data.userInfo && this.data.userInfo.token
    if (!token) return                          // 仅已登录账号可分享（已去掉匿名分享）
    const q = this.data.qian || {}
    if (!q.id) return

    const snapshot = {
      signId: q.id,
      level: q.level,
      poemText: q.poemText,
      basic: q.basic || null,
      yiji: q.yiji || null,
      action: q.action || null,
      nickname: (this.data.userInfo && this.data.userInfo.nickname) || '',
      drawDate: this._chatDate,           // 抽签日期（YYYY-MM-DD），分享页显示用
      chats: this.data.chatMessages.map(m => ({ role: m.role, content: m.content }))
    }

    const data = { action: 'createShare', snapshot: snapshot, token: token }

    wx.cloud.callFunction({ name: 'jieqian', data: data }).then(res => {
      if (res.result && res.result.code === 0 && res.result.shareId) {
        this.setData({ _shareId: res.result.shareId })
        if (callback) callback()
      }
    }).catch(() => { if (callback) callback() })
  },

  // 分享按钮点击：已登录→刷新快照并触发微信原生分享面板；未登录→弹登录框
  onShareTap() {
    if (!this.data.hasDrawn) return
    if (this.data.localMode) return            // 本地模式不分享（按钮本就不显示）
    if (!this.data.isLoggedIn) {               // 未登录 → 弹登录框，登录后才能分享
      this.setData({ showLogin: true })
      return
    }
    this._refreshShare()                        // 已登录 → 刷新快照，原生分享面板由 open-type="share" 触发
  },

  // 微信原生分享菜单回调（右上角 "..." → 转发给朋友）
  onShareAppMessage() {
    const shareId = this.data._shareId || ''
    const yijiShort = ((this.data.qian && this.data.qian.yiji) || '').replace(/[。.！!？?\s]+$/, '')
    const title = `第${this.data.drawnId || ''}签` + (yijiShort ? '·' + yijiShort : '')
    this._refreshShare()    // 真正发起转发才写库（异步不阻塞面板；shareId 确定性强幂等）
    this.grantShareBonus()  // 进入转发流程即触发分享奖励（尽力而为，不阻塞面板）
    if (shareId) {
      return {
        title: title,
        path: '/pages/share/share?shareId=' + shareId,
        imageUrl: '/images/jieqian-share-fu.png'
      }
    }
    // 兜底：快照尚未生成，仍保持规范标题，路径回首页
    return {
      title: title,
      path: '/pages/index/index',
      imageUrl: '/images/jieqian-share-fu.png'
    }
  },

  // 屏幕中间弹出提示，2 秒后自动上滑消失（内联实现，替代原 center-toast 组件）
  showCenterToast(text) {
    if (this._toastTimer) clearTimeout(this._toastTimer)
    if (this._toastAnimTimer) clearTimeout(this._toastAnimTimer)

    // 1. 显示 + 淡入动画（300ms）
    this.setData({
      centerToast: { show: true, text: text, rendered: true, boxStyle: 'opacity:0;' }
    })

    const fadeInStart = Date.now()
    this._toastTimer = setInterval(() => {
      const elapsed = Date.now() - fadeInStart
      const t = Math.min(elapsed / 300, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      if (t >= 1) {
        clearInterval(this._toastTimer)
        this._toastTimer = null
        this.setData({ centerToast: { ...this.data.centerToast, boxStyle: 'opacity:1;' } })
      } else {
        this.setData({ centerToast: { ...this.data.centerToast, boxStyle: `opacity:${eased};` } })
      }
    }, 16)

    // 2. 停留 2 秒后上滑消失（400ms）
    this._toastAnimTimer = setTimeout(() => {
      const slideStart = Date.now()
      this._toastTimer = setInterval(() => {
        const elapsed = Date.now() - slideStart
        const t = Math.min(elapsed / 400, 1)
        const eased = 1 - Math.pow(1 - t, 3)
        const translateY = -2000 * eased
        if (t >= 1) {
          clearInterval(this._toastTimer)
          this._toastTimer = null
          this.setData({ centerToast: { show: false, text: '', rendered: false, boxStyle: '' } })
        } else {
          this.setData({ centerToast: { ...this.data.centerToast, boxStyle: `opacity:1;transform:translateY(${translateY}rpx);` } })
        }
      }, 16)
    }, 2000)
  },

});
