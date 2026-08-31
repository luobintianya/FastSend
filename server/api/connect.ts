import { TTLCache } from '@isaacs/ttlcache'
import { increaseTransCount } from '../utils/TransCount'

const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/
const ROOM_STALE_MS = 60e3

// 客户端待初始化连接池，key是peer的id
const initPool = new TTLCache<string, any>({
  max: 8192,
  ttl: 600e3,
  dispose: (peer) => {
    if (!peer.isInited) {
      // 如果超时未初始化，则断开连接
      peer.close()
    }
  }
})

// 待连接连接池
// key为：连接ID
const waitConnectPool = new TTLCache<string, any>({
  max: 20000,
  ttl: 600e3,
  dispose: (peer) => {
    if (!peer.pairPeer) {
      peer.close()
    }
  }
})

// 已配对连接池
const initedPool = new TTLCache<string, any>({
  max: 20000,
  ttl: 30 * 60e3,
  dispose: (peer) => {
    peer.close()
  }
})

// 房间：同房间成员互相可见，信令在成员间转发
const rooms = new Map<string, { code: string; members: Map<string, any>; counted: boolean }>()

function isOpen(peer: any) {
  const state = peer?.readyState
  return state === 1 || state === 'OPEN' || state === 'open'
}

function sendJson(peer: any, payload: unknown) {
  try {
    peer.send(JSON.stringify(payload))
  } catch {
    // 连接可能已关闭
  }
}

function leaveRoom(peer: any) {
  const code = peer.roomCode
  if (!code) {
    return
  }
  const room = rooms.get(code)
  peer.roomCode = ''
  if (!room) {
    return
  }
  room.members.delete(peer.id)
  const leavePayload = {
    type: 'peerLeave',
    id: peer.id,
    user: peer.user || { nickname: 'unknown', avatarURL: '' }
  }
  for (const other of room.members.values()) {
    sendJson(other, leavePayload)
  }
  if (room.members.size === 0) {
    rooms.delete(code)
  }
}

// 断开并清理连接
function disposePeer(peer: any) {
  leaveRoom(peer)
  initPool.delete(peer.id)
  initedPool.delete(peer.id)
  try {
    peer.close()
  } catch {
    // ignore
  }
  if (peer.pairPeer && isOpen(peer.pairPeer)) {
    const other = peer.pairPeer
    peer.pairPeer = null
    other.pairPeer = null
    disposePeer(other)
  }
}

// 心跳检测，避免掉线
function heartbeat(peer: any) {
  if (peer.roomCode && peer.lastSeen && Date.now() - peer.lastSeen > ROOM_STALE_MS) {
    disposePeer(peer)
    return
  }
  sendJson(peer, { type: 'ping' })
  if (isOpen(peer)) {
    setTimeout(() => {
      heartbeat(peer)
    }, 5e3)
  }
}

// 初始化发送端
function initSend(peer: any) {
  if (peer.isInited) {
    return
  }
  let code = genDigitCode(4)
  let retryCount = 2048
  while (waitConnectPool.has(code)) {
    if (retryCount-- <= 0) {
      sendJson(peer, { type: 'err', data: -1, msg: 'Init code fail' })
      throw new Error('Init code fail')
    }
    // 碰撞时重新生成取件码
    code = genDigitCode(4)
  }
  waitConnectPool.set(code, peer)
  peer.isInited = true
  initPool.delete(peer.id)
  // 初始化发送端成功，返回连接码
  sendJson(peer, { type: 'code', code: code })
  heartbeat(peer)
}

// 初始化接收端
function initReceive(peer: any, code: string) {
  if (peer.pairPeer) {
    // throw new Error('Already paired')
    return
  }
  const targetPeer = waitConnectPool.get(code)
  if (!targetPeer || targetPeer.pairPeer) {
    sendJson(peer, { type: 'status', code: 404 })
    disposePeer(peer)
    return
  }
  targetPeer.pairPeer = peer
  peer.pairPeer = targetPeer

  waitConnectPool.delete(code)

  peer.isInited = true
  initedPool.set(peer.id, peer)
  initPool.delete(peer.id)
  initedPool.set(targetPeer.id, targetPeer)
  // 配对成功
  sendJson(peer, { type: 'status', code: 0 })
  heartbeat(peer)
  increaseTransCount()
}

