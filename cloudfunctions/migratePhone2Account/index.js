/**
 * 一次性迁移脚本：把 users / memories 集合中的 phone 字段改名为 account
 *
 * 使用方法：
 *   1. 在微信开发者工具中，右键 cloudfunctions/migratePhone2Account → 上传并部署：云端安装依赖
 *   2. 在开发者工具控制台或任意页面调用一次：
 *        wx.cloud.callFunction({ name: 'migratePhone2Account' })
 *   3. 迁移完成后可删除本云函数
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async function(event, context) {
  let usersUpdated = 0
  let usersRemoved = 0
  let memoriesUpdated = 0
  let memoriesRemoved = 0
  let usersSkipped = 0
  let memoriesSkipped = 0

  // 1. 迁移 users 集合
  const usersCol = db.collection('users')
  const usersRes = await usersCol.where({ phone: _.exists(true) }).get()
  const usersList = usersRes.data || []

  for (let i = 0; i < usersList.length; i++) {
    const doc = usersList[i]
    try {
      await usersCol.doc(doc._id).update({
        data: {
          account: doc.phone,
          phone: _.remove()
        }
      })
      usersUpdated++
      usersRemoved++
    } catch (e) {
      console.error('[migrate] users 失败 _id=' + doc._id, e.message || e)
      usersSkipped++
    }
  }

  // 2. 迁移 memories 集合
  const memoriesCol = db.collection('memories')
  const memRes = await memoriesCol.where({ phone: _.exists(true) }).get()
  const memList = memRes.data || []

  for (let i = 0; i < memList.length; i++) {
    const doc = memList[i]
    try {
      await memoriesCol.doc(doc._id).update({
        data: {
          account: doc.phone,
          phone: _.remove()
        }
      })
      memoriesUpdated++
      memoriesRemoved++
    } catch (e) {
      console.error('[migrate] memories 失败 _id=' + doc._id, e.message || e)
      memoriesSkipped++
    }
  }

  return {
    code: 0,
    msg: '迁移完成',
    users: { total: usersList.length, updated: usersUpdated, removed: usersRemoved, skipped: usersSkipped },
    memories: { total: memList.length, updated: memoriesUpdated, removed: memoriesRemoved, skipped: memoriesSkipped }
  }
}
