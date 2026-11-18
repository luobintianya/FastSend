import { inspectWebRTCLink, LINK_RANK } from '~/utils/webrtcLink'

/**
 * PeerDataChannel 配置类
 */
interface PeerDataChannelConfig {
  iceServers?: RTCIceServer[]
  tcpIceServers?: RTCIceServer[]
  blockSize?: number
  initializeDataChannel?: boolean
  /** 碰撞时让步的一方。房间 mesh 里 ID 较小的为 polite */
  polite?: boolean
  /** 允许 ICE 使用 TCP / TURN TCP。默认关闭，避免跨网落到数 KB/s 的 TCP 中继 */
  allowTcp?: boolean
  /** DataChannel 仍未打开时，再过多久启用 TURN TCP */
  tcpAfterMs?: number
}

function isTcpCandidate(candidate?: string | null): boolean {
  return /(^| )tcp( |$)/i.test(candidate || '')
}

function stripTcpCandidates(sdp?: string): string | undefined {
  if (!sdp) {
    return sdp
  }
  return sdp
    .split(/\r?\n/)
    .filter((line) => !/^a=candidate:/i.test(line) || !isTcpCandidate(line))
    .join('\r\n')
}

function chunksByteLength(chunks: Array<string | ArrayBuffer>): number {
  let total = 0
  for (const chunk of chunks) {
    if (typeof chunk !== 'string') {
      total += chunk.byteLength
    }
  }
  return total
}

function concatBinary(chunks: Array<string | ArrayBuffer>): ArrayBuffer {
  const views: Uint8Array[] = []
  let total = 0
  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      continue
    }
    const view = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array()
    views.push(view)
    total += view.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const view of views) {
    out.set(view, offset)
    offset += view.byteLength
  }
  return out.buffer
}

/**
 * 封装用于点对点数据传输的 WebRTC 数据通道
 */
export class PeerDataChannel {
  private static readonly DEFAULT_BLOCK_SIZE = 65536
  private static readonly MAX_BUFFERED = 2 * 1024 * 1024
  private static readonly LOW_WATER = 512 * 1024

  private pc: RTCPeerConnection
  private dc: RTCDataChannel | null = null
  private receiveData: {
    startTime: number
    offset: number
    count: number
    type: string
    chunks: (string | ArrayBuffer)[]
  } = { startTime: 0, offset: 0, count: 0, type: '', chunks: [] }
  private pendingReceiveBytes = 0
  private sendPromiseReject: ((reason?: any) => void) | null = null
  private blockSize: number
  private isInitiator: boolean
  private polite: boolean
  private allowTcp: boolean
  private tcpIceServers?: RTCIceServer[]
  private tcpTimer?: ReturnType<typeof setTimeout>
  private upgrading = false
  private makingOffer = false
  private ignoreOffer = false
  private disposed = false
  private iceRestarted = false
  private promotedRank = 0
  private promotingDirect = false
  private pathLocked = false
  private promoteAttempts = 0
  private receiveWriteChain: Promise<void> = Promise.resolve()

  public onReceive: (
    data: ArrayBuffer | string,
    info: { size: number; duration: number }
  ) => Promise<void> = async () => {}
  public onSDP: (sdp: RTCSessionDescriptionInit) => void = () => {}
  public onICECandidate: (candidate: RTCIceCandidate) => void = () => {}
  public onError: (e: Error) => void = () => {}
  public onConnected: () => void = () => {}
  public onDispose: () => void = () => {}
  public onOpen: () => void = () => {}

