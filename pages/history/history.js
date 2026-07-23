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
    selectedDate: ''
  },

  onLoad() {
    this._initNavBar();
    this._initToday();
    this._loadHistory();
  },

  /* ========== 动态导航栏（与胶囊对齐）========== */
  _initNavBar() {
    const menu = wx.getMenuButtonBoundingClientRect();
    this.setData({
      navBarTop: menu.top,
      navBarHeight: menu.height
    });
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
    const records = wx.getStorageSync('drawHistory') || [];

    // 统计
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

    // 按选中日期筛选 + 重建日历标记
    this._filterByDate(this.data.selectedDate);
    this._buildCalendar(this.data.year, this.data.month);
  },

  /* ========== 日历生成 ========== */
  _buildCalendar(year, month) {
    const firstDay = new Date(year, month - 1, 1).getDay(); // 0=周日
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // 获取当月有记录的日期集合
    const recordDates = new Set();
    this.data.allRecords.forEach(r => {
      if (r.date) recordDates.add(r.date.slice(0, 10));
    });

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
    if (!dateStr) {
      const all = this.data.allRecords.map(r => ({
        ...r,
        badgeText: '第' + (r.id || '?') + '签'
      }));
      this.setData({ filteredRecords: all });
      return;
    }
    const filtered = this.data.allRecords
      .filter(r => r.date && r.date.startsWith(dateStr))
      .map(r => ({
        ...r,
        badgeText: '第' + (r.id || '?') + '签'
      }));
    this.setData({ filteredRecords: filtered });
  },

  /* ========== 显示全部记录 ========== */
  showAllRecords() {
    this.setData({
      selectedDate: '',
      filteredRecords: this.data.allRecords
    });
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

  /* ========== 点击某条记录 → 跳转详情页 ========== */
  onRecordTap(e) {
    const idx = e.currentTarget.dataset.index;
    const record = this.data.filteredRecords[idx];
    if (!record) return;

    // 将该次签的数据写入缓存，跳转到详情页查看
    wx.setStorageSync('cachedQian', {
      date: record.date ? record.date.slice(0, 10) : '',
      id: record.id,
      level: record.level,
      poemText: '',
      poemRaw: [],
      basic: record.basic || null,
      keywords: []
    });
    wx.navigateTo({
      url: `/pages/detail/detail?id=${record.id}&level=${encodeURIComponent(record.level || '')}`
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
      title: '云鹏解绪 - 咨询历史',
      path: '/pages/index/index',
      imageUrl: '/images/jieqian-logo-peng.png'
    };
  }
});
