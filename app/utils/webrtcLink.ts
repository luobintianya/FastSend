import type { LinkType } from '~/types/transfer'

function isPrivateAddress(address?: string | null): boolean {
  if (!address) {
    return false
  }
  const ip = address.replace(/^\[/, '').replace(/\]$/, '').split('%')[0]
  if (ip === '::1' || ip === 'localhost' || ip.endsWith('.local')) {
    return true
  }
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')
  }
  const parts = ip.split('.')
  if (parts.length !== 4) {
    return false
  }
  const a = Number(parts[0])
  const b = Number(parts[1])
  if (a === 10 || a === 127) {
    return true
  }
  if (a === 192 && b === 168) {
    return true
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }
  if (a === 169 && b === 254) {
    return true
  }
  return false
}

function isTcpProtocol(...values: Array<string | undefined | null>): boolean {
  return values.some((value) => String(value || '').toLowerCase() === 'tcp')
}

function isStunType(type?: string) {
  return type === 'srflx' || type === 'prflx'
}

function classify(
  localType?: string,
  remoteType?: string,
  localAddr?: string,
  remoteAddr?: string,
  localProtocol?: string,
  remoteProtocol?: string
): LinkType {
  if (localType === 'relay' || remoteType === 'relay') {
    return isTcpProtocol(localProtocol, remoteProtocol) ? 'relayTcp' : 'relay'
  }
  // STUN 打洞：srflx / prflx 就是公网直连
  if (isStunType(localType) || isStunType(remoteType)) {
    return 'wan'
  }
  if (isPrivateAddress(localAddr) && isPrivateAddress(remoteAddr)) {
    return 'lan'
  }
  if (localType === 'host' && remoteType === 'host') {
    return 'lan'
  }
  if (localAddr && remoteAddr) {
    return 'wan'
  }
  return 'unknown'
}

export const LINK_RANK: Record<LinkType, number> = {
  lan: 4,
  wan: 3,
  relay: 2,
  relayTcp: 1,
  unknown: 0
}

export function preferLinkType(a: LinkType, b: LinkType): LinkType {
  return LINK_RANK[a] >= LINK_RANK[b] ? a : b
}

function classifyPair(
  local?: { type?: string; address?: string; ip?: string; protocol?: string; candidateType?: string },
  remote?: { type?: string; address?: string; ip?: string; protocol?: string; candidateType?: string }
): LinkType {
  return classify(
    local?.type || local?.candidateType,
    remote?.type || remote?.candidateType,
    local?.address || local?.ip,
    remote?.address || remote?.ip,
    local?.protocol,
    remote?.protocol
  )
}

/**
 * 根据当前 ICE 选中的 candidate pair 判断是局域网、公网直连还是中继。
 */
export async function inspectWebRTCLink(pc: RTCPeerConnection): Promise<{
  selected: LinkType
  best: LinkType
}> {
  let selected: LinkType = 'unknown'
  let best: LinkType = 'unknown'
  try {
    const pair = pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.()
    if (pair?.local && pair?.remote) {
      selected = classifyPair(pair.local, pair.remote)
      best = selected
    }
  } catch {
    // 部分浏览器尚未暴露 iceTransport
  }

  try {
    const stats = await pc.getStats()
    const candidates = new Map<string, any>()
    const pairReports: any[] = []
    stats.forEach((report) => {
      if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
        candidates.set(report.id, report)
      }
      if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
        pairReports.push(report)
      }
    })
    let nominated: LinkType = 'unknown'
    for (const report of pairReports) {
      const type = classifyPair(
        candidates.get(report.localCandidateId),
        candidates.get(report.remoteCandidateId)
      )
      best = preferLinkType(best, type)
      if (report.nominated || report.selected) {
        nominated = preferLinkType(nominated, type)
      }
    }
    // 展示和锁定都以当前真正在用的 pair 为准，不要用「统计里更好的 succeeded pair」覆盖
    if (selected === 'unknown') {
      selected = nominated !== 'unknown' ? nominated : best
    }
  } catch {
    // ignore
  }
  return { selected, best }
}

export async function detectWebRTCLinkType(pc: RTCPeerConnection): Promise<LinkType> {
  const { selected } = await inspectWebRTCLink(pc)
  return selected
}
