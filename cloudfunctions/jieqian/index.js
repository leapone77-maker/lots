/**
 * 阿鹏趣签 - 微信云函数（微信原生云开发）
 *
 * 部署方式：
 *   1. 在微信开发者工具中，右键 cloudfunctions/jieqian → 上传并部署：云端安装依赖
 *   2. 环境变量 ZHIPU_KEY 在 云开发控制台 → 云函数 → jieqian → 编辑 → 环境变量 中设置
 *
 * 数据库集合（需在云开发控制台手动创建）：
 *   - users    : { _id, phone, password, token, nickname, created }
 *   - memories: { _id, uid, phone, event, cat, tag, created }
 *   - app_config (后台开关，手动创建一次): 文档 _id='global'
 *        { testMode: bool, loginRequired: bool, localMode: bool, promoEnabled: bool }
 *        testMode=true 关闭每日抽签限制(测试态); loginRequired=true 要求手机号登录(记忆云端同步)
 *        localMode=true 纯本地模式(不连AI); promoEnabled=true 显示首页引流卡片(公众号+个人微信二维码)
 */
const cloud = require('wx-server-sdk')
const fs = require('fs')
const path = require('path')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const users = db.collection('users')
const memories = db.collection('memories')

// 智谱 GLM-4-Flash 密钥
// 优先读环境变量（云开发控制台设置），否则用内置 key
const ZHIPU_KEY = process.env.ZHIPU_KEY || 'dbc2baa0a8744885bc95d68315fd83fd.9R5ec8jBo73vFvt4'

function genToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

async function authByToken(token) {
  if (!token) return null
  const res = await users.where({ token }).get()
  if (res.data && res.data.length) return res.data[0]
  return null
}

/**
 * 身份锁定常量 —— 每次发送前校验，prompt 必须包含此身份，不可偏离
 */
const EXPECTED_IDENTITY = '解签大师'

/**
 * 单一来源：从 PROMPT.md 读取静态 System Prompt（身份 + 语气 + 格式要求）
 * 修改 PROMPT.md 后需重新「上传并部署」云函数方可生效
 */
let BASE_PROMPT = ''
try {
  BASE_PROMPT = fs.readFileSync(path.join(__dirname, 'PROMPT.md'), 'utf8').trim()
} catch (e) {
  // 兜底：PROMPT.md 缺失时仍保证身份正确，避免以错误身份作答
  BASE_PROMPT = '你是「解签大师」，一位隐居山林、精通易经卦象与签文的世外高人。\n你说话半文半白、温和而恳切，善于从签诗中读出求签人当下的处境与转机。'
}

/**
 * 身份校对：最终 prompt 必须包含 EXPECTED_IDENTITY，否则拦截发送
 */
function verifyIdentity(prompt) {
  if (!prompt || !prompt.includes(EXPECTED_IDENTITY)) {
    throw new Error('身份校验失败：System Prompt 未包含「' + EXPECTED_IDENTITY + '」，已阻止发送，避免以错误身份对外作答。')
  }
}

/**
 * 构建 System Prompt —— 基础提示词(PROMPT.md) + 动态签文/记忆
 */
function buildSystemPrompt(qian, memList, question) {
  let p = BASE_PROMPT

  // 签文信息（动态注入）
  if (qian) {
    p += '\n\n【当前签文】'
    p += '\n签号：' + (qian.id || '?') + '　等级：' + (qian.level || '?')
    const poemText = Array.isArray(qian.poem) ? qian.poem.join('，') : (qian.poem || '')
    p += '\n签诗：' + poemText
    if (qian.basic) {
      p += '\n\n基础解签：'
      p += '\n事业：' + (qian.basic.career || '')
      p += '\n感情：' + (qian.basic.love || '')
      p += '\n财运：' + (qian.basic.wealth || '')
      p += '\n健康：' + (qian.basic.health || '')
    }
  }

  // 用户记忆（核心卖点，动态注入）
  if (memList && memList.length > 0) {
    p += '\n\n【求签人的个人背景（长期记忆）】'
    p += '\n以下是该用户过往透露的重要人生事件/状态，这是你的"独家信息"。解读时必须自然地引用这些信息来拉近距离——就像老朋友一样记得对方说过的话。'
    p += '\n引用方式示例："刚好应了你本命年的转机""之前情感里的失意都是在为对的人清场""结合你最近提到的升职压力"...'
    p += '\n切忌不要生硬罗列记忆列表，而是将相关记忆有机织入解读正文的开头或对应段落。'
    memList.forEach(function(m) { p += '\n- ' + String(m) })
  }

  // 身份校验：每次发送前校对，不能偏离
  verifyIdentity(p)

  return p
}

/**
 * 调用智谱 GLM-4-Flash API
 */
