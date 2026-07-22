// utils/memory.js - 长期记忆：保存/读取/轻量自动提取
var cloud = require('./cloud.js')

function saveMemory(event, cat, tag) {
  var token = cloud.getToken()
  if (!token) return Promise.resolve(false)
  return cloud.callCloud('saveMemory', { event: event, cat: cat || '其他', tag: tag || '' }, token)
    .then(function() { return true })
    .catch(function(e) { console.warn('saveMemory failed', e); return false })
}

function loadMemories() {
  var token = cloud.getToken()
  if (!token) return Promise.resolve([])
  return cloud.callCloud('getMemories', {}, token)
    .catch(function() { return [] })
}

// 轻量关键词提取：命中生活重大事件则视为可记忆
var MEMORY_KEYWORDS = [
  '换工作', '跳槽', '分手', '离婚', '结婚', '生病', '创业', '考试',
  '买房', '搬家', '离职', '考研', '投资', '负债', '升职', '失恋', '失业'
]

function maybeExtract(text) {
  if (!text) return null
  for (var i = 0; i < MEMORY_KEYWORDS.length; i++) {
    var k = MEMORY_KEYWORDS[i]
    if (text.indexOf(k) !== -1) {
      return { event: '用户提到：' + k, cat: '近况', tag: k }
    }
  }
  return null
}

module.exports = {
  saveMemory: saveMemory,
  loadMemories: loadMemories,
  maybeExtract: maybeExtract
}
