import { pubIceServers } from '~/utils/publicStunList'

export type IceMode = 'stun' | 'turn' | 'tcp'

type TurnPayload = {
  urls?: string[]
  tcpUrls?: string[]
  username?: string
  credential?: string
}

let cache: { at: number; payload: TurnPayload } | null = null
let inflight: Promise<TurnPayload> | null = null

function loadPayload(): Promise<TurnPayload> {
  if (cache && Date.now() - cache.at <= 60e3) {
    return Promise.resolve(cache.payload)
  }
  // 并发调用共用同一个请求，避免 turn / tcp 两次重复拉取
  inflight ??= $fetch<TurnPayload>('/api/turn', { timeout: 3000 })
    .catch(() => ({}) as TurnPayload)
    .then((payload) => {
      cache = { at: Date.now(), payload: payload || {} }
      return cache.payload
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 提前预取 TURN 凭证 */
export function prefetchIceServers(): void {
  void loadPayload()
}

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
  const payload = await loadPayload()
  const mode: IceMode = opts?.mode || (opts?.allowTcp ? 'tcp' : 'turn')
  return toServers(payload, mode)
}