  /**
   * 创建一个新的 PeerDataChannel 实例
   * @param config 配置
   */
  constructor(config: PeerDataChannelConfig = {}) {
    this.blockSize = config.blockSize || PeerDataChannel.DEFAULT_BLOCK_SIZE
    this.isInitiator = !!config.initializeDataChannel
    this.polite = config.polite ?? !this.isInitiator
    this.allowTcp = !!config.allowTcp
    this.tcpIceServers = config.tcpIceServers
    this.pc = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle'
    })

    this.setupPeerConnection()

    if (this.isInitiator) {
      this.initializeDataChannel()
    }

    const tcpAfter = config.tcpAfterMs ?? 8000
    if (this.tcpIceServers?.length) {
      this.tcpTimer = setTimeout(() => this.upgradeIce(this.tcpIceServers!, true), tcpAfter)
    }
  }

  private setupPeerConnection(): void {
    this.pc.ondatachannel = this.handleDataChannel.bind(this)
    this.pc.onnegotiationneeded = () => {
      this.reNegotiation().catch((e) => {
        console.error(e)
        this.onError(e instanceof Error ? e : new Error('Unknown error during renegotiation'))
      })
    }
    this.pc.onicecandidate = (e) => {
      if (!e.candidate) {
        return
      }
      if (!this.allowTcp && isTcpCandidate(e.candidate.candidate)) {
        return
      }
      this.onICECandidate(e.candidate)
    }
    this.pc.onicecandidateerror = (e) => {
      // console.warn(e)
      // ingore
    }
    this.pc.onconnectionstatechange = this.handleConnectionStateChange.bind(this)
  }

  private handleDataChannel(e: RTCDataChannelEvent): void {
    if (this.dc && this.dc.readyState === 'open') {
      return
    }
    this.dc = e.channel
    this.setupDataChannel()
  }

  private initializeDataChannel(): void {
    this.dc = this.pc.createDataChannel('dc', { ordered: true })
    this.setupDataChannel()
  }

  private setupDataChannel(): void {
    if (!this.dc) return
    this.dc.binaryType = 'arraybuffer'
    this.dc.bufferedAmountLowThreshold = PeerDataChannel.LOW_WATER
    this.dc.onmessage = (e) => {
      try {
        this.handleIncoming(e.data)
      } catch (error) {
        console.error(error)
        this.onError(error instanceof Error ? error : new Error('Data channel receive failed'))
      }
    }
    this.dc.onopen = () => {
      this.clearUpgradeTimers()
      this.onOpen()
    }
    if (this.dc.readyState === 'open') {
      this.clearUpgradeTimers()
      this.onOpen()
    }
  }

  private handleConnectionStateChange(): void {
    const state = this.pc.connectionState
    if (state === 'connected') {
      this.upgrading = false
      this.promotingDirect = false
      this.onConnected()
      return
    }
    if (this.dc?.readyState === 'open' && state !== 'failed' && state !== 'closed') {
      return
    }
    if ((this.upgrading || this.promotingDirect) && state !== 'closed' && state !== 'failed') {
      return
    }
    // disconnected 很常见（consent 检测、短暂丢包），浏览器会自己恢复。
    // 这时 restartIce 反而会把已经通的局域网 / 公网直连打断。
    if (state === 'failed') {
      if (!this.iceRestarted && !this.disposed && !this.pathLocked) {
        this.iceRestarted = true
        try {
          this.pc.restartIce()
          return
        } catch {
          // fall through
        }
      }
      this.teardown()
      return
    }
    if (state === 'closed') {
      this.teardown()
    }
  }

  private upgradeIce(servers: RTCIceServer[], allowTcp: boolean): void {
    if (this.disposed || this.dc?.readyState === 'open') {
      return
    }
    this.allowTcp = allowTcp
    this.upgrading = true
    this.iceRestarted = true
    try {
      this.pc.setConfiguration({
        iceServers: servers,
        iceCandidatePoolSize: 0,
        bundlePolicy: 'max-bundle'
      })
      this.pc.restartIce()
    } catch (error) {
      console.warn(error)
      this.upgrading = false
    }
  }

  private clearUpgradeTimers(): void {
    if (this.tcpTimer) {
      clearTimeout(this.tcpTimer)
      this.tcpTimer = undefined
    }
  }

  private handleIncoming(data: ArrayBuffer | string): void {
    const receiveData = this.receiveData
    if (receiveData.offset === receiveData.count) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      const dat = JSON.parse(text)
      this.receiveData = {
        startTime: Date.now(),
        offset: 0,
        count: dat.count,
        type: dat.type,
        chunks: []
      }
      return
    }

    receiveData.chunks.push(data)
    receiveData.offset++
    if (receiveData.offset !== receiveData.count) {
      return
    }

    const chunks = receiveData.chunks
    const type = receiveData.type
    const startTime = receiveData.startTime
    receiveData.chunks = []
    // 整条消息已收齐但还在写盘队列里排队：这部分字节仍要计入「已接收」，
    // 否则 chunks 一清空进度就会回跳。
    const queuedBytes = type === 'string' ? 0 : chunksByteLength(chunks)
    this.pendingReceiveBytes += queuedBytes
    this.receiveWriteChain = this.receiveWriteChain
      .then(async () => {
        const result = type === 'string' ? await new Blob(chunks).text() : concatBinary(chunks)
        // onReceive 会同步把字节记入上层计数，这里同时扣掉，避免重复统计
        this.pendingReceiveBytes = Math.max(0, this.pendingReceiveBytes - queuedBytes)
        await this.onReceive(result, {
          size: type === 'string' ? (result as string).length : (result as ArrayBuffer).byteLength,
          duration: Date.now() - startTime
        })
      })
      .catch((error) => {
        console.error(error)
        this.onError(error instanceof Error ? error : new Error('Data channel receive failed'))
      })
  }

  private getSendBlockSize(): number {
    return this.blockSize
  }

  /**
   * 发送数据，注意只能串行调用。
   * onProgress 报告已写入通道的 payload 字节（不含分帧头），实际出网量需再减去 bufferedAmount。
   */
  public async sendData(
    data: ArrayBuffer | string,
    onProgress?: (sentBytes: number) => void
  ): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('Data channel not initialized')
    }

    return new Promise<void>((resolve, reject) => {
      this.sendPromiseReject = reject
      const dc = this.dc!
      const payloadBytes = typeof data === 'string' ? 0 : data.byteLength
      const blockSize = this.getSendBlockSize()
      const count = Math.ceil(
        (typeof data === 'string' ? data.length : data.byteLength) / blockSize
      )
      let offset = 0
      let settled = false

      const reportProgress = () => {
        if (!payloadBytes || !onProgress) {
          return
        }
        onProgress(Math.min(payloadBytes, offset * blockSize))
      }

      const done = (error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        dc.onbufferedamountlow = null
        this.sendPromiseReject = null
        if (error) {
          reject(error)
        } else {
          if (payloadBytes) {
            onProgress?.(payloadBytes)
          }
          resolve()
        }
      }

      const pump = () => {
        if (settled) {
          return
        }
        try {
          dc.bufferedAmountLowThreshold = PeerDataChannel.LOW_WATER
          while (offset < count && dc.bufferedAmount < PeerDataChannel.MAX_BUFFERED) {
            const chunk = data.slice(blockSize * offset, blockSize * (offset + 1))
            dc.send(chunk as string)
            offset++
            reportProgress()
          }
          if (offset >= count) {
            done()
          }
        } catch (error) {
          done(error instanceof Error ? error : new Error('Data channel send failed'))
        }
      }

      dc.onbufferedamountlow = pump
      try {
        dc.send(JSON.stringify({ count, type: typeof data }))
        pump()
      } catch (error) {
        done(error instanceof Error ? error : new Error('Data channel send failed'))
      }
    })
  }

  /**
   * 重协商 SDP。仅发起方处理，避免 mesh 里双方同时 createOffer。
   */
  private async reNegotiation(): Promise<void> {
    if (!this.isInitiator || this.makingOffer) {
      return
    }
    try {
      this.makingOffer = true
      const offer = await this.pc.createOffer()
      if (this.pc.signalingState !== 'stable') {
        return
      }
      await this.pc.setLocalDescription(offer)
      if (this.pc.localDescription) {
        this.emitLocalDescription()
      }
    } catch (e) {
      console.error(e)
      this.onError(e instanceof Error ? e : new Error('Unknown error during renegotiation'))
      this.teardown()
    } finally {
      this.makingOffer = false
    }
  }

  /**
   * 设置远程 SDP
   * @param sdp SDP描述
   */
  public async setRemoteSDP(sdp: RTCSessionDescriptionInit): Promise<void> {
    try {
      const offerCollision =
        sdp.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable')
      this.ignoreOffer = !this.polite && offerCollision
      if (this.ignoreOffer) {
        return
      }
      if (offerCollision) {
        try {
          await this.pc.setLocalDescription({ type: 'rollback' })
        } catch {
          // 部分浏览器不支持 rollback，继续尝试 setRemoteDescription
        }
      }
      await this.pc.setRemoteDescription(this.sanitizeRemoteSdp(sdp))
      if (sdp.type === 'offer') {
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        this.emitLocalDescription()
      }
    } catch (e) {
      console.error(e)
      this.onError(e instanceof Error ? e : new Error('Error setting remote SDP'))
      this.teardown()
    }
  }

  /**
   * 添加一个 ICE candidate
   * @param candidate ICE candidate
   */
  public async addICECandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.allowTcp && isTcpCandidate(candidate.candidate)) {
      return
    }
    await this.pc.addIceCandidate(candidate)
  }

  private sanitizeRemoteSdp(sdp: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    if (this.allowTcp || !sdp.sdp) {
      return sdp
    }
    return { ...sdp, sdp: stripTcpCandidates(sdp.sdp) }
  }

  private emitLocalDescription(): void {
    const desc = this.pc.localDescription
    if (!desc) {
      return
    }
    this.onSDP({
      type: desc.type,
      sdp: this.allowTcp ? desc.sdp : stripTcpCandidates(desc.sdp)
    })
  }

  /**
   * 检查连接是否断开
   * @returns 如果连接则为 True，否则为 false
   */
  public isDataChannelOpen(): boolean {
    return this.dc?.readyState === 'open'
  }

  /**
   * 暴露底层 PeerConnection，用于检测局域网 / 公网路径。
   */
  public getRTCPeerConnection(): RTCPeerConnection {
    return this.pc
  }

  /**
   * 仅允许中继升到公网直连 / 局域网，而且只升一次。
   * 已经是局域网或公网直连时不再 restartIce，避免把稳定连接打断。
   */
  public async tryPromoteDirect(): Promise<boolean> {
    if (
      this.disposed ||
      !this.isInitiator ||
      this.pathLocked ||
      this.promotingDirect ||
      this.dc?.readyState !== 'open'
    ) {
      return false
    }
    const { selected, best } = await inspectWebRTCLink(this.pc)
    if (selected === 'lan' || selected === 'wan') {
      this.pathLocked = true
      return false
    }
    if (this.promoteAttempts >= 1) {
      return false
    }
    if (best !== 'lan' && best !== 'wan') {
      return false
    }
    if (LINK_RANK[best] <= LINK_RANK[selected] || LINK_RANK[best] <= this.promotedRank) {
      return false
    }
    this.promotedRank = LINK_RANK[best]
    this.promoteAttempts += 1
    this.promotingDirect = true
    try {
      this.pc.restartIce()
      return true
    } catch (error) {
      console.warn(error)
      this.promotingDirect = false
      this.promotedRank = LINK_RANK[selected]
      return false
    }
  }

  /**
   * 获取接收缓存的大小
   * @returns 接收缓存的大小
   */
  public getReceivedBufferSize(): number {
    // 只统计二进制文件数据；字符串是控制消息，且 length 不等于字节数
    const partial =
      this.receiveData.type === 'string' ? 0 : chunksByteLength(this.receiveData.chunks)
    return partial + this.pendingReceiveBytes
  }

  /**
   * 尚未真正送出通道的字节。发送进度应用「已排队 - bufferedAmount」。
   */
  public getBufferedAmount(): number {
    return this.dc?.bufferedAmount ?? 0
  }

  /**
   * 关闭对等连接并清理资源
   */
  public dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearUpgradeTimers()
    if (this.sendPromiseReject) {
      this.sendPromiseReject()
      this.sendPromiseReject = null
    }

    if (this.dc) {
      this.dc.close()
      this.dc = null
    }

    this.pc.onicecandidate = null
    this.pc.ontrack = null
    this.pc.ondatachannel = null
    this.pc.oniceconnectionstatechange = null
    this.pc.onsignalingstatechange = null
    this.pc.onicegatheringstatechange = null
    this.pc.onnegotiationneeded = null
    this.pc.onconnectionstatechange = null
    this.pc.close()
  }

  private teardown(): void {
    if (this.disposed) {
      return
    }
    this.dispose()
    this.onDispose()
  }
}
