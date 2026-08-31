import { pubIceServers } from '~/utils/publicStunList'

export type IceMode = 'stun' | 'turn' | 'tcp'

type TurnPayload = {
  urls?: string[]
  tcpUrls?: string[]
  username?: string
  credential?: string
}

let cache: { at: number; payload: TurnPayload } | null = null

function toServers(payload: TurnPayload, mode: IceMode): RTCIceServer[] {
  const servers: RTCIceServer[] = []
  const allowTurn = mode !== 'stun'
  const push = (url: string, asTurn: boolean) => {
    if (url.startsWith('stun:')) {
      servers.push({ urls: url })
      return
    }
    if (!asTurn || !payload.username || !payload.credential) {
      return
    }
    servers.push({
      urls: url,
      username: payload.username,
      credential: payload.credential
    })
  }
  for (const url of payload.urls || []) {
    push(url, allowTurn)
  }
  if (mode === 'tcp') {
    for (const url of payload.tcpUrls || []) {
      push(url, true)
    }
  }
  servers.push(...pubIceServers)
  return servers
}

/**
 * STUN + TURN 同时交给 ICE。优先级：局域网 > 公网直连 > UDP 中继；TCP 中继最后才启用。
 */
export async function getIceServers(opts?: {
  mode?: IceMode
  allowTcp?: boolean
}): Promise<RTCIceServer[]> {
  if (!cache || Date.now() - cache.at > 60e3) {
    try {
      const payload = await $fetch<TurnPayload>('/api/turn')
      cache = { at: Date.now(), payload: payload || {} }
    } catch {
      cache = { at: Date.now(), payload: {} }
    }
  }
  const mode: IceMode = opts?.mode || (opts?.allowTcp ? 'tcp' : 'turn')
  return toServers(cache.payload, mode)
}
