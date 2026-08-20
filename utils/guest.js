// utils/guest.js - 设备游客ID + 登录后同步游客记录
// 未登录时：抽签/咨询以 guestId 为 uid 写入云端 draws 表（跨重装前设备内持久）；
// 登录成功后：调 mergeGuest 把游客记录一次性并入账号（同一天冲突保留最早一条）。

function getGuestId() {
  let g = '';
  try { g = wx.getStorageSync('guestId') || ''; } catch (e) { g = ''; }
  if (!g) {
    g = 'guest_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    try { wx.setStorageSync('guestId', g); } catch (e) {}
  }
  return g;
}

// 登录成功回调里调：有游客记录就并入账号，无则云函数直接返回 merged:0
function mergeGuestOnLogin(token) {
  const guestId = getGuestId();
  if (!token || !guestId) return;
  wx.cloud.callFunction({
    name: 'jieqian',
    data: { action: 'mergeGuest', token: token, guestId: guestId }
  }).catch(function () {});
}

module.exports = { getGuestId, mergeGuestOnLogin };
