const QIAN_DB = require('../../utils/qianData.js');
const { getBeijingDateStr } = require('../../utils/dateUtil.js');
const config = require('../../utils/config.js');

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
    userInfo: null,
    localMode: false
  },

  onLoad() {
    this._initNavBar();
    this.initSticks();
    this.appConfig = config.getCachedConfig();
    this.setData({ localMode: !!this.appConfig.localMode });
    this.checkDailyLimit();
    // 拉取后台开关，拿到最新值后重算（热更新）
    config.fetchConfig().then((cfg) => {
      this.appConfig = cfg;
      this.setData({ localMode: !!cfg.localMode });
      this.checkDailyLimit();
    });
    this.checkLogin();
    this._loadSerifFont();
  },

  // 从详情页 navigateBack 返回时，首页不会被销毁、onLoad 不重跑，
  // 必须在这里重算每日限制，否则 canDraw 停留在抽前状态导致可反复抽签
  onShow() {
    // 首屏 onLoad 已完整初始化（含一次 fetchConfig + checkLogin），跳过本次双拉；
    // 之后从详情页返回时再热更新开关 + 重算每日限制 + 刷新登录态
    if (!this._inited) { this._inited = true; return }
    this._checkDayRollover();
    this.appConfig = config.getCachedConfig();
    this.setData({ localMode: !!this.appConfig.localMode });
    this.checkDailyLimit();
    this.checkLogin();
    config.fetchConfig().then((cfg) => {
      this.appConfig = cfg;
      this.setData({ localMode: !!cfg.localMode });
      this.checkDailyLimit();
      this.checkLogin();
    });
  },

  // 跨天重置：用户从后台切回前台时，若已跨过 0 点且当前 canDraw=false，
  // 立即刷新为可抽签（避免一直挂在前台过 0 点后无法重抽的问题）
  _checkDayRollover() {
    const todayStr = getBeijingDateStr();
    const lastDate = wx.getStorageSync('lastDrawDate') || '';
    if (lastDate && lastDate !== todayStr && !this.data.canDraw) {
      // 跨天了 + 当前按钮还是禁用的 → 强制启用，清旧签
      wx.removeStorageSync('cachedQian');
      this.setData({ canDraw: true });
      console.log('[跨天] 已重置抽签状态，今天日期:', todayStr);
    }
  },

  /* ========== 动态导航栏（与胶囊对齐）========== */
  _initNavBar() {
    const menu = wx.getMenuButtonBoundingClientRect();
    this.setData({
      navBarTop: menu.top,
      navBarHeight: menu.height
    });
  },

  /* ========== 加载思源宋体（真机需配置 downloadFile 合法域名 cdn.jsdelivr.net）========== */
  _loadSerifFont() {
    wx.loadFontFace({
      family: 'SourceHanSerifSC',
      source: 'url("https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.2.5/files/noto-serif-sc-chinese-simplified-400-normal.woff")',
      desc: { weight: 'normal', style: 'normal' },
      fail: (err) => console.warn('[阿鹏趣签] 思源宋体加载失败：', err)
    });
  },

  /* ========== 竹签初始化 ========== */
  initSticks() {
    const sticks = [];
    const bodyColors = ['#E8C86B', '#DEB887', '#F0D890', '#D4A84B', '#EDD084', '#C9A355'];
    const tipColor = '#C43028';
    const n = 13;
    for (let i = 0; i < n; i++) {
      const baseX = 15 + (i / (n - 1)) * 144;
      const x = baseX + (Math.random() - 0.5) * 8;
      const center = (i - (n - 1) / 2) / ((n - 1) / 2);
      const arc = (1 - center * center) * 22;
      const h = 36 + Math.floor(arc + Math.random() * 24);
      const bodyColor = bodyColors[i % bodyColors.length];
      sticks.push({
        x: Math.max(8, Math.min(184, x)),
        h,
        w: 10 + Math.floor(Math.random() * 6),
        rot: -10 + Math.floor(Math.random() * 21),
        bg: `linear-gradient(180deg, ${tipColor} 0%, ${tipColor} 18%, ${bodyColor} 18%, ${bodyColors[(i + 1) % bodyColors.length]} 100%)`,
        br: '3rpx 3rpx 1rpx 1rpx'
      });
    }
    this.setData({ sticks });
  },

  /* ========== 每日抽签限制（受后台 testMode 开关控制）========== */
  checkDailyLimit() {
    const cfg = this.appConfig || config.getCachedConfig();
    if (cfg.testMode) {
      this.setData({ canDraw: true });
      return;
    }
    const todayStr = getBeijingDateStr();
    const lastDate = wx.getStorageSync('lastDrawDate') || '';
    const cachedQian = wx.getStorageSync('cachedQian');
    this.setData({ canDraw: lastDate !== todayStr || !cachedQian });
  },

  /* ========== 跳转历史页（localMode=false 时需登录）========== */
  goHistory() {
    // 本地模式或已登录 → 直接跳转
    if (this.data.localMode || this.data.isLoggedIn) {
      wx.navigateTo({ url: '/pages/history/history' });
      return;
    }
    // 未登录 → 弹登录框，记录待执行动作
    this._pendingNav = '/pages/history/history';
    this.setData({ showLogin: true });
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

    // 阶段2（2.8s）：飞签已飞出屏幕外 + 出结果 + 弹悬浮签
    setTimeout(() => {
      const qian = QIAN_DB[Math.floor(Math.random() * QIAN_DB.length)];
      const todayStr = getBeijingDateStr();

      // 缓存今日签（供详情页读取）
      wx.setStorageSync('lastDrawDate', todayStr);
      wx.setStorageSync('cachedQian', {
        date: todayStr,
        id: qian.id,
        level: qian.level,
        poemText: Array.isArray(qian.poem) ? qian.poem.join('，') : qian.poem,
        poemRaw: qian.poem,
        basic: qian.basic,
        keywords: qian.keywords || []
      });

      // 历史记录（完整数据，供历史页展示）
      const history = wx.getStorageSync('drawHistory') || [];
      history.unshift({
        date: todayStr,
        time: new Date().toTimeString().slice(0, 5),
        id: qian.id,
        level: qian.level,
        poemTitle: qian.poem[0] || '',
        basic: qian.basic
      });
      wx.setStorageSync('drawHistory', history.slice(0, 100));

      // 已登录则同步云端记忆
      if (this.data.isLoggedIn) {
        this._saveMemory(`抽到第${qian.id}签 ${qian.level}`);
      }

      // 已登录则把当日签号同步云端（供历史页跨设备展示）
      if (this.data.isLoggedIn && this.data.userInfo && this.data.userInfo.token) {
        wx.cloud.callFunction({
          name: 'jieqian',
          data: { action: 'recordDraw', token: this.data.userInfo.token, date: todayStr, sign: qian.id }
        }).catch(() => {});
      }

      this.setData({
        isFlying: false,
        floatingSign: true,
        drawnId: qian.id,
        drawnIdChars: String(qian.id).split(''),
        drawnLevel: qian.level,
        canDraw: false
      });

      // 悬浮签 2 秒后自动隐藏
      setTimeout(() => this.setData({ floatingSign: false }), 2000);

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
      data: { action: 'saveMemory', content }
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
    const { account, token, nickname } = e.detail;
    if (!token) {
      wx.showToast({ title: '登录失败：未获取到凭证', icon: 'none' });
      return;
    }
    const userInfo = { account, token, nickname: nickname || '' };
    wx.setStorageSync('userInfo', userInfo);
    this.setData({ isLoggedIn: true, userInfo, showLogin: false });
    wx.showToast({ title: '登录成功', icon: 'success' });

    // 登录前触发的待执行动作（如点"历史"弹框）
    if (this._pendingNav) {
      const url = this._pendingNav;
      this._pendingNav = null;
      setTimeout(() => wx.navigateTo({ url }), 400);
    }
  },

  onCloseLogin() {
    this.setData({ showLogin: false });
  },

  /* ========== 分享 ========== */
  onShareAppMessage() {
    return {
      title: '阿鹏趣签 - 心诚则灵',
      path: '/pages/index/index',
      imageUrl: '/images/jieqian-logo-peng.png'
    };
  },

  onShareTimeline() {
    return {
      title: '阿鹏趣签 - 心诚则灵',
      imageUrl: '/images/jieqian-logo-peng.png'
    };
  }
});