function joinRoom(peer: any, rawCode: unknown, user: unknown, clientId: unknown) {
  const code = String(rawCode || '')
    .trim()
    .toUpperCase()
  if (!ROOM_CODE_RE.test(code)) {
    sendJson(peer, { type: 'err', data: -3, msg: 'Invalid room' })
    disposePeer(peer)
    return
  }

  if (peer.roomCode) {
    leaveRoom(peer)
  }

  let room = rooms.get(code)
  if (!room) {
    room = { code, members: new Map(), counted: false }
    rooms.set(code, room)
  }

  peer.user = user || { nickname: 'unknown', avatarURL: '' }
  peer.clientId = String(clientId || '').slice(0, 64) || peer.id
  peer.roomCode = code
  peer.isInited = true
  peer.lastSeen = Date.now()

  for (const other of [...room.members.values()]) {
    if (other.id !== peer.id && other.clientId && other.clientId === peer.clientId) {
      disposePeer(other)
    }
  }

  const hasOtherPeople = [...room.members.values()].some(
    (member) => member.id !== peer.id && member.clientId !== peer.clientId
  )

  room.members.set(peer.id, peer)
  initPool.delete(peer.id)

  sendJson(peer, {
    type: 'joined',
    room: code,
    selfId: peer.id,
    members: snapshotMembers(room, peer.id)
  })

  for (const other of room.members.values()) {
    if (other.id === peer.id) {
      continue
    }
    sendJson(other, {
      type: 'peerJoin',
      id: peer.id,
      user: peer.user
    })
  }

  heartbeat(peer)

  if (hasOtherPeople && !room.counted) {
    room.counted = true
    increaseTransCount()
  }
}

function handleRoomMessage(peer: any, data: any) {
  const room = rooms.get(peer.roomCode)
  if (!room) {
    return
  }

  if (data.type === 'updateUser') {
    peer.user = data.user || peer.user
    for (const other of room.members.values()) {
      if (other.id !== peer.id) {
        sendJson(other, { type: 'peerUser', id: peer.id, user: peer.user })
      }
    }
    return
  }

  if (data.type === 'chat') {
    const text = String(data.data?.text || '')
      .trim()
      .slice(0, 2000)
    const image = typeof data.data?.image === 'string' ? data.data.image.slice(0, 3e6) : ''
    if (!text && !image) {
      return
    }
    const to = String(data.to || '')
    const payload = {
      type: 'chat',
      from: peer.id,
      to: to || undefined,
      private: !!to,
      user: peer.user || { nickname: 'unknown', avatarURL: '' },
      data: { text, ...(image ? { image } : {}) }
    }
    if (to) {
      const target = room.members.get(to)
      if (target && target.id !== peer.id) {
        sendJson(target, payload)
      }
      return
    }
    for (const other of room.members.values()) {
      if (other.id !== peer.id) {
        sendJson(other, payload)
      }
    }
    return
  }

  if (
    data.to &&
    (data.type === 'offerFile' ||
      data.type === 'acceptFile' ||
      data.type === 'rejectFile' ||
      data.type === 'err')
  ) {
    const target = room.members.get(data.to)
    if (target) {
      sendJson(target, {
        type: data.type,
        from: peer.id,
        data: data.data
      })
    }
    return
  }

  if (data.type === 'sdp' || data.type === 'candidate') {
    const target = room.members.get(data.to)
    if (target) {
      sendJson(target, {
        type: data.type,
        from: peer.id,
        data: data.data
      })
    }
  }
}

export default defineWebSocketHandler({
  open(peer) {
    console.log(`${new Date().toISOString()} open: #${peer.id}`)
    peer.lastSeen = Date.now()
    initPool.set(peer.id, peer)
  },

  close(peer) {
    console.log(`${new Date().toISOString()} close: #${peer.id}`)
    disposePeer(peer)
  },

  message(peer: any, msg) {
    try {
      peer.lastSeen = Date.now()
      const data = JSON.parse(msg.text())
      if (data.type === 'pong') {
        return
      }
      if (data.type === 'leave') {
        disposePeer(peer)
        return
      }
      if (data.type === 'join') {
        joinRoom(peer, data.room, data.user, data.clientId)
      } else if (data.type === 'send') {
        // 发送端初始化
        initSend(peer)
      } else if (data.type === 'receive') {
        // 接收端初始化
        if (/^\d{4}$/.test(data.code)) {
          initReceive(peer, data.code)
        } else {
          // 如果code不是4位数字，则断开
          disposePeer(peer)
        }
      } else if (peer.roomCode) {
        handleRoomMessage(peer, data)
      } else if (peer.pairPeer) {
        peer.pairPeer.send(msg.text())
      }
      // 尚未 join / send / receive 时忽略（例如头像异步加载触发的 updateUser）
    } catch (e) {
      console.warn('ws message error', e)
      disposePeer(peer)
    }
  },

  error(peer, error) {
    console.warn(error)
    disposePeer(peer)
  }
})

function snapshotMembers(room: { members: Map<string, any> }, excludeId: string) {
  return [...room.members.entries()]
    .filter(([id]) => id !== excludeId)
    .map(([id, member]) => ({
      id,
      user: member.user || { nickname: 'unknown', avatarURL: '' }
    }))
}

function genDigitCode(length: number): string {
  if (length <= 0) {
    throw new Error('长度必须大于0')
  }

  let code = ''

  for (let i = 0; i < length; i++) {
    // 生成一个0到9之间的随机整数
    const digit = Math.floor(Math.random() * 10)
    // 将数字拼接到字符串中
    code += digit
  }

  return code
}
