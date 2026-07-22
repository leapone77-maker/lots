// utils/user.js - 登录态管理（本地缓存）
var user = {
  token: '',
  info: null,
  init: function() {
    this.token = wx.getStorageSync('jq_token') || ''
    this.info = wx.getStorageSync('jq_user') || null
  },
  set: function(token, info) {
    this.token = token
    this.info = info
    wx.setStorageSync('jq_token', token)
    wx.setStorageSync('jq_user', info)
  },
  clear: function() {
    this.token = ''
    this.info = null
    wx.removeStorageSync('jq_token')
    wx.removeStorageSync('jq_user')
  },
  isLogin: function() {
    return !!this.token
  }
}

user.init()
module.exports = user
