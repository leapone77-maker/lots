const { QIAN_DB } = require('../../utils/qianData.js');
const { getBeijingDateStr } = require('../../utils/dateUtil.js');
const config = require('../../utils/config.js');
const guest = require('../../utils/guest.js');

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
    localMode: false,
    showConfetti: false,
    // 锦鲤背景：koiTransform 走 CSS transition，JS 只在换目标点时才 setData
    koiReady: false,
    koiTransform: 'translate3d(0,0,0)',
    koiFlip: 'scaleX(1)',
    koiDuration: 0
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
    // 抽签音效（竹签碰撞声，本地音频）
    this._drawAudio = wx.createInnerAudioContext();
    this._drawAudio.src = 'audio/draw_shake.mp3';
    // 开签铃声（清脆 bling，本地音频）
    this._blingAudio = wx.createInnerAudioContext();
    this._blingAudio.src = 'audio/bling.mp3';
    this._initKoi();
  },

  onHide() {
    this._koiClear();
  },

  onUnload() {
    this._koiClear();
  },

  /* ===================== 锦鲤背景 =====================
   * 游动靠 CSS transition 补间，JS 只在「选新目标点」时 setData 一次，
   * 频率约 3~8 秒一次，不占 JS 线程、不卡。
   * 锦鲤层 z-index:0，签筒/二维码等主功能 z-index>=2，所以能游到它们背后藏起来。
   * ================================================== */

  _initKoi() {
    const sys = wx.getSystemInfoSync();
    const w = sys.windowWidth;
    const h = sys.windowHeight;
    const sx = w / 750;                 // rpx -> px（750rpx = 屏宽）
    this._koi = {
      w, h, sx,
      clipW: 252 * sx,                  // 与 wxss 中 .koi-clip 的 252rpx / 140rpx 对应（v3 舒展素材）
      clipH: 140 * sx,
      x: w * (0.25 + Math.random() * 0.5),
      y: h * (0.3 + Math.random() * 0.25),
      speed: 42,                        // px/s，慢悠悠地游
      timer: null,
      restTimer: null
    };
    const t = this._koi;
    this.setData({
      koiReady: true,
      koiTransform: `translate3d(${t.x - t.clipW / 2}px, ${t.y - t.clipH / 2}px, 0)`,
      koiFlip: 'scaleX(1) rotate(-12deg)',
      koiDuration: 0,
      koiTiming: 'ease-in-out'
    });
    this._koiSchedule(700 + Math.random() * 900);
  },

  _koiSchedule(delay) {
    const t = this._koi;
    if (!t) return;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this._koiSwim(), delay);
  },

  // 游动范围边界：顶部导航之下、二维码引流区之上，可游到签筒背后
  _koiBounds() {
    const t = this._koi;
    const m = 14;
    return {
      m: m,
      top: 92 * t.sx + 20,                          // 顶部导航栏之下
      bottom: t.h - 450 * t.sx                      // 二维码引流区（约450rpx含底部间距）之上
    };
  },

  // 随机挑下一个目标点：主要横向游，偏离水平不超过 35°，避免垂直乱窜
  _koiSwim() {
    const t = this._koi;
    const b = this._koiBounds();
    let tx = t.x, ty = t.y;
    for (let i = 0; i < 10; i++) {
      const goRight = Math.random() < 0.5;
      const rad = ((goRight ? 0 : 180) + (Math.random() * 70 - 35)) * Math.PI / 180;
      const dist = 100 + Math.random() * 260;       // 步长拉长，覆盖更大范围
      tx = t.x + Math.cos(rad) * dist;
      ty = t.y + Math.sin(rad) * dist;
      if (tx >= b.m && tx <= t.w - b.m && ty >= b.top && ty <= b.bottom) break;
    }
    tx = Math.min(Math.max(tx, b.m), t.w - b.m);
    ty = Math.min(Math.max(ty, b.top), b.bottom);
    this._koiMoveTo(tx, ty, t.speed);
  },

  // timing: 正常游 'ease-in-out'；点击加速 'cubic-bezier(0.2,0.6,0.3,1)' 柔和起步、尾段减速
  _koiMoveTo(tx, ty, speed, timing) {
    const t = this._koi;
    const dx = tx - t.x;
    const dy = ty - t.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 26) {                    // 目标太近，重新挑
      this._koiSchedule(400);
      return;
    }
    const goRight = dx >= 0;
    // 防翻滚：容器只平移（translate3d），永远不 rotate；
    // 方向+倾角全在 flip 层：scaleX(±1) 镜像 + rotate(-12deg) 摆头，0.3s 完成，
    // 最大倾角就 12°，绝不可能转 180° 或鱼肚朝上。
    const flip = goRight ? -1 : 1;
    const dur = Math.min(6000, (dist / speed) * 1000);

    t.x = tx;
    t.y = ty;
    this.setData({
      koiTransform: `translate3d(${tx - t.clipW / 2}px, ${ty - t.clipH / 2}px, 0)`,
      koiFlip: `scaleX(${flip}) rotate(-12deg)`,
      koiDuration: Math.round(dur),
      koiTiming: timing || 'ease-in-out'
    });

    // 游到位后停一会儿，再继续下一段
    clearTimeout(t.restTimer);
    t.restTimer = setTimeout(() => {
      this._koiSchedule(1300 + Math.random() * 2800);
    }, dur + 80);
  },

  // 点到锦鲤附近：朝远离手指的方向游开；60px/s 加速，但只加速这一段，到位后恢复正常。
  // 绑在 page 根容器上（冒泡），做距离判定，避免鱼游到签筒/二维码背后时点不中
  onTapKoi(e) {
    const t = this._koi;
    if (!t) return;
    const d = e.detail || {};
    const tk = (e.touches && e.touches[0]) || {};
    const px = typeof d.x === 'number' ? d.x : (typeof tk.clientX === 'number' ? tk.clientX : t.w / 2);
    const py = typeof d.y === 'number' ? d.y : (typeof tk.clientY === 'number' ? tk.clientY : t.h / 2);
    // 只有点在以鱼为中心、半径 130px 内才算"点鱼"，否则是页面其它交互，忽略
    const dist = Math.sqrt((px - t.x) * (px - t.x) + (py - t.y) * (py - t.y));
    if (dist > 130) return;
    let dx = t.x - px, dy = t.y - py;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    const b = this._koiBounds();
    const tx = Math.min(Math.max(t.x + dx * 260, b.m), t.w - b.m);
    const ty = Math.min(Math.max(t.y + dy * 210, b.top), b.bottom);
    // 60px/s + 起步柔和冲刺、尾段平滑减速，只作用这一段，到位后下一段恢复常速 ease-in-out
    this._koiMoveTo(tx, ty, 60, 'cubic-bezier(0.2, 0.6, 0.3, 1)');
  },

  _koiClear() {
    const t = this._koi;
    if (!t) return;
    clearTimeout(t.timer);
    clearTimeout(t.restTimer);
  },

  // 撒花 canvas 按需挂载：canvas 在真机是原生组件，渲染在独立原生层，
  // 常驻全屏会挡住整屏触摸事件（pointer-events 对原生组件无效），
  // 所以只有抽签开签瞬间才挂载，动画播完立即卸载。
  launchConfetti() {
    if (this._confettiRunning) return;
    this._confettiRunning = true;
    this._confettiNode = null;
    this._confettiCtx = null;
    this.setData({ showConfetti: true }, () => {
      this._initConfettiCanvas(() => this._runConfetti());
    });
  },

  _initConfettiCanvas(onReady) {
    const q = wx.createSelectorQuery();
    q.select('#confettiCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        this._confettiRunning = false;
        this.setData({ showConfetti: false });
        return;
      }
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
      const dpr = info.pixelRatio || 1;
      canvas.width = res[0].width * dpr;
      canvas.height = res[0].height * dpr;
      ctx.scale(dpr, dpr);
      this._confettiNode = canvas;
      this._confettiCtx = ctx;
      this._confettiW = res[0].width;
      this._confettiH = res[0].height;
      if (onReady) onReady();
    });
  },

  _runConfetti() {
    const canvas = this._confettiNode;
    const ctx = this._confettiCtx;
    if (!canvas || !ctx) {
      this._confettiRunning = false;
      this.setData({ showConfetti: false });
      return;
    }
    const W = this._confettiW || 300;
    const H = this._confettiH || 600;
    const cx = W / 2;
    const cy = H * 0.4;
    const colors = ['#EF9F27', '#D85A30', '#D4537E', '#378ADD', '#639922', '#7F77DD', '#E24B4A', '#F59E0B'];
    const ps = [];
    for (let i = 0; i < 64; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = (0.012 + Math.random() * 0.012) * Math.max(W, H);
      ps.push({
        x: cx, y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        size: 4 + Math.random() * 7,
        color: colors[i % colors.length],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        shape: Math.random() < 0.45 ? 1 : 0
      });
    }
    const dur = 1000;
    const start = Date.now();
    const step = () => {
      const t = Date.now() - start;
      const prog = t / dur;
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of ps) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        const a = Math.max(0, 1 - prog);
        if (a > 0.01) alive = true;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 0) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const s = p.size;
          ctx.beginPath();
          ctx.moveTo(0, -s);
          ctx.lineTo(s * 0.25, -s * 0.25);
          ctx.lineTo(s, 0);
          ctx.lineTo(s * 0.25, s * 0.25);
          ctx.lineTo(0, s);
          ctx.lineTo(-s * 0.25, s * 0.25);
          ctx.lineTo(-s, 0);
          ctx.lineTo(-s * 0.25, -s * 0.25);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      if (t < dur && alive) {
        canvas.requestAnimationFrame(step);
      } else {
        ctx.clearRect(0, 0, W, H);
        this._confettiRunning = false;
        // 动画播完立即卸载 canvas，恢复整屏可点击
        this.setData({ showConfetti: false });
      }
    };
    canvas.requestAnimationFrame(step);
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
    // 从详情页/后台回来，恢复锦鲤游动（onHide 时已清定时器）
    if (this._koi) this._koiSchedule(600 + Math.random() * 900);
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

    // 播放抽签音效（竹签碰撞声）
    if (this._drawAudio) {
      this._drawAudio.stop();
      this._drawAudio.seek(0);
      this._drawAudio.play();
    }

    // 阶段1：摇晃 2.0s
    setTimeout(() => {
      this.setData({ isShaking: false, isFlying: true });
    }, 2000);

    // 阶段2（2.6s）：飞签已飞出屏幕外 + 出结果 + 弹悬浮签
    setTimeout(() => {
      const qian = QIAN_DB[Math.floor(Math.random() * QIAN_DB.length)];
      const todayStr = getBeijingDateStr();

      // 缓存今日签（供详情页读取）
      wx.setStorageSync('lastDrawDate', todayStr);
      wx.setStorageSync('cachedQian', {
        date: todayStr,
        id: qian.id,
        level: qian.level,
        poemText: Array.isArray(qian.poem) ? qian.poem.join('\n') : qian.poem,
        poemRaw: qian.poem,
        basic: qian.basic,
        yiji: qian.yiji || '',
        action: qian.action || '',
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
        poemText: Array.isArray(qian.poem) ? qian.poem.join('\n') : qian.poem,
        poemRaw: qian.poem,
        basic: qian.basic,
        yiji: qian.yiji || '',
        action: qian.action || ''
      });
      wx.setStorageSync('drawHistory', history.slice(0, 100));

      // 已登录则同步云端记忆
      if (this.data.isLoggedIn) {
        this._saveMemory(`抽到第${qian.id}签 ${qian.level}`);
      }

      // 当日签号同步云端（供历史页跨设备展示）：已登录用 token，未登录用设备游客ID；localMode 纯本地不同步
      if (!this.data.localMode) {
        const drawToken = (this.data.isLoggedIn && this.data.userInfo) ? this.data.userInfo.token : '';
        wx.cloud.callFunction({
          name: 'jieqian',
          data: {
            action: 'recordDraw',
            token: drawToken,
            guestId: drawToken ? '' : guest.getGuestId(),
            date: todayStr,
            sign: qian.id
          }
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

      // 开签仪式感：清脆铃声 + 轻震 + 撒花粒子
      if (this._blingAudio) {
        this._blingAudio.stop();
        this._blingAudio.seek(0);
        this._blingAudio.play();
      }
      try { wx.vibrateShort({ type: 'light' }); } catch (e1) {
        try { wx.vibrateShort(); } catch (e2) {}
      }
      this.launchConfetti();

      // 悬浮签 2 秒后自动隐藏
      setTimeout(() => this.setData({ floatingSign: false }), 2000);

      // 第3.3s：跳转详情页
      setTimeout(() => {
        wx.navigateTo({
          url: `/pages/detail/detail?id=${qian.id}&level=${encodeURIComponent(qian.level)}`
        });
      }, 700);
    }, 2600);
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
    guest.mergeGuestOnLogin(token);   // 把登录前的游客抽签/聊天记录并入账号
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
      title: '趣签一根·好运连连🍀',
      path: '/pages/index/index',
      imageUrl: '/images/jieqian-share-fu.png'
    };
  },

  onShareTimeline() {
    return {
      title: '趣签一根·好运连连🍀',
      imageUrl: '/images/jieqian-share-fu.png'
    };
  }
});