async function callZhipu(systemContent, userQuestion, chatHistory) {
  const https = require('https')
  const url = new URL('https://open.bigmodel.cn/api/paas/v4/chat/completions')

  // 构建消息数组：system + 历史对话(如果有) + 当前问题
  const msgs = [
    { role: 'system', content: systemContent }
  ]

  // 追加最近的聊天历史（让AI理解上下文）
  if (Array.isArray(chatHistory)) {
    chatHistory.forEach(function(m) {
      msgs.push({ role: m.role || 'user', content: m.content || '' })
    })
  }

  // 追加当前问题
  msgs.push({ role: 'user', content: userQuestion })

  const body = JSON.stringify({
    model: 'glm-4-flash',
    messages: msgs,
    temperature: 0.85,
    max_tokens: 1000
  })

  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ZHIPU_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    }, function(res) {
      let data = ''
      res.on('data', function(chunk) { data += chunk })
      res.on('end', function() {
        try {
          var json = JSON.parse(data)
          if (!json || !json.choices || !json.choices[0]) {
            reject(new Error('智谱返回异常：' + data.slice(0, 200)))
            return
          }
          resolve(json.choices[0].message.content)
        } catch(e) {
          reject(new Error('智谱响应解析失败：' + data.slice(0, 200)))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

exports.main = async function(event, context) {
  var action = event.action

  try {
    // ---- 注册 / 登录（手机号+密码，自动注册）----
    if (action === 'register') {
      var phone = event.phone
      var password = event.password
      if (!phone || !/^1\d{10}$/.test(phone)) return { code: 1, msg: '手机号格式不正确' }
      if (!password) return { code: 1, msg: '请输入密码' }

      var res = await users.where({ phone }).get()
      var list = res.data || []

      if (list.length === 0) {
        // 自动注册（直接返回生成的 token，不再二次查询）
        var tk = genToken()
        var nick = '福主' + phone.slice(-4)
        await users.add({
          phone: phone,
          password: password,
          token: tk,
          nickname: nick,
          created: Date.now()
        })
        return { code: 0, token: tk }

      } else {
        // 已有账号，验证密码
        var user = list[0]
        if (user.password !== password) return { code: 1, msg: '密码错误' }
        // 刷新 token 并直接返回新 token
        var newTk = genToken()
        await users.doc(user._id).update({ data: { token: newTk } })
        return { code: 0, token: newTk }
      }
    }

    // ---- 保存记忆 ----
    if (action === 'saveMemory') {
      var ev = event.content || event.event
      if (!ev) return { code: 1, msg: '记忆内容为空' }
      // 尝试从token获取用户，没有则匿名存储
      var u = null
      var token = event.token
      if (token) u = await authByToken(token)

      await memories.add({
        uid: u ? u._id : '',
        phone: u ? u.phone : '',
        event: ev,
        cat: event.cat || '其他',
        tag: event.tag || '',
        created: new Date()
      })
      return { code: 0 }
    }

    // ---- 读取记忆 ----
    if (action === 'getMemories') {
      var token = event.token
      var u = await authByToken(token)
      if (!u) return { code: 401, memories: [] }
      var res = await memories
        .where({ uid: u._id })
        .orderBy('created', 'desc')
        .limit(50)
        .get()
      // 返回格式适配前端：memories 数组（每项有 event 字段）
      var list = (res.data || []).map(function(m) { return m.event || '' }).filter(Boolean)
      return { code: 0, memories: list }
    }

    // ---- AI 解签对话 ----
    if (action === 'chat') {
      var qian = event.currentQian || null       // 当前签文对象
      var memList = event.memories || []         // 记忆文本数组
      var question = event.question || event.message || ''
      var history = event.messages || []         // 聊天历史

      if (!question) return { code: 1, content: '请输入你的问题' }

      // 构建带记忆的 system prompt
      var systemPrompt = buildSystemPrompt(qian, memList, question)

      // 调用智谱
      var reply = await callZhipu(systemPrompt, question, history)

      return { code: 0, content: reply }
    }

    // ---- 清空全部测试数据（users + memories）----
    if (action === 'clearAllData') {
      const _ = db.command
      await users.where({ _id: _.exists(true) }).remove()
      await memories.where({ _id: _.exists(true) }).remove()
      return { code: 0, msg: 'users 与 memories 已清空' }
    }

    // ---- 读取后台开关（热更新，无需提交小程序版本）----
    // 集合 app_config 文档 _id='global'：{ testMode, loginRequired, localMode, promoEnabled }
    // 首次调用自动写入默认值；集合未创建时安全回退默认值，不报错
    if (action === 'getConfig') {
      const DEFAULTS = { testMode: false, loginRequired: false, localMode: true, promoEnabled: false }
      try {
        const col = db.collection('app_config')
        let doc = null
        try { doc = (await col.doc('global').get()).data } catch (e) { doc = null }
        if (!doc) {
          try {
            await col.add({ _id: 'global', testMode: false, loginRequired: false, localMode: true, promoEnabled: false, updatedAt: new Date() })
          } catch (e) { /* 集合不存在等，忽略，回退默认 */ }
          return { code: 0, config: DEFAULTS }
        }
        return {
          code: 0,
          config: {
            testMode: typeof doc.testMode === 'boolean' ? doc.testMode : DEFAULTS.testMode,
            // 兼容旧字段 phoneLoginRequired：改名过渡期读取旧值，避免已配"要求登录"的配置失效
            loginRequired: typeof doc.loginRequired === 'boolean'
              ? doc.loginRequired
              : (typeof doc.phoneLoginRequired === 'boolean' ? doc.phoneLoginRequired : DEFAULTS.loginRequired),
            localMode: typeof doc.localMode === 'boolean' ? doc.localMode : DEFAULTS.localMode,
            promoEnabled: typeof doc.promoEnabled === 'boolean' ? doc.promoEnabled : DEFAULTS.promoEnabled
          }
        }
      } catch (e) {
        return { code: 0, config: DEFAULTS }
      }
    }

    return { code: 1, msg: '未知操作：' + action }
  } catch (e) {
    console.error('[jieqian] error:', e)
    return { code: 500, msg: e.message || '服务器错误', content: '网络不佳，请稍后再试' }
  }
}
