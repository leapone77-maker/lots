const QIAN_DB = require('../../utils/qianData.js');

Page({
  data: {
    sticks: [],
    isShaking: false,
    isFlying: false,
    floatingSign: false,
    canDraw: true,
    drawnId: 0,
    drawnIdChars: [],
    drawnLevel: '',
    showLogin: false,
    isLoggedIn: false,
    userInfo: null
  },

  onLoad() {
    // ===== 测试期：清空所有本地旧测试数据（正式发布时整段删除） =====
    [
      'lastDrawDate',      // 每日抽签日期标记
      'cachedQian',        // 今日签缓存
      'drawHistory',       // 历史抽签记录（测试数据主要来源）
      'localChatMessages', // 首页旧聊天记录（已弃用）
      'detailChatMessages',// 详情页聊天记录
      'userMemories',      // 云端记忆本地缓存
      'localMemories',     // 本地记忆标签
      'userInfo',          // 登录态
      'jq_token',          // 旧架构残留
      'jq_user',           // 旧架构残留
      'jq_current_qian'    // 旧架构残留
    ].forEach(k => wx.removeStorageSync(k));
    // =============================================================

    // 测试期：若已登录测试账号，同步清空云端记忆（正式发布时删除）
    const testUser = wx.getStorageSync('userInfo')
    if (testUser && testUser.token) {
      wx.cloud.callFunction({
        name: 'jieqian',
        data: { action: 'clearMemories', token: testUser.token }
      }).catch(() => {})
    }

    this.initSticks();
    this.checkDailyLimit();
    this.checkLogin();
    this._loadSerifFont();
  },

  /* ========== 加载思源宋体 ========== */
  _loadSerifFont() {
    wx.loadFontFace({
      family: 'SourceHanSerifSC',
      source: 'url("https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.2.5/files/noto-serif-sc-chinese-simplified-400-normal.woff")',
      desc: { weight: 'normal', style: 'normal' },
      success: () => console.log('[云鹏解绪] 思源宋体加载成功'),
      fail: (err) => console.warn('[云鹏解绪] 思源宋体加载失败：', err)
    });
  },

  /* ========== 竹签初始化 ========== */
  initSticks() {
    const sticks = [];
    const bodyColors = ['#E8C86B', '#DEB887', '#F0D890', '#D4A84B', '#EDD084', '#C9A355'];
    const tipColor = '#C43028';
    const n = 14;
    for (let i = 0; i < n; i++) {
      const baseX = 18 + (i / (n - 1)) * 144;
      const x = baseX + (Math.random() - 0.5) * 8;
      const center = (i - (n - 1) / 2) / ((n - 1) / 2);
      const arc = (1 - center * center) * 22;
      const h = 36 + Math.floor(arc + Math.random() * 24);
      const bodyColor = bodyColors[i % bodyColors.length];
      sticks.push({
        x: Math.max(8, Math.min(184, x)),
        h: h,
        w: 10 + Math.floor(Math.random() * 6),
        rot: -10 + Math.floor(Math.random() * 21),
        bg: `linear-gradient(180deg, ${tipColor} 0%, ${tipColor} 18%, ${bodyColor} 18%, ${bodyColors[(i + 1) % bodyColors.length]} 100%)`,
        br: '3rpx 3rpx 1rpx 1rpx'
      });
    }
    this.setData({ sticks });
  },

  /* ========== 每日一次限制（测试期放开）========== */
  checkDailyLimit() {
    // 测试期：强制放开限制
    this.setData({ canDraw: true });
    return;

    /* ===== 正式版时删除上面两行，启用以下代码 =====
    const todayStr = new Date().toISOString().slice(0, 10);
    const lastDate = wx.getStorageSync('lastDrawDate') || '';
    if (lastDate === todayStr) {
      const cachedQian = wx.getStorageSync('cachedQian');
      if (cachedQian) {
        this.setData({ canDraw: false });
      }
    } else {
      this.setData({ canDraw: true });
    }
    ===== 正式版代码结束 ===== */
  },

  /* ========== 跳转历史页 ========== */
  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  /* ========== 抽签主流程（动画 → 跳转详情页）========== */
  onDraw() {
    if (this.data.isShaking || this.data.isFlying || this.data.floatingSign) return;

    if (!this.data.canDraw) {
      wx.showToast({ title: '今日已求签，请明日再来', icon: 'none' });
      return;
    }

    this.setData({ isShaking: true, floatingSign: false });

    // 阶段1：摇晃 2.0s
    setTimeout(() => {
      this.setData({ isShaking: false, isFlying: true });
    }, 2000);

    // 阶段2（2.8s）：飞签已飞出屏幕外(0.8s) + 出结果 + 弹悬浮签
    setTimeout(() => {
      const randomIndex = Math.floor(Math.random() * QIAN_DB.length);
      const qian = QIAN_DB[randomIndex];

      // 缓存今日签（供详情页读取）
      const todayStr = new Date().toISOString().slice(0, 10);
      const qianCache = {
        id: qian.id,
        level: qian.level,
        poemText: Array.isArray(qian.poem) ? qian.poem.join('，') : qian.poem,
        poemRaw: qian.poem,
        basic: qian.basic,
        keywords: qian.keywords || []
      };
      wx.setStorageSync('lastDrawDate', todayStr);
      wx.setStorageSync('cachedQian', qianCache);

      // 历史记录（完整数据，供历史页展示）
      const history = wx.getStorageSync('drawHistory') || [];
      history.unshift({
        date: todayStr,
        time: new Date().toTimeString().slice(0, 5),
        id: qian.id,
        level: qian.level,
        poemTitle: qian.poem[0] || '', // 取首句作为标题
        basic: qian.basic
      });
      wx.setStorageSync('drawHistory', history.slice(0, 100));

      // 云端保存记忆
      if (this.data.isLoggedIn) {
        this._saveMemory(`抽到第${qian.id}签 ${qian.level}`);
      }

      // 飞签动画已完成（2.0s起飞 + 0.8s = 2.8s），隐藏飞签元素 + 弹出悬浮签
      this.setData({
        isFlying: false,
        floatingSign: true,
        drawnId: qian.id,
        drawnIdChars: String(qian.id).split(''),
        drawnLevel: qian.level
      });

      // 悬浮签 2 秒后自动隐藏
      setTimeout(() => {
        this.setData({ floatingSign: false });
      }, 2000);

      // 第3.0s：跳转详情页
      setTimeout(() => {
        wx.navigateTo({
          url: `/pages/detail/detail?id=${qian.id}&level=${encodeURIComponent(qian.level)}`
        });
      }, 200);

    }, 2800);
  },

  _saveMemory(content) {
    wx.cloud.callFunction({
      name: 'jieqian',
      data: { action: 'saveMemory', content: content }
    }).catch(() => {});
  },

  /* ========== 登录相关 ========== */
  checkLogin() {
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo) {
      this.setData({ isLoggedIn: true, userInfo });
    }
  },

  onLogin(e) {
    const { phone, token } = e.detail;
    if (!token) {
      wx.showToast({ title: '登录失败：未获取到凭证', icon: 'none' });
      return;
    }
    const userInfo = { phone, token };
    wx.setStorageSync('userInfo', userInfo);
    this.setData({ isLoggedIn: true, userInfo, showLogin: false });
    wx.showToast({ title: '登录成功', icon: 'success' });
  },

  onCloseLogin() {
    this.setData({ showLogin: false });
  },

  /* ========== 分享 ========== */
  onShareAppMessage() {
    return {
      title: '云鹏解绪 - 心诚则灵',
      path: '/pages/index/index',
      imageUrl: '/images/jieqian-logo-peng.png'
    };
  },

  onShareTimeline() {
    return {
      title: '云鹏解绪 - 心诚则灵',
      query: '',
      imageUrl: '/images/jieqian-logo-peng.png'
    };
  }
});
