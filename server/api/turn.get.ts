import { createHmac } from 'node:crypto'

/**
 * 下发 coturn 时效凭证。默认只给 UDP（含 443），避免 ICE 抢先选中极慢的 TURN TCP。
 * TCP 由客户端在 UDP 建连失败后再追加。
 */
export default defineEventHandler((event) => {
  const host = getRequestHost(event).replace(/:\d+$/, '')
  const stunUrls = [`stun:${host}:443`, `stun:${host}:3478`]
  const secret = String(useRuntimeConfig(event).turnSecret || '')
  if (!secret) {
    return { urls: stunUrls, tcpUrls: [] as string[] }
  }

  const expiry = Math.floor(Date.now() / 1000) + 12 * 3600
  const username = `${expiry}:fs`
  const credential = createHmac('sha1', secret).update(username).digest('base64')

  return {
    username,
    credential,
    urls: [...stunUrls, `turn:${host}:443?transport=udp`, `turn:${host}:3478?transport=udp`],
    tcpUrls: [`turn:${host}:3478?transport=tcp`]
  }
})
