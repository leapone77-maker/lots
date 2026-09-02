const { QIAN_DB } = require('../../utils/qianData.js');
const { getBeijingDateStr } = require('../../utils/dateUtil.js');
const config = require('../../utils/config.js');
const guest = require('../../utils/guest.js');

// 锦鲤素材：本地动画 GIF 在 iOS image 组件里被冻结（系统级问题，绕不过），
// 改用 canvas 2d 逐帧绘制精灵图——与 Lottie 同原理，双端行为完全一致。
// 精灵图：12 帧 504×280 横向拼接（koi_sheet.png，PNG8 量化 218KB）；
const KOI_SHEET_SRC  = '/images/koi_sheet.png';
const KOI_FRAME_W = 504;     // 单帧像素宽（与源图一致）
const KOI_FRAME_H = 280;     // 单帧像素高
const KOI_FRAME_N = 12;      // 帧数
const KOI_FRAME_MS = 160;    // 每帧显示时长（ms）；源 GIF 为 80，现放慢至 160（12帧×160ms=1.92秒/遍）

// CSS easing 工具：cubic-bezier 缓动函数。_koiDrawLoop 在位移插值时调用，
// 避免依赖 CSS transition（原生 canvas 容器上的 transition 时序不可靠）
function _cubicBezier(p1x, p1y, p2x, p2y) {
  // 返回 f(t) -> 进度曲线，使用 Newton-Raphson 求解 x(t)=输入, y(t)=输出
  return (t) => {
    let s = t;
    for (let i = 0; i < 12; i++) {
      const oms = 1 - s, oms2 = oms * oms, oms3 = oms2 * oms;
      const s2 = s * s, s3 = s2 * s;
      const x = 3 * oms2 * s * p1x + 3 * oms * s2 * p2x + s3 - t;
      const dx = 3 * oms2 * p1x + 6 * oms * s * (p2x - p1x) + 3 * s2 * (1 - p2x);
      if (Math.abs(dx) < 1e-6) break;
      s -= x / dx;
      s = Math.max(0, Math.min(1, s));
    }
    const oms = 1 - s, oms2 = oms * oms, oms3 = oms2 * oms;
    const s2 = s * s, s3 = s2 * s;
    return 3 * oms2 * s * p1y + 3 * oms * s2 * p2y + s3;
  };
}
const _EASINGS = {
  'linear': (t) => t,
  'ease':          _cubicBezier(0.25, 0.1, 0.25, 1),
  'ease-in':       _cubicBezier(0.42, 0, 1, 1),
  'ease-out':      _cubicBezier(0, 0, 0.58, 1),
  'ease-in-out':   _cubicBezier(0.42, 0, 0.58, 1),
  // 受惊冲刺：起步极快（p1y 越大起步越猛），尾段急停（p2x 越大停得越干脆）
  'koi-dash':      _cubicBezier(0.08, 0.82, 0.42, 1)
};
function _applyEasing(t, name) {
  const fn = _EASINGS[name] || _EASINGS['ease-in-out'];
  return fn(t);
}

// ========== 点击逃窜参数（想调手感就改这里） ==========
const KOI_TAP = {
  JITTER_RAD: 0.5,        // 逃离方向的随机角度扰动（弧度）：0.5 ≈ ±29°。调大→方向更散更随机；调小→更像直线逃跑
  JITTER_RAD_RETRY: 1.2,  // 第一次落点被边界夹死时，重试放宽到的扰动范围（弧度）：1.2 ≈ ±69°
  RETRY_N: 8,             // 最多重试次数：找不到"纵向够明显"的落点，就多转几个角度再试
  MIN_DY_RATIO: 0.35,     // 纵向位移占比下限：|Δy|/总位移 ≥ 此值才算"非横向"。调大→上下逃窜更强制；调小→允许更平的逃跑路线
  DASH_X: 260,            // 横向冲刺距离下限（px），实际取 max(此值, 鱼宽×1.2)
  DASH_Y: 300,            // 纵向冲刺距离下限（px），实际取 max(此值, 鱼高×1.6)
  SPEED: 60,              // 冲刺速度（px/s）：调大→蹿得更快（同距离下时长更短）
  EASING: 'koi-dash',     // 冲刺缓动曲线，可选：'linear' / 'ease' / 'ease-in' / 'ease-out' / 'ease-in-out' / 'koi-dash'
  TAP_RADIUS_MIN: 130,    // "算点到鱼"的判定半径下限（px），实际取 max(此值, 鱼宽/2 + TAP_RADIUS_PAD)
  TAP_RADIUS_PAD: 30      // 判定半径在鱼半宽基础上再加的容错（px），调大→点鱼附近空白也算点到
};

