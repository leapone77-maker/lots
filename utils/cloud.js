// utils/cloud.js - 微信云函数调用封装
function callCloud(action, data, token) {
  return new Promise(function(resolve, reject) {
    wx.cloud.callFunction({
      name: 'jieqian',
      data: {
        action: action,
        token: token || '',
        ...data
      }
    }).then(function(res) {
      var result = res.result || {}
      if (result.code === 0) resolve(result.data)
      else reject(new Error(result.msg || '请求失败'))
    }).catch(function(err) {
      reject(new Error((err && err.errMsg) || '网络请求失败'))
    })
  })
}

function getToken() {
  return wx.getStorageSync('jq_token') || ''
}

module.exports = { callCloud: callCloud, getToken: getToken }
