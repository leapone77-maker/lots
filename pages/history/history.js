const { QIAN_DB } = require('../../utils/qianData.js')

Page({
  data: {
    // 统计数据
    stats: { total: 0, shang: 0, zhong: 0, xia: 0 },
    // 日历状态
    year: 0,
    month: 0,
    weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    days: [],
    // 筛选后的记录
    filteredRecords: [],
    // 全部记录（原始）
    allRecords: [],
    // 选中的日期（用于筛选）
    selectedDate: '',
    // 所选日期是否有收藏签（「当日记录」标题行右侧⭐）
    selectedHasFavorite: false
  },

  onLoad() {
    this._initToday();
    this._loadHistory();
  },

  /* ========== 返回首页 ========== */
  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  onShow() {
    // 每次显示时刷新数据（可能从首页抽了新签）
    this._loadHistory();
  },

  /* ========== 初始化今天日期 ========== */
  _initToday() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    const todayStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    this.setData({ year: y, month: m, selectedDate: todayStr });
    this._buildCalendar(y, m);
  },

  /* ========== 加载历史记录 + 统计 + 筛选 ========== */
  _loadHistory() {
    const localRecords = wx.getStorageSync('drawHistory') || [];
    const userInfo = wx.getStorageSync('userInfo');
    const token = userInfo ? userInfo.token : '';
    if (token) {
      // 已登录：优先从云端拉取（跨设备一致），失败回退本地
      wx.cloud.callFunction({
        name: 'jieqian',
        data: { action: 'getHistory', token }
      }).then(res => {
        if (res.result && res.result.code === 0) {
          // 已登录以数据库为准（draws 为唯一来源），不合并本地缓存
          this._applyCloud(res.result.draws || {}, res.result.favs || {});
        } else {
          this._applyLocal(localRecords);
        }
      }).catch(() => this._applyLocal(localRecords));
    } else {
      // 未登录：仅本地
      this._applyLocal(localRecords);
    }
  },

  /* ========== 收藏工具：读取收藏集合（元素 {date, id}，key=日期_签号） ========== */
  _getFavSet() {
    const favs = wx.getStorageSync('favoriteQian') || [];
    const set = new Set();
    favs.forEach(f => set.add((f.date || '') + '_' + f.id));
    return set;
  },

  /* 本地收藏日期集合（供日历⭐用） */
  _getFavDates() {
    const set = new Set();
    (wx.getStorageSync('favoriteQian') || []).forEach(f => {
      if (f.date) set.add(f.date.slice(0, 10));
    });
    return set;
  },

  /* ========== 仅本地记录（未登录 / 云端异常回退）========== */
  _applyLocal(records) {
    this._cloudChats = {};
    this._favSet = this._getFavSet();
    this._favDates = this._getFavDates();
    let shang = 0, zhong = 0, xia = 0;
    records.forEach(r => {
      const lv = (r.level || '').trim();
      if (lv.includes('上')) shang++;
      else if (lv.includes('中')) zhong++;
      else if (lv.includes('下')) xia++;
    });
    this.setData({
      allRecords: records,
      stats: { total: records.length, shang, zhong, xia }
    });
    this._filterByDate(this.data.selectedDate);
    this._buildCalendar(this.data.year, this.data.month);
  },

  /* ========== 云端记录（已登录）：以数据库 draws 为唯一来源 ========== */
  _applyCloud(draws, favs) {
    // 红点/统计/列表统一只看抽签记录（与"当日记录"列表同口径），聊天不再标记红点
    this._cloudChats = {};
    // 叠加同会话内的收藏变更（详情页刚点收藏返回时，云端异步尚未写入，用全局暂存保证⭐即时可见）
    const app = getApp();
    const changes = (app && app.globalData && app.globalData.favChanges) || {};
    const mergedFavs = Object.assign({}, favs);
    Object.keys(changes).forEach(date => {
      const c = changes[date];
      if (c.favorite) mergedFavs[date] = c.id; else delete mergedFavs[date];
    });
    // 收藏集合：云端 favs（{date:sign}）优先，转成与本地一致的 key 集合
    const favSet = new Set();
    Object.keys(mergedFavs).forEach(date => {
      if (mergedFavs[date]) favSet.add(date + '_' + mergedFavs[date]);
    });
    this._favSet = favSet;
    // 收藏日期集合（供日历⭐用）
    this._favDates = new Set(Object.keys(mergedFavs));
    const records = [];
    Object.keys(draws).forEach(date => {
      const sign = draws[date];
      if (!sign) return;
      const q = QIAN_DB.find(x => x.id === sign);
      records.push({
        date,
        time: '',
        id: sign,
        level: q ? q.level : '未知',
        poemTitle: (q && q.poem && q.poem[0]) ? q.poem[0] : ('第' + sign + '签'),
        basic: q ? q.basic : null,
        yiji: q ? q.yiji : '',
        action: q ? q.action : ''
      });
    });
    records.sort((a, b) => b.date.localeCompare(a.date));
    let shang = 0, zhong = 0, xia = 0;
    records.forEach(r => {
      const lv = (r.level || '').trim();
      if (lv.includes('上')) shang++;
      else if (lv.includes('中')) zhong++;
      else if (lv.includes('下')) xia++;
    });
    this.setData({
      allRecords: records,
      stats: { total: records.length, shang, zhong, xia }
    });
    this._filterByDate(this.data.selectedDate);
    this._buildCalendar(this.data.year, this.data.month);
  },

  /* ========== 日历生成 ========== */
  _buildCalendar(year, month) {
    const firstDay = new Date(year, month - 1, 1).getDay(); // 0=周日
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // 获取当月有抽签记录的日期集合（红点与"当日记录"列表、统计同口径，只认抽签）
    const recordDates = new Set();
    this.data.allRecords.forEach(r => {
      if (r.date) recordDates.add(r.date.slice(0, 10));
    });
    // 收藏日期集合（收藏的签所在日期显示⭐，替代红点）
    // 已登录来自云端 _applyCloud 存的 _favDates；未登录来自本地 _applyLocal 存的
    const favDates = this._favDates || this._getFavDates();

    const days = [];
    // 上月填充
    const prevMonthDays = new Date(year, month - 1, 0).getDate();
    for (let i = firstDay - 1; i >= 0; i--) {
      days.push({
        day: prevMonthDays - i,
        isCurrentMonth: false,
        isToday: false,
        hasRecord: false,
        date: ''
      });
    }
    // 当月
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({
        day: d,
        isCurrentMonth: true,
        isToday: dateStr === todayStr,
        isSelected: dateStr === this.data.selectedDate,
        hasRecord: recordDates.has(dateStr),
        hasFavorite: favDates.has(dateStr),
        date: dateStr
      });
    }
    // 下月填充（补满6行）
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      days.push({
        day: i,
        isCurrentMonth: false,
        isToday: false,
        hasRecord: false,
        date: ''
      });
    }

    this.setData({ days });
  },

  /* ========== 月份切换 ========== */
  prevMonth() {
    let { year, month } = this.data;
    month--;
    if (month < 1) { month = 12; year--; }
    this.setData({ year, month });
    this._buildCalendar(year, month);
  },

  nextMonth() {
    let { year, month } = this.data;
    month++;
    if (month > 12) { month = 1; year++; }
    this.setData({ year, month });
    this._buildCalendar(year, month);
  },

  /* ========== 点击日期格子 ========== */
  onDayTap(e) {
    const date = e.currentTarget.dataset.date;
    if (!date) return;
    this.setData({ selectedDate: date });
    this._filterByDate(date);
    this._buildCalendar(this.data.year, this.data.month); // 刷新选中样式
  },

  /* ========== 按日期筛选记录 ========== */
  _filterByDate(dateStr) {
    const favSet = this._favSet || this._getFavSet();
    const filtered = this.data.allRecords
      .filter(r => r.date && r.date.startsWith(dateStr))
      .map(r => ({
        ...r,
        badgeText: '第' + (r.id || '?') + '签'
      }));
    // 所选日期有收藏签 → 「当日记录」标题行右侧显示⭐
    const selectedHasFavorite = filtered.some(r =>
      favSet.has((r.date ? r.date.slice(0, 10) : '') + '_' + r.id)
    );
    this.setData({ filteredRecords: filtered, selectedHasFavorite });
  },

  /* ========== 点击标题行⭐取消收藏 ========== */
  onUnfavorite() {
    const date = this.data.selectedDate;
    if (!date) return;
    // 找到该日期下被收藏的记录（取第一个，正常一天一条）
    const favSet = this._favSet || this._getFavSet();
    const target = this.data.filteredRecords.find(r =>
      favSet.has((r.date ? r.date.slice(0, 10) : '') + '_' + r.id)
    );
    if (!target) return;
    const id = target.id;

    // 1. 本地立即生效
    const favs = wx.getStorageSync('favoriteQian') || [];
    const key = date + '_' + id;
    const idx = favs.findIndex(f => (f.date + '_' + f.id) === key);
    if (idx >= 0) {
      favs.splice(idx, 1);
      wx.setStorageSync('favoriteQian', favs);
    }
    // 2. 刷新内存中的收藏集合（云端/本地两条路径统一重建）
    if (this._favSet) this._favSet.delete(key);
    if (this._favDates) this._favDates.delete(date);
    // 3. 写全局暂存（详情页若还开着，返回时收藏态也同步消失）
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.favChanges[date] = { id: id, favorite: false };
    }
    // 4. UI 刷新：⭐消失 + 日历红点回来
    this.setData({ selectedHasFavorite: false });
    this._buildCalendar(this.data.year, this.data.month);
    wx.showToast({ title: '已取消收藏', icon: 'none' });

    // 5. 已登录异步同步云端 draws 表（favorite=false）
    const userInfo = wx.getStorageSync('userInfo');
    const token = userInfo ? userInfo.token : '';
    if (token) {
      wx.cloud.callFunction({
        name: 'jieqian',
        data: { action: 'toggleFavorite', token, date, favorite: false }
      }).catch(() => {});
    }
  },

  /* ========== 清空历史 ========== */
  clearRecords() {
    wx.showModal({
      title: '确认清空',
      content: '确定要清空所有咨询历史吗？此操作不可恢复。',
      confirmColor: '#c0392b',
      success: (res) => {
        if (res.confirm) {
          wx.removeStorageSync('drawHistory');
          this._cloudChats = {};
          this.setData({
            allRecords: [],
            filteredRecords: [],
            stats: { total: 0, shang: 0, zhong: 0, xia: 0 }
          });
          this._buildCalendar(this.data.year, this.data.month);
          wx.showToast({ title: '已清空', icon: 'success' });
        }
      }
    });
  },

  /* ========== 点击某条记录 → 跳转详情页（带日期，详情页加载当天聊天）========== */
  onRecordTap(e) {
    const idx = e.currentTarget.dataset.index;
    const record = this.data.filteredRecords[idx];
    if (!record) return;

    // 用 QIAN_DB 补齐完整签诗（旧记录可能只存了 poemTitle）
    const fullQian = QIAN_DB.find(x => x.id === record.id) || {};
    const poemArr = fullQian.poem || [];
    const dateStr = record.date ? record.date.slice(0, 10) : '';
    wx.setStorageSync('cachedQian', {
      date: dateStr,
      id: record.id,
      level: record.level || fullQian.level || '未知',
      poemText: poemArr.join('\n'),
      poemRaw: poemArr,
      basic: record.basic || fullQian.basic || null,
      yiji: record.yiji || fullQian.yiji || '',
      action: record.action || fullQian.action || '',
      keywords: fullQian.keywords || []
    });
    wx.navigateTo({
      url: `/pages/detail/detail?id=${record.id}&level=${encodeURIComponent(record.level || '')}&date=${encodeURIComponent(dateStr)}`
    });
  },

  /* ========== WXML 辅助方法 ========== */
  recordBadge(level) {
    const num = this._toChineseNum(level);
    return `第${num}签`;
  },

  levelClass(level) {
    const lv = (level || '').trim();
    if (lv.includes('上')) return 'shang';
    if (lv.includes('中')) return 'zhong';
    if (lv.includes('下')) return 'xia';
    return 'zhong';
  },

  _toChineseNum(level) {
    // 从等级文字提取或用默认
    return level || '';
  },

  /* ========== 分享 ========== */
  onShareAppMessage() {
    return {
      title: '阿鹏趣签·咨询历史',
      path: '/pages/index/index',
      imageUrl: '/images/jieqian-share-fu.png'
    };
  }
});
