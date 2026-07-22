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
    _hasShownBasic: true  // 详情页自动展示解签，标记为已展示
  },

  onLoad(options) {
    this._initNavBar();
    // 从缓存读取今日签数据（首页抽签时已存入）
    const cachedQian = wx.getStorageSync('cachedQian');
    if (cachedQian) {
      this.setData({
        qian: cachedQian,
        hasDrawn: true,
        drawnId: cachedQian.id,
        drawnLevel: cachedQian.level,
        drawnPoem: cachedQian.poemText,
        drawnBasic: cachedQian.basic
      });
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
    }

    this.checkLogin();
    this.loadLocalChat();
    this._loadSerifFont();
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
  _initNavBar() {
    const menu = wx.getMenuButtonBoundingClientRect();
    this.setData({
      navBarTop: menu.top,
      navBarHeight: menu.height
    });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  /* ========== 本地聊天持久化 ========== */
  loadLocalChat() {
    // 详情页使用独立的聊天存储 key，与首页隔离
    const saved = wx.getStorageSync('detailChatMessages');
    if (saved && Array.isArray(saved) && saved.length > 0) {
      this.setData({
        chatMessages: saved,
        scrollToId: `msg-${saved[saved.length - 1].id}`
      });
    }
  },

  _persistChat() {
    const list = this.data.chatMessages.slice(-100);
    wx.setStorageSync('detailChatMessages', list);
  },

  /* ========== 登录相关 ========== */
  checkLogin() {
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      this.setData({ isLoggedIn: true, userInfo });
      this.loadMemories();
    }
  },

  loadMemories() {
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'getMemories' }
    }).then(res => {
      const memories = res.result?.memories || [];
      wx.setStorageSync('userMemories', memories);
    }).catch(() => {});
  },

  onLogin(e) {
    const { phone, token } = e.detail;
    if (!token) return;
    const userInfo = { phone, token };
    wx.setStorageSync('userInfo', userInfo);
    this.setData({ isLoggedIn: true, userInfo, showLogin: false });
    this.loadMemories();
    wx.showToast({ title: '登录成功', icon: 'success' });

    if (this._pendingQuestion) {
      const q = this._pendingQuestion;
      this._pendingQuestion = null;
      setTimeout(() => this.callAI(q), 300);
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
        content: '<div style="color:#A8201A;font-size:13px;line-height:1.6;">🙏 请先登录，云鹏才能记得您的故事</div>'
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

    // 已抽签 → 追加用户消息 + AI 对话
    this.setData({
      chatMessages: [...this.data.chatMessages, userMsg],
      inputValue: '',
      scrollToId: `msg-${userMsg.id}`
    });
    this._persistChat();

    // 显示"思考中"
    this._showThinking();

    // 未登录弹登录框
    if (!this.data.isLoggedIn) {
      this._pendingQuestion = content;
      this.setData({ showLogin: true });
      return;
    }

    // 提取记忆关键词
    this.extractMemory(content);

    // 调用 AI
    this.callAI(content);
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

  /* ========== AI 深度解读 ========== */
  callAI(userQuestion) {
    const memories = this.getAIMemory();
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
          content: '<div style="color:#c0392b;font-size:13px;line-height:1.6;">⚠️ 云鹏暂时无法解答：' + this._escHtml(errText) + '</div>'
        };
        this._replaceThinking(errMsg);
        this._persistChat();
        return;
      }
      const reply = res.result?.content || '云鹏正在思考，请稍后再试...';
      const aiMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        content: this.formatAIReply(reply)
      };
      this._replaceThinking(aiMsg);
      this._persistChat();
    }).catch(err => {
      console.error('[callAI] error:', err);
      const errMsg = {
        id: Date.now() + 1,
        role: 'assistant',
        content: '<div style="color:#c0392b;font-size:13px;line-height:1.6;">⚠️ 调用失败：' + this._escHtml(err.errMsg || err.message || '未知错误') + '</div>'
      };
      this._replaceThinking(errMsg);
      this._persistChat();
    });
  },

  /* ========== 格式化 AI 回复为 HTML ========== */
  formatAIReply(text) {
    // 先清洗：去掉 AI 可能原样引用的 HTML 标签残留 + Markdown 标记
    let cleaned = text
      // 去掉完整的 HTML 标签行（如 <div style="..."> 、</div> 等）
      .replace(/<\/?(div|span|p|br|section|article|strong|em|b|i|u|h[1-6]|ul|ol|li|blockquote|pre|code)\b[^>]*>/gi, '')
      // 去掉 Markdown 加粗 **text**
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      // 去掉单独的 ** 残留
      .replace(/\*\*/g, '')
      // 去掉空行
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const lines = cleaned.split('\n').filter(l => l.trim());
    const htmlParts = lines.map(line => {
      const trimmed = line.trim();
      // 跳过看起来还是 HTML 标签残留的行（以 < 开头或包含 style= 等）
      if (/^<[a-z\/!]/i.test(trimmed) || /^&lt;[a-z\/]/i.test(trimmed)) return '';
      const escaped = this._escHtml(trimmed);
      if (trimmed.length < 20 && !trimmed.includes('。')) {
        return '<span style="color:#A8201A;font-weight:bold;display:block;margin-top:12px;margin-bottom:6px;font-size:14px;padding-bottom:4px;border-bottom:1px solid rgba(168,32,26,0.18);">' + escaped + '</span>';
      }
      if (/^\d+\./.test(trimmed)) {
        const num = trimmed.match(/^\d+/)[0];
        const rest = escaped.replace(/^\d+\.\s*/, '');
        return '<span style="display:block;color:#333333;margin:6rpx 0;line-height:1.65;font-size:13px;"><span style="color:#A8201A;font-weight:bold;">' + num + '. </span>' + rest + '</span>';
      }
      return '<span style="display:block;color:#333333;margin:5rpx 0;line-height:1.65;font-size:13px;">' + escaped + '</span>';
    });
    return '<div style="padding:4rpx 0;">' + htmlParts.filter(Boolean).join('') + '</div>';
  },

  /* ========== 记忆系统 ========== */
  extractMemory(text) {
    const keywords = {
      love: [/失恋|分手|离婚|单身|恋爱|结婚|表白|前任|对象|伴侣|暧昧|相亲|订婚|领证/],
      career: [/升职|跳槽|辞职|失业|面试|入职|转正|加薪|降薪|裁员|创业|老板|同事|领导/],
      wealth: [/投资|理财|股票|基金|买房|买车|贷款|欠债|存款|奖金|分红|彩票/],
      health: [/生病|住院|手术|体检|失眠|焦虑|抑郁|减肥|健身|养生|感冒|发烧/],
      life: [/搬家|出国|留学|考研|考公|本命年|搬家|乔迁|毕业/]
    };

    const extracted = [];
    Object.keys(keywords).forEach(cat => {
      keywords[cat].forEach(re => {
        const match = text.match(re);
        if (match) {
          extracted.push({ tag: match[0], cat: cat, time: new Date().toISOString() });
        }
      });
    });

    if (extracted.length > 0 && this.data.isLoggedIn) {
      const memoryText = extracted.map(e => `[${e.cat}] ${e.tag}`).join(', ');
      this._saveMemory(memoryText);
      const localMemories = wx.getStorageSync('localMemories') || [];
      localMemories.push(...extracted.map(e => `${e.time.slice(0,10)} ${e.tag}`));
      wx.setStorageSync('localMemories', localMemories.slice(-30));
    }
  },

  getAIMemory() {
    const cloudMemories = wx.getStorageSync('userMemories') || [];
    const localMemories = wx.getStorageSync('localMemories') || [];
    const all = [...cloudMemories, ...localMemories];
    if (all.length === 0) return '';
    const unique = [...new Set(all)].slice(-10);
    return '【用户的个人背景与历史信息】以下是根据用户过往对话自动整理的关键信息，请在解读时自然地引用这些信息来拉近与用户的距离：\n' +
      unique.map(m => `- ${m}`).join('\n');
  },

  _saveMemory(content) {
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'saveMemory', content: content }
    }).catch(() => {});
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

  /* 去除 HTML 标签，提取纯文本（发给 AI 时用） */
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
      title: `云鹏解绪 - 第${this.data.drawnId || ''}签`,
      path: '/pages/index/index',
      imageUrl: '/images/jieqian-logo-peng.png'
    };
  }
});
