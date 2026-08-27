import type { LinkType } from '~/types/transfer'

function isPrivateAddress(address?: string | null): boolean {
  if (!address) {
    return false
  }
  const ip = address.replace(/^\[/, '').replace(/\]$/, '').split('%')[0]
  if (ip === '::1' || ip === 'localhost') {
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

function classify(
  localType?: string,
  remoteType?: string,
  localAddr?: string,
  remoteAddr?: string
): LinkType {
  if (localType === 'relay' || remoteType === 'relay') {
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

/**
 * 根据当前 ICE 选中的 candidate pair 判断是局域网还是公网。
 */
export async function detectWebRTCLinkType(pc: RTCPeerConnection): Promise<LinkType> {
  try {
    const pair = pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.()
    if (pair?.local && pair?.remote) {
      return classify(pair.local.type, pair.remote.type, pair.local.address, pair.remote.address)
    }
  } catch {
    // 部分浏览器尚未暴露 iceTransport
  }

  try {
    const stats = await pc.getStats()
    const candidates = new Map<string, any>()
    let selected: any
    stats.forEach((report) => {
      if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
        candidates.set(report.id, report)
      }
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        if (!selected || report.nominated) {
          selected = report
        }
      }
    })
    if (selected) {
      const local = candidates.get(selected.localCandidateId)
      const remote = candidates.get(selected.remoteCandidateId)
      return classify(
        local?.candidateType,
        remote?.candidateType,
        local?.address || local?.ip,
        remote?.address || remote?.ip
      )
    }
  } catch {
    // ignore
  }
  return 'unknown'
}