// 缩放测试接口：null = 走云端本月抽签天数；填 22/30 等数字 = 强制显示第 N 天的尺寸
const KOI_DEBUG_DAY = null;
// 尺寸映射：第1天 scale 0.3（小只）→ 第30天 1.5（满大），线性；直接变尺寸，不做平滑过渡
const KOI_SCALE_MIN = 0.3;  // 第 1 天
const KOI_SCALE_MAX = 1.5;  // 第 30 天
const KOI_BASE_W = 252;   // rpx，scale=1.0 时宽度（与素材 504×280 的 2x 高清版对应 252×140rpx）
const KOI_BASE_H = 140;   // rpx

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
    // 锦鲤背景：位移由 JS rAF 在 _koiDrawLoop 里手动插值（避免 CSS transition 在
    // 原生 canvas 容器上的时序错乱，出现"瞬移"问题）
    koiReady: false,
    koiX: 0,                  // 鱼左上角 X (px) —— 跟随 _koi.currX
    koiY: 0,                  // 鱼左上角 Y (px) —— 跟随 _koi.currY
    koiLayerTop: 0,           // 锦鲤层 fixed 定位的 top 偏移（= 导航栏总高），由 _initNavBar 计算
    // 锦鲤显示尺寸（rpx），随本月抽签天数缩放：第1天 0.5 → 第30天 2.0
    koiW: KOI_BASE_W,
    koiH: KOI_BASE_H
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

  async _initKoi() {
    const sys = wx.getSystemInfoSync();
    const w = sys.windowWidth;
    const h = sys.windowHeight;
    const sx = w / 750;                 // rpx -> px（750rpx = 屏宽）
    // 先按调试天数或默认（第1天 0.5）起尺寸，马上能看见鱼；真实天数异步刷新
    const initScale = KOI_DEBUG_DAY !== null ? this._koiScaleFromDays(KOI_DEBUG_DAY) : 0.5;
    const startX = w * (0.25 + Math.random() * 0.5);
    const startY = h * (0.3 + Math.random() * 0.25);
    this._koi = {
      w, h, sx,
      scale: initScale,
      clipW: 0, clipH: 0,               // 由 _koiApplySize 计算
      currX: startX, currY: startY,     // 当前位置（rAF 维护）
      speed: 42,                        // px/s，慢悠悠地游
      dir: 'right',                     // 初始朝右
      move: null,                       // 当前移动状态：{ fromX, fromY, toX, toY, startTime, duration, timing }
      lastSetX: -1e9, lastSetY: -1e9,  // 上次 setData 的位置（哨兵值，勿用 NaN：NaN 参与比较恒为 false）
      timer: null,
      restTimer: null
    };
    const t = this._koi;
    this._koiApplySize();
    this.setData({
      koiReady: true,
      koiX: t.currX - t.clipW / 2,
      koiY: t.currY - t.clipH / 2
    }, () => {
      // setData 回调里 DOM 已就绪，初始化 canvas 节点 + 加载精灵图
      this._koiInitCanvas();
    });
    this._koiSchedule(700 + Math.random() * 900);
    // 非调试模式：拉云端本月抽签天数，更新为真实尺寸（直接变大，不做平滑过渡）
    if (KOI_DEBUG_DAY === null) {
      this._refreshKoiSize();
    }
  },

  // 天数 → 缩放比例：第1天 0.3 → 第30天 1.5，线性
  _koiScaleFromDays(days) {
    const d = Math.max(1, Math.min(30, days || 1));
    return KOI_SCALE_MIN + (KOI_SCALE_MAX - KOI_SCALE_MIN) * (d - 1) / 29;
  },

  // 拉云端本月抽签天数（去重）。失败或未部署时静默回退，锦鲤保持当前尺寸
  _fetchMonthDays() {
    const today = getBeijingDateStr();           // 形如 "2026-08-31"
    const month = today.slice(0, 7);             // "2026-08"
    const token = (this.data.isLoggedIn && this.data.userInfo) ? this.data.userInfo.token : '';
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'jieqian',
        data: {
          action: 'getKoiDays',
          token: token,
          guestId: token ? '' : guest.getGuestId(),
          month: month
        }
      }).then((res) => {
        const r = res.result || {};
        resolve(typeof r.days === 'number' ? r.days : 0);
      }).catch(() => resolve(0));
    });
  },

  // 按当前 scale 计算并应用尺寸：koiW/koiH(rpx) 给 wxml，clipW/clipH(px) 给 JS 定位
  _koiApplySize() {
    const t = this._koi;
    if (!t) return;
    const koiW = Math.max(60, Math.round(KOI_BASE_W * t.scale));
    const koiH = Math.max(34, Math.round(KOI_BASE_H * t.scale));
    t.clipW = koiW * t.sx;
    t.clipH = koiH * t.sx;
    this.setData({ koiW: koiW, koiH: koiH });
    // 尺寸变化后必须重设 canvas 缓冲（canvas.width=... 会清空并重置变换）
    if (this._koiCanvas) this._koiResizeCanvas();
  },

  // 云端天数回来后：更新尺寸 + 若新边界更窄则把当前位置收进边界内（直接变，不补间）
  async _refreshKoiSize() {
    const days = await this._fetchMonthDays();
    const t = this._koi;
    if (!t) return;
    const scale = this._koiScaleFromDays(days);
    if (Math.abs(scale - t.scale) < 0.001) return;
    t.scale = scale;
    this._koiApplySize();
    const b = this._koiBounds();
    t.currX = Math.min(Math.max(t.currX, b.m), t.w - b.m);
    t.currY = Math.min(Math.max(t.currY, b.top), b.bottom);
    this.setData({
      koiX: t.currX - t.clipW / 2,
      koiY: t.currY - t.clipH / 2
    });
    t.lastSetX = t.currX - t.clipW / 2;
    t.lastSetY = t.currY - t.clipH / 2;
  },

  // canvas 2d 锦鲤渲染：取节点 → 加载精灵图 → rAF 逐帧重绘
  // 画方向时用 ctx.scale(-1,1) 镜像，不动 CSS，彻底绕开 iOS 的合成层问题
  _koiInitCanvas() {
    const q = wx.createSelectorQuery();
    q.select('#koiCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        console.error('[koi] canvas 节点未找到');
        return;
      }
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      this._koiCanvas = canvas;
      this._koiCtx = ctx;
      this._koiResizeCanvas();
      // 加载精灵图
      const sheet = canvas.createImage();
      sheet.onload = () => {
        this._koiSheet = sheet;
        console.log('[koi] 精灵图加载成功, 尺寸', sheet.width + 'x' + sheet.height);
        this._koiStartDraw();
      };
      sheet.onerror = (err) => console.error('[koi] 精灵图加载失败:', err);
      sheet.src = KOI_SHEET_SRC;
    });
  },

  // 重设 canvas 像素缓冲（按当前尺寸 + dpr），同时清空并重置变换
  _koiResizeCanvas() {
    const canvas = this._koiCanvas, t = this._koi;
    if (!canvas || !t) return;
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    const dpr = info.pixelRatio || 1;
    canvas.width = Math.max(1, Math.round(t.clipW * dpr));
    canvas.height = Math.max(1, Math.round(t.clipH * dpr));
    this._koiDpr = dpr;
    this._koiLastFi = -1;     // 强制下一帧重绘
    this._koiLastDir = null;
  },

  // 启动 rAF 绘制循环（已在 setData 回调里确保 canvas 存在）
  _koiStartDraw() {
    if (this._koiRaf) return;     // 已经在跑
    this._koiDrawT0 = Date.now();
    this._koiDrawLoop();
  },

  // rAF 循环：算当前帧号 → 镜像方向 → 画一帧
  // 帧号/方向不变时跳过重绘，省电
  _koiDrawLoop() {
    const canvas = this._koiCanvas, ctx = this._koiCtx, t = this._koi;
    if (!canvas || !ctx || !t || !this._koiSheet) {
      this._koiRaf = null;
      return;
    }

    // —— 位移插值：根据 t.move 算当前 currX/currY ——
    if (t.move) {
      const elapsed = Date.now() - t.move.startTime;
      let p = Math.min(1, elapsed / t.move.duration);
      const eased = _applyEasing(p, t.move.timing);
      t.currX = t.move.fromX + (t.move.toX - t.move.fromX) * eased;
      t.currY = t.move.fromY + (t.move.toY - t.move.fromY) * eased;
      if (p >= 1) t.move = null;
    }
    // —— 同步鱼位置到 .koi-clip 容器的 left/top（按需 setData）——
    // ⚠️ 比较必须用 !(diff <= 0.5) 而不是 (diff > 0.5)：
    // 若 lastSetX 是 NaN，diff 也是 NaN，(NaN > 0.5) 恒为 false，会导致 setData 永不执行
    // （症状：鱼只在原地镜像翻转、位置不动）。取反写法对 NaN 也安全。
    const newKoiX = t.currX - t.clipW / 2;
    const newKoiY = t.currY - t.clipH / 2;
    if (!(Math.abs(newKoiX - t.lastSetX) <= 0.5) || !(Math.abs(newKoiY - t.lastSetY) <= 0.5)) {
      this.setData({ koiX: newKoiX, koiY: newKoiY });
      t.lastSetX = newKoiX;
      t.lastSetY = newKoiY;
    }

    const W = t.clipW, H = t.clipH;
    const dpr = this._koiDpr || 1;
    const dir = t.dir || 'right';
    const fi = Math.floor((Date.now() - this._koiDrawT0) / KOI_FRAME_MS) % KOI_FRAME_N;
    if (fi !== this._koiLastFi || dir !== this._koiLastDir) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      if (dir === 'left') { ctx.translate(W, 0); ctx.scale(-1, 1); }
      ctx.drawImage(this._koiSheet,
        fi * KOI_FRAME_W, 0, KOI_FRAME_W, KOI_FRAME_H,
        0, 0, W, H);
      ctx.restore();
      this._koiLastFi = fi;
      this._koiLastDir = dir;
    }
    this._koiRaf = canvas.requestAnimationFrame(() => this._koiDrawLoop());
  },

  // 停止 rAF 循环（onHide / onUnload / 清理时调用）
  _koiStopDraw() {
    if (this._koiRaf && this._koiCanvas) {
      try { this._koiCanvas.cancelAnimationFrame(this._koiRaf); } catch (e) {}
    }
    this._koiRaf = null;
  },

  _koiSchedule(delay) {
    const t = this._koi;
    if (!t) return;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this._koiSwim(), delay);
  },

  // 游动范围边界：顶部导航之下、二维码引流区之上，可游到签筒背后；
  // 边界随鱼尺寸自适应，保证整条鱼始终在范围内，不会半截伸出屏幕或导航区
  _koiBounds() {
    const t = this._koi;
    const m = Math.max(14, t.clipW / 2 + 6);
    return {
      m: m,
      top: 92 * t.sx + 20 + t.clipH / 2,          // 顶部导航栏之下（鱼完全在导航之下）
      bottom: t.h - 450 * t.sx - t.clipH / 2      // 二维码引流区（约450rpx）之上
    };
  },

  // 随机挑下一个目标点：主要横向游，偏离水平不超过 35°，避免垂直乱窜
  _koiSwim() {
    const t = this._koi;
    const b = this._koiBounds();
    let tx = t.currX, ty = t.currY;
    for (let i = 0; i < 10; i++) {
      const goRight = Math.random() < 0.5;
      const rad = ((goRight ? 0 : 180) + (Math.random() * 70 - 35)) * Math.PI / 180;
      const dist = 100 + Math.random() * 260;       // 步长拉长，覆盖更大范围
      tx = t.currX + Math.cos(rad) * dist;
      ty = t.currY + Math.sin(rad) * dist;
      if (tx >= b.m && tx <= t.w - b.m && ty >= b.top && ty <= b.bottom) break;
    }
    tx = Math.min(Math.max(tx, b.m), t.w - b.m);
    ty = Math.min(Math.max(ty, b.top), b.bottom);
    this._koiMoveTo(tx, ty, t.speed);
  },

  // timing: 正常游 'ease-in-out'；点击加速 'cubic-bezier(0.2,0.6,0.3,1)' 柔和起步、尾段减速
  // 不再 setData 设置 koiX/koiY —— 改用 rAF 在 _koiDrawLoop 里做插值，
  // 避免 CSS transition 在原生 canvas 容器上时序错乱（"瞬移"）
  _koiMoveTo(tx, ty, speed, timing) {
    const t = this._koi;
    const dx = tx - t.currX;
    const dy = ty - t.currY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 26) {                    // 目标太近，重新挑
      this._koiSchedule(400);
      return;
    }
    const newDir = (dx >= 0) ? 'right' : 'left';
    // ⚠️ 镜像方向在 canvas 里用 ctx.scale(-1,1) 实现（draw 时翻转），
    // 不在 DOM 节点上用 transform——任何 transform 都会把 canvas 提升到合成层、引发 iOS 渲染异常
    const dur = Math.min(6000, (dist / speed) * 1000);

    // 记录移动目标，rAF 在 _koiDrawLoop 中根据 startTime/duration 算 currX/currY
    t.move = {
      fromX: t.currX,
      fromY: t.currY,
      toX: tx,
      toY: ty,
      startTime: Date.now(),
      duration: dur,
      timing: timing || 'ease-in-out'
    };
    t.dir = newDir;

    // 游到位后停一会儿，再继续下一段
    clearTimeout(t.restTimer);
    t.restTimer = setTimeout(() => {
      this._koiSchedule(1300 + Math.random() * 2800);
    }, dur + 80);
  },

  // 点到锦鲤附近：朝远离手指的方向逃窜，支持任意方向（含明显上下），不翻滚
  // 方向仍用 canvas 镜像表达（水平翻转），不做 rotate 翻身
  onTapKoi(e) {
    const t = this._koi;
    if (!t) return;
    const d = e.detail || {};
    const tk = (e.touches && e.touches[0]) || {};
    const rawX = typeof d.x === 'number' ? d.x : (typeof tk.clientX === 'number' ? tk.clientX : t.w / 2);
    const rawY = typeof d.y === 'number' ? d.y : (typeof tk.clientY === 'number' ? tk.clientY : t.h / 2);
    // ⚠️ 坐标系换算：clientX/clientY 相对屏幕顶（含导航栏），
    // 而 currX/currY 相对 .koi-layer（fixed 且整体下移了 koiLayerTop 才和 .page 对齐）。
    // 必须减去 koiLayerTop，否则"手指位置"被算到鱼下方，鱼永远往上逃、被顶边界夹成纯横向。
    const px = rawX;
    const py = rawY - (this.data.koiLayerTop || 0);
    // 只有点在以鱼为中心、半径（随尺寸自适应）内才算"点鱼"，否则是页面其它交互，忽略
    const radius = Math.max(KOI_TAP.TAP_RADIUS_MIN, t.clipW / 2 + KOI_TAP.TAP_RADIUS_PAD);
    const dist = Math.sqrt((px - t.currX) * (px - t.currX) + (py - t.currY) * (py - t.currY));
    if (dist > radius) return;

    // 逃离方向 = 远离手指方向 + 随机角度扰动；被边界夹住则放宽扰动重试。
    // 判定用「纵向占比 |Δy|/总位移」而非绝对值：防止横向长冲刺被误判成"合格"而总是左右跑。
    let dx = t.currX - px, dy = t.currY - py;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    const baseAng = Math.atan2(dy, dx);
    const b = this._koiBounds();
    const dashX = Math.max(KOI_TAP.DASH_X, t.clipW * 1.2);
    const dashY = Math.max(KOI_TAP.DASH_Y, t.clipH * 1.6);
    let tx = t.currX, ty = t.currY;
    for (let i = 0; i < KOI_TAP.RETRY_N; i++) {
      const jr = i === 0 ? KOI_TAP.JITTER_RAD : KOI_TAP.JITTER_RAD_RETRY;
      const ang = baseAng + (Math.random() - 0.5) * 2 * jr;
      const dirX = Math.cos(ang), dirY = Math.sin(ang);
      tx = Math.min(Math.max(t.currX + dirX * dashX, b.m), t.w - b.m);
      ty = Math.min(Math.max(t.currY + dirY * dashY, b.top), b.bottom);
      const mDx = tx - t.currX, mDy = ty - t.currY;
      const mDist = Math.sqrt(mDx * mDx + mDy * mDy);
      // 纵向位移占比达标才算"朝不同方向逃"，纯横向会被拒绝并重试
      if (mDist > 1 && Math.abs(mDy) / mDist >= KOI_TAP.MIN_DY_RATIO) break;
    }
    // 冲刺段用专用缓动：起步猛、尾段急停；只作用这一段，到位后下一段恢复常速 ease-in-out
    this._koiMoveTo(tx, ty, KOI_TAP.SPEED, KOI_TAP.EASING);
  },

  _koiClear() {
    const t = this._koi;
    if (!t) return;
    clearTimeout(t.timer);
    clearTimeout(t.restTimer);
    this._koiStopDraw();
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
    if (this._koi) {
      if (this._koiSheet) this._koiStartDraw();
      this._koiSchedule(600 + Math.random() * 900);
    }
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
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    const statusBarHeight = info.statusBarHeight || 0;
    // 导航栏总高 = 状态栏 + (胶囊上间距 × 2) + 胶囊高度。
    // 锦鲤层用 position:fixed（触发 canvas 同层渲染，让 z-index 生效），
    // 需要把 fixed 的 top 下移一个导航栏高度，才能和 .page 的坐标系完全对齐，
    // 这样 JS 里的 koiX/koiY 无需任何补偿。
    const navBarTotal = statusBarHeight + (menu.top - statusBarHeight) * 2 + menu.height;
    this.setData({
      navBarTop: menu.top,
      navBarHeight: menu.height,
      koiLayerTop: navBarTotal
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
