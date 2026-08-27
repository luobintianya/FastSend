import CryptoJS from 'crypto-js'
import { toCanvas } from 'qrcode'
import { watch } from 'vue'
import { PeerDataChannel } from '~/utils/PeerDataChannel'
import { detectWebRTCLinkType } from '~/utils/webrtcLink'
import {
  createRoomCurrentFileState,
  createRoomStatusState,
  toMetaFileMap,
  type ChatMessage,
  type FileOffer,
  type FilesPayload,
  type FlatFileMap,
  type RoomCurrentFileState,
  type RoomMember,
  type RoomStatusState,
  type RoomTransferPhase,
  type UserInfo
} from '~/types/transfer'

interface PeerLink {
  pdc: PeerDataChannel
  sendChain: Promise<void>
  remoteDescSet: boolean
  pendingCandidates: RTCIceCandidateInit[]
}

function createRoomMember(id: string, user?: UserInfo): RoomMember {
  return {
    id,
    user: user || { nickname: 'unknown', avatarURL: '' },
    isConnected: false,
    isConnecting: true,
    linkType: 'unknown'
  }
}

/**
 * 房间业务仓库。
 * 支持多人同房间；关闭页面后从房间消失；并展示与每位成员的局域网 / 公网链路。
 */
export const useRoomStore = defineStore('room', () => {
  const { t } = useI18n()
  const toast = useToast()
  const userStore = useUserStore()

  const roomCode = ref('')
  const selfId = ref('')
  const members = ref<RoomMember[]>([])
  const status = ref<RoomStatusState>(createRoomStatusState())
  const chatMessages = ref<ChatMessage[]>([])
  const chatDraft = ref('')
  const chatTargetId = ref('')
  const incomingOffer = ref<FileOffer | null>(null)
  const transferPhase = ref<RoomTransferPhase>('idle')
  const curFile = ref<RoomCurrentFileState>(createRoomCurrentFileState())
  const totalFileSize = ref(0)
  const totalTransmittedBytes = ref(0)
  const totalSpeed = ref(0)
  const durationTimeStr = ref('00:00')
  const remainingTimeStr = ref('00:00')
  const isModernFileAPISupport = ref(true)
  const isDirSupport = ref(true)
  const isFileDragging = ref(false)

  const hasher = CryptoJS.algo.MD5.create()
  const peerLinks = new Map<string, PeerLink>()

  let ws: WebSocket | null = null
  let calcSpeedJobId: ReturnType<typeof setInterval> | undefined
  let startTime = 0
  let outgoingFileMap: FlatFileMap = {}
  let incomingPayload: FilesPayload = { type: '', fileMap: {}, root: '' }
  let currentOfferId = ''
  let transferPeerId = ''
  let saveFileFH: FileSystemFileHandle | undefined
  let curFileWriter: FileSystemWritableFileStream | undefined
  let rootDirDH: FileSystemDirectoryHandle | undefined
  let reqFileResolveFn: (() => void) | undefined
  let reqFileRejecteFn: (() => void) | undefined
  let unwatchUser: (() => void) | undefined
  let intentionalClose = false
  let hasJoined = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let visibilityBound = false

  const localePath = useLocalePath()

  const shareLink = computed(() => {
    if (!import.meta.client || !roomCode.value) {
      return ''
    }
    return `${location.origin}${localePath(`/room/${roomCode.value}`)}`
  })

  const isBusy = computed(() => transferPhase.value !== 'idle')
  const hasConnectedPeer = computed(() => members.value.some((item) => item.isConnected))
  const canSendChat = computed(
    () => members.value.length > 0 && status.value.isConnectServer && !isBusy.value
  )
  const chatTargetName = computed(() => {
    if (!chatTargetId.value) {
      return ''
    }
    return members.value.find((item) => item.id === chatTargetId.value)?.user.nickname || ''
  })

  const incomingSummary = computed(() =>
    incomingOffer.value ? summarizePayload(incomingOffer.value.payload) : null
  )

  function fileKeysOf(fileMap: FlatFileMap) {
    return Object.keys(fileMap).filter((key) => !/\/$/.test(key))
  }

  function summarizePayload(payload: FilesPayload) {
    const keys = fileKeysOf(payload.fileMap)
    const totalSize = keys.reduce((sum, key) => sum + (payload.fileMap[key]?.size || 0), 0)
    const first = payload.fileMap[keys[0] || '']
    const name =
      payload.type === 'transDir'
        ? payload.root || first?.paths[0] || t('label.folder')
        : keys[0] || t('btn.sendFile')
    return { count: keys.length, totalSize, name }
  }

  function patchMember(id: string, patch: Partial<RoomMember>) {
    const index = members.value.findIndex((item) => item.id === id)
    if (index < 0) {
      return
    }
    const current = members.value[index]
    if (!current) {
      return
    }
    members.value[index] = { ...current, ...patch }
  }

  function canInteractWith(peerId: string) {
    const member = members.value.find((item) => item.id === peerId)
    return !!member && status.value.isConnectServer && !isBusy.value
  }

  function sendControl(peerId: string, payload: Record<string, unknown>) {
    sendSignal({ ...payload, to: peerId })
    sendTo(peerId, JSON.stringify(payload)).catch(() => {})
  }

  async function waitForDataChannel(peerId: string, timeout = 12e3) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const link = peerLinks.get(peerId)
      if (link?.pdc.isDataChannelOpen()) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('P2P not ready')
  }

  function resetTransferRuntime() {
    if (calcSpeedJobId) {
      clearInterval(calcSpeedJobId)
      calcSpeedJobId = undefined
    }
    reqFileRejecteFn?.()
    reqFileResolveFn = undefined
    reqFileRejecteFn = undefined
    outgoingFileMap = {}
    incomingPayload = { type: '', fileMap: {}, root: '' }
    currentOfferId = ''
    transferPeerId = ''
    saveFileFH = undefined
    curFileWriter = undefined
    rootDirDH = undefined
    startTime = 0
    transferPhase.value = 'idle'
    curFile.value = createRoomCurrentFileState()
    totalFileSize.value = 0
    totalTransmittedBytes.value = 0
    totalSpeed.value = 0
    durationTimeStr.value = '00:00'
    remainingTimeStr.value = '00:00'
  }

  function disposeLink(peerId: string) {
    const link = peerLinks.get(peerId)
    peerLinks.delete(peerId)
    link?.pdc.dispose()
  }

  function disposeAllLinks() {
    for (const peerId of [...peerLinks.keys()]) {
      disposeLink(peerId)
    }
  }

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/api/connect`
  }

  function tearDownSocket() {
    if (!ws) {
      return
    }
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    try {
      ws.close()
    } catch {
      // ignore
    }
    ws = null
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible' || intentionalClose || !roomCode.value) {
      return
    }
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      connectSocket()
    }
  }

  function bindLifecycle() {
    if (!import.meta.client || visibilityBound) {
      return
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = true
  }

  function unbindLifecycle() {
    if (!import.meta.client || !visibilityBound) {
      return
    }
    document.removeEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = false
  }

  function scheduleReconnect() {
    if (intentionalClose || !roomCode.value) {
      return
    }
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      if (intentionalClose || !roomCode.value) {
        return
      }
      status.value.isConnecting = true
      connectSocket()
    }, 1000)
  }

  function dispose() {
    intentionalClose = true
    hasJoined = false
    clearTimeout(reconnectTimer)
    unbindLifecycle()
    unwatchUser?.()
    unwatchUser = undefined
    resetTransferRuntime()
    incomingOffer.value = null
    disposeAllLinks()
    sendSignal({ type: 'leave' })
    tearDownSocket()
  }

  function resetState() {
    dispose()
    roomCode.value = ''
    selfId.value = ''
    members.value = []
    chatMessages.value = []
    chatDraft.value = ''
    chatTargetId.value = ''
    status.value = createRoomStatusState()
  }

  function sendSignal(payload: unknown) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload))
    }
  }

  function sendTo(peerId: string, data: ArrayBuffer | string) {
    const link = peerLinks.get(peerId)
    if (!link) {
      return Promise.reject(new Error('Data channel not initialized'))
    }
    const next = link.sendChain.then(async () => {
      const current = peerLinks.get(peerId)
      if (!current) {
        throw new Error('Data channel not initialized')
      }
      await current.pdc.sendData(data)
    })
    link.sendChain = next.catch(() => {})
    return next
  }

  function sendDC(data: ArrayBuffer | string) {
    return sendTo(transferPeerId, data)
  }

  async function broadcastJSON(payload: unknown) {
    const raw = JSON.stringify(payload)
    await Promise.all(
      members.value
        .filter((item) => item.isConnected)
        .map((item) => sendTo(item.id, raw).catch(console.warn))
    )
  }

  async function closeCurFileWriter() {
    try {
      await curFileWriter?.close()
    } catch {
      // writer 可能已关闭
    }
    curFileWriter = undefined
  }

  function calcSpeedFn() {
    if (!startTime) {
      return
    }
    const extra =
      transferPhase.value === 'receiving'
        ? peerLinks.get(transferPeerId)?.pdc.getReceivedBufferSize() || 0
        : 0
    const curBytes = curFile.value.transmittedBytes + extra
    curFile.value.speed = curBytes - curFile.value.lastBytes
    curFile.value.lastBytes = curBytes
    totalSpeed.value = totalTransmittedBytes.value / Math.max((Date.now() - startTime) / 1e3, 0.001)
    durationTimeStr.value = formatTime(Date.now() - startTime)
    remainingTimeStr.value = formatTime(
      ((totalFileSize.value - totalTransmittedBytes.value) / Math.max(totalSpeed.value, 1)) * 1e3
    )
  }

  function startSpeedJob() {
    if (calcSpeedJobId) {
      clearInterval(calcSpeedJobId)
    }
    startTime = Date.now()
    calcSpeedJobId = setInterval(calcSpeedFn, 1e3)
  }

  function pushChat(message: Omit<ChatMessage, 'id'>) {
    chatMessages.value.push({
      ...message,
      id: genRandomString(8)
    })
    if (chatMessages.value.length > 200) {
      chatMessages.value.splice(0, chatMessages.value.length - 200)
    }
  }

  async function refreshLinkType(peerId: string) {
    for (let i = 0; i < 8; i++) {
      const link = peerLinks.get(peerId)
      if (!link) {
        return
      }
      const linkType = await detectWebRTCLinkType(link.pdc.getRTCPeerConnection())
      if (linkType !== 'unknown') {
        patchMember(peerId, { linkType })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  function handlePeerLeft(peerId: string, user?: UserInfo) {
    const leaving = members.value.find((item) => item.id === peerId)
    const name = leaving?.user.nickname || user?.nickname || t('label.online')
    disposeLink(peerId)
    members.value = members.value.filter((item) => item.id !== peerId)
    if (chatTargetId.value === peerId) {
      chatTargetId.value = ''
    }
    if (incomingOffer.value?.fromPeerId === peerId) {
      incomingOffer.value = null
    }
    if (transferPeerId === peerId) {
      resetTransferRuntime()
    }
    pushChat({
      fromId: peerId,
      fromNickname: name,
      text: t('hint.peerLeftNamed', { name }),
      ts: Date.now(),
      isSelf: false,
      isSystem: true
    })
    toast.add({
      severity: 'info',
      summary: 'Info',
      detail: t('hint.peerLeftNamed', { name }),
      life: 5e3
    })
  }

  async function handleBufferData(buf: ArrayBuffer) {
    curFile.value.transmittedBytes += buf.byteLength
    totalTransmittedBytes.value += buf.byteLength
    hasher.update(CryptoJS.lib.WordArray.create(buf))
    if (curFileWriter) {
      await curFileWriter.write(buf)
      return
    }
    curFile.value.chunks.push(buf)
  }

  async function sendFileChunks(fileKey: string) {
    hasher.reset()
    const fileDetail = outgoingFileMap[fileKey]
    const file = fileDetail?.file
    const name = `${fileDetail?.paths[fileDetail?.paths?.length - 1] || fileKey}`
    if (!file) {
      await sendDC(JSON.stringify({ type: 'err', data: 404 }))
      return
    }

    curFile.value = {
      name,
      size: file.size,
      transmittedBytes: 0,
      lastBytes: 0,
      speed: 0,
      chunks: []
    }

    const sliceSize = 1024 * 1024
    const count = Math.ceil(file.size / sliceSize)
    for (let index = 0; index < count; index++) {
      const ab = await file.slice(index * sliceSize, (index + 1) * sliceSize).arrayBuffer()
      if (ab.byteLength === 0) {
        continue
      }
      hasher.update(CryptoJS.lib.WordArray.create(ab))
      await sendDC(ab)
      curFile.value.transmittedBytes += ab.byteLength
      totalTransmittedBytes.value += ab.byteLength
    }

    await sendDC(
      JSON.stringify({
        type: 'fileDone',
        data: hasher.finalize().toString(CryptoJS.enc.Base64)
      })
    )
  }

  function getPathSegment(segment: string | undefined) {
    if (!segment) {
      throw new Error('Invalid path segment')
    }
    return segment
  }

  async function requestFile(key: string) {
    hasher.reset()
    await sendDC(JSON.stringify({ type: 'reqFile', data: key }))
    return new Promise<void>((resolve, reject) => {
      reqFileResolveFn = resolve
      reqFileRejecteFn = reject
    })
  }

  async function receiveIncomingFiles() {
    const keys = fileKeysOf(incomingPayload.fileMap)
    totalFileSize.value = keys.reduce(
      (sum, key) => sum + (incomingPayload.fileMap[key]?.size || 0),
      0
    )
    startSpeedJob()

    try {
      if (incomingPayload.type === 'transFile') {
        const key = keys[0]
        if (!key || !incomingPayload.fileMap[key]) {
          throw new Error('File not found')
        }
        curFile.value = {
          name: key,
          size: incomingPayload.fileMap[key]!.size,
          transmittedBytes: 0,
          lastBytes: 0,
          speed: 0,
          chunks: []
        }
        const useBlobDownload = !curFileWriter
        await requestFile(key)
        if (useBlobDownload) {
          doDownloadFromBlob(new Blob(curFile.value.chunks), curFile.value.name)
        }
      } else {
        for (const key of keys) {
          const item = incomingPayload.fileMap[key]
          if (!item) {
            continue
          }
          curFile.value = {
            name: key,
            size: item.size,
            transmittedBytes: 0,
            lastBytes: 0,
            speed: 0,
            chunks: []
          }
          const paths = key.split('/')
          let curFolder = rootDirDH
          for (let index = 0; index < paths.length - 1; index++) {
            curFolder = await curFolder?.getDirectoryHandle(getPathSegment(paths[index]), {
              create: true
            })
          }
          const curFH = await curFolder?.getFileHandle(getPathSegment(paths[paths.length - 1]), {
            create: true
          })
          curFileWriter = await curFH?.createWritable()
          await requestFile(key)
        }
      }

      await sendDC(JSON.stringify({ type: 'done' }))
      toast.add({
        severity: 'success',
        summary: 'Success',
        detail: t('hint.transCompleted'),
        life: 5e3
      })
    } catch (error) {
      console.warn(error)
      await closeCurFileWriter()
      toast.add({ severity: 'error', summary: 'Error', detail: `${error}`, life: 5e3 })
    } finally {
      resetTransferRuntime()
    }
  }

  async function handleObjData(peerId: string, obj: any) {
    if (obj.type === 'user') {
      patchMember(peerId, { user: obj.data })
      return
    }

    if (obj.type === 'chat') {
      receiveChat(peerId, String(obj.data?.text || ''), undefined, {
        isPrivate: !!obj.private || !!obj.to,
        toId: obj.to
      })
      return
    }

    if (obj.type === 'offerFile') {
      if (incomingOffer.value?.offerId === obj.data?.offerId) {
        return
      }
      if (isBusy.value || incomingOffer.value) {
        sendControl(peerId, {
          type: 'rejectFile',
          data: { offerId: obj.data?.offerId }
        })
        return
      }
      const offer: FileOffer = {
        ...obj.data,
        fromPeerId: peerId
      }
      if (offer.payload?.type === 'transDir' && !isModernFileAPISupport.value) {
        sendControl(peerId, { type: 'err', data: -1 })
        sendControl(peerId, { type: 'rejectFile', data: { offerId: offer.offerId } })
        toast.add({
          severity: 'warn',
          summary: 'Warn',
          detail: t('hint.noSupportDirTrans'),
          life: 5e3
        })
        return
      }
      incomingOffer.value = offer
      if (userStore.isConfirmDefault && offer.payload?.type === 'transFile') {
        await acceptIncomingOffer({ skipPicker: true })
      }
      return
    }

    if (obj.type === 'acceptFile') {
      if (obj.data?.offerId !== currentOfferId || transferPhase.value !== 'waitingAccept') {
        return
      }
      if (transferPeerId !== peerId) {
        return
      }
      transferPhase.value = 'sending'
      const keys = fileKeysOf(outgoingFileMap)
      totalFileSize.value = keys.reduce((sum, key) => sum + (outgoingFileMap[key]?.size || 0), 0)
      startSpeedJob()
      return
    }

    if (obj.type === 'rejectFile') {
      if (obj.data?.offerId !== currentOfferId) {
        return
      }
      toast.add({
        severity: 'warn',
        summary: 'Warn',
        detail: t('hint.fileRejected'),
        life: 4e3
      })
      resetTransferRuntime()
      return
    }

    if (obj.type === 'reqFile') {
      transferPeerId = peerId
      await sendFileChunks(obj.data)
      return
    }

    if (obj.type === 'fileDone') {
      const hash = hasher.finalize().toString(CryptoJS.enc.Base64)
      if (hash !== obj.data) {
        toast.add({
          severity: 'error',
          summary: 'Error',
          detail: t('hint.hashCheckFail'),
          life: 5e3
        })
        await closeCurFileWriter()
        if (saveFileFH) {
          // @ts-ignore 运行时浏览器 API 可用，类型定义未完整覆盖 remove。
          saveFileFH.remove?.()
        }
        reqFileRejecteFn?.()
        reqFileResolveFn = undefined
        reqFileRejecteFn = undefined
        return
      }
      await closeCurFileWriter()
      reqFileResolveFn?.()
      reqFileResolveFn = undefined
      reqFileRejecteFn = undefined
      return
    }

    if (obj.type === 'done') {
      toast.add({
        severity: 'success',
        summary: 'Success',
        detail: t('hint.transCompleted'),
        life: 5e3
      })
      resetTransferRuntime()
      return
    }

    if (obj.type === 'err') {
      if (obj.data === 403) {
        toast.add({
          severity: 'error',
          summary: 'Error',
          detail: t('hint.refusesToTransmit'),
          life: 5e3
        })
        incomingOffer.value = null
        resetTransferRuntime()
      } else if (obj.data === 404) {
        toast.add({ severity: 'warn', summary: 'Warn', detail: t('hint.fileNotFound'), life: 5e3 })
      } else if (obj.data === -1) {
        toast.add({
          severity: 'warn',
          summary: 'Warn',
          detail: t('hint.noSupportDirTrans2'),
          life: 5e3
        })
        resetTransferRuntime()
      }
    }
  }

  function createLink(peerId: string, initiator: boolean) {
    if (peerLinks.has(peerId)) {
      return
    }

    const pdc = new PeerDataChannel({
      iceServers: pubIceServers,
      initializeDataChannel: initiator
    })
    const link: PeerLink = {
      pdc,
      sendChain: Promise.resolve(),
      remoteDescSet: false,
      pendingCandidates: []
    }
    peerLinks.set(peerId, link)
    patchMember(peerId, { isConnecting: true })

    pdc.onSDP = (sdp) =>
      sendSignal({ type: 'sdp', to: peerId, data: { type: sdp.type, sdp: sdp.sdp } })
    pdc.onICECandidate = (candidate) =>
      sendSignal({
        type: 'candidate',
        to: peerId,
        data: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment
        }
      })
    pdc.onDispose = () => {
      if (peerLinks.get(peerId)?.pdc === pdc) {
        peerLinks.delete(peerId)
      }
      patchMember(peerId, { isConnected: false, isConnecting: false, linkType: 'unknown' })
      if (transferPeerId === peerId) {
        toast.add({
          severity: 'warn',
          summary: 'Warn',
          detail: t('hint.connectInterrupted'),
          life: 5e3
        })
        resetTransferRuntime()
      }
    }
    pdc.onError = (err) => {
      console.error(err)
      patchMember(peerId, { isConnected: false, isConnecting: false })
    }
    pdc.onConnected = () => {
      refreshLinkType(peerId).catch(console.warn)
    }
    pdc.onOpen = () => {
      patchMember(peerId, { isConnected: true, isConnecting: false })
      sendTo(peerId, JSON.stringify({ type: 'user', data: userStore.userInfo })).catch(console.warn)
      refreshLinkType(peerId).catch(console.warn)
    }
    pdc.onReceive = async (data) => {
      if (typeof data === 'string') {
        await handleObjData(peerId, JSON.parse(data))
        return
      }
      if (transferPeerId === peerId && transferPhase.value === 'receiving') {
        await handleBufferData(data)
      }
    }
  }

  async function applyRemoteSDP(from: string, sdp: RTCSessionDescriptionInit) {
    if (!peerLinks.has(from)) {
      createLink(from, selfId.value > from)
    }
    const link = peerLinks.get(from)
    if (!link) {
      return
    }
    await link.pdc.setRemoteSDP(sdp)
    link.remoteDescSet = true
    for (const candidate of link.pendingCandidates) {
      await link.pdc.addICECandidate(candidate)
    }
    link.pendingCandidates = []
  }

  async function applyRemoteCandidate(from: string, candidate: RTCIceCandidateInit) {
    if (!peerLinks.has(from)) {
      createLink(from, selfId.value > from)
    }
    const link = peerLinks.get(from)
    if (!link) {
      return
    }
    if (!link.remoteDescSet) {
      link.pendingCandidates.push(candidate)
      return
    }
    await link.pdc.addICECandidate(candidate)
  }

  function upsertMember(id: string, user: UserInfo | undefined, announce: boolean) {
    if (!id || id === selfId.value) {
      return
    }
    const initiator = selfId.value > id
    const exists = members.value.some((item) => item.id === id)
    if (exists) {
      if (user) {
        patchMember(id, { user })
      }
      if (!peerLinks.has(id)) {
        createLink(id, initiator)
      }
      return
    }
    members.value = [...members.value, createRoomMember(id, user)]
    createLink(id, initiator)
    if (!announce) {
      return
    }
    const name = user?.nickname || t('label.online')
    pushChat({
      fromId: id,
      fromNickname: name,
      text: t('hint.peerJoinedNamed', { name }),
      ts: Date.now(),
      isSelf: false,
      isSystem: true
    })
    toast.add({
      severity: 'success',
      summary: 'Online',
      detail: t('hint.peerJoinedNamed', { name }),
      life: 3e3
    })
  }

  function handleJoined(data: { selfId: string; members: Array<{ id: string; user: UserInfo }> }) {
    selfId.value = data.selfId
    hasJoined = true
    status.value.isConnecting = false
    status.value.error.code = 0
    status.value.error.msg = ''
    disposeAllLinks()
    members.value = []
    for (const item of data.members || []) {
      upsertMember(item.id, item.user, false)
    }
    sendSignal({ type: 'updateUser', user: userStore.userInfo })
  }

  function handlePeerJoin(data: { id: string; user: UserInfo }) {
    upsertMember(data.id, data.user, true)
  }

  function handleRoomMembers(list: Array<{ id: string; user: UserInfo }>) {
    const ids = new Set((list || []).map((item) => item.id))
    for (const member of [...members.value]) {
      if (!ids.has(member.id)) {
        handlePeerLeft(member.id, member.user)
      }
    }
    for (const item of list || []) {
      upsertMember(item.id, item.user, false)
    }
  }

  async function offerFiles(type: 'transFile' | 'transDir', fileMap: FlatFileMap, peerId: string) {
    if (!canInteractWith(peerId)) {
      return
    }
    if (Object.keys(fileMap).length === 0) {
      toast.add({
        severity: 'warn',
        summary: 'Warn',
        detail: type === 'transFile' ? t('hint.noFileSelected') : t('hint.emptyFolder'),
        life: 4e3
      })
      return
    }

    outgoingFileMap = fileMap
    currentOfferId = genRandomString(8)
    transferPeerId = peerId
    transferPhase.value = 'waitingAccept'
    const first = fileMap[Object.keys(fileMap)[0] || '']
    const payload: FilesPayload = {
      type,
      fileMap: toMetaFileMap(fileMap),
      root: type === 'transDir' ? first?.paths[0] || '' : ''
    }
    const summary = summarizePayload(payload)
    curFile.value = {
      name: summary.name,
      size: summary.totalSize,
      transmittedBytes: 0,
      lastBytes: 0,
      speed: 0,
      chunks: []
    }
    totalFileSize.value = summary.totalSize

    sendControl(peerId, {
      type: 'offerFile',
      data: {
        offerId: currentOfferId,
        from: userStore.userInfo,
        fromPeerId: selfId.value,
        payload
      }
    })
  }

  async function sendSelectedFile(peerId: string) {
    try {
      const file = await selectFile()
      await offerFiles('transFile', dealFilesFormFile(file), peerId)
    } catch (error) {
      if (`${error}` === 'Cancel' || `${error}`.includes('未选择')) {
        return
      }
      console.warn(error)
    }
  }

  async function sendSelectedDir(peerId: string) {
    if (!isDirSupport.value) {
      toast.add({
        severity: 'warn',
        summary: 'Warn',
        detail: t('hint.noSupportDirTrans'),
        life: 4e3
      })
      return
    }
    try {
      const files = await selectDir()
      await offerFiles('transDir', await dealFilesFormList(files), peerId)
    } catch (error) {
      if (`${error}` === 'Cancel' || `${error}` === 'No file') {
        return
      }
      console.warn(error)
    }
  }

  async function handleDropFile(event: DragEvent) {
    event.preventDefault()
    isFileDragging.value = false
    const connected = members.value.filter((item) => item.isConnected)
    if (connected.length !== 1 || isBusy.value || !event.dataTransfer || event.dataTransfer.items.length === 0) {
      if (connected.length > 1) {
        toast.add({
          severity: 'info',
          summary: 'Info',
          detail: t('hint.selectPeerToSend'),
          life: 4e3
        })
      }
      return
    }
    const firstItem = event.dataTransfer.items[0]
    const item = firstItem?.webkitGetAsEntry()
    const files = event.dataTransfer.files
    if (!item || !files[0] || !connected[0]) {
      return
    }
    if (item.isFile) {
      await offerFiles('transFile', dealFilesFormFile(files[0]), connected[0].id)
      return
    }
    toast.add({
      severity: 'warn',
      summary: 'Warn',
      detail: t('hint.noSupportFolderDrag'),
      life: 4e3
    })
  }

  async function acceptIncomingOffer(options: { skipPicker?: boolean } = {}) {
    const offer = incomingOffer.value
    if (!offer) {
      return
    }

    incomingPayload = offer.payload
    transferPeerId = offer.fromPeerId
    const keys = fileKeysOf(offer.payload.fileMap)
    const firstKey = keys[0]
    if (!firstKey) {
      incomingOffer.value = null
      return
    }

    try {
      if (offer.payload.type === 'transFile') {
        curFile.value = {
          name: firstKey,
          size: offer.payload.fileMap[firstKey]?.size || 0,
          transmittedBytes: 0,
          lastBytes: 0,
          speed: 0,
          chunks: []
        }
        if (isModernFileAPISupport.value && !options.skipPicker) {
          const ext = firstKey.match(/(\.\w+)$/)?.[1]
          const safeName = ext
            ? firstKey.slice(0, -ext.length).replace(/\./g, '_') + ext
            : firstKey
          saveFileFH = await window.showSaveFilePicker({
            startIn: 'downloads',
            suggestedName: safeName,
            ...(ext && {
              types: [{ description: '', accept: { 'application/x-fastsend': [ext] } }]
            })
          })
          curFileWriter = await saveFileFH?.createWritable()
        }
      } else {
        if (!isModernFileAPISupport.value) {
          toast.add({
            severity: 'warn',
            summary: 'Warn',
            detail: t('hint.noSupportDirTrans'),
            life: 5e3
          })
          await rejectIncomingOffer()
          return
        }
        rootDirDH = await window.showDirectoryPicker()
      }
    } catch {
      // 用户取消保存位置选择，保持弹窗
      return
    }

    incomingOffer.value = null
    transferPhase.value = 'receiving'
    currentOfferId = offer.offerId
    sendControl(offer.fromPeerId, {
      type: 'acceptFile',
      data: { offerId: offer.offerId }
    })
    try {
      await waitForDataChannel(offer.fromPeerId)
      await receiveIncomingFiles()
    } catch (error) {
      toast.add({
        severity: 'error',
        summary: 'Error',
        detail: t('hint.connectInterrupted'),
        life: 5e3
      })
      resetTransferRuntime()
    }
  }

  async function rejectIncomingOffer() {
    const offer = incomingOffer.value
    incomingOffer.value = null
    if (!offer) {
      return
    }
    sendControl(offer.fromPeerId, {
      type: 'rejectFile',
      data: { offerId: offer.offerId }
    })
  }

  function receiveChat(
    fromId: string,
    text: string,
    nickname?: string,
    extra?: { isPrivate?: boolean; toId?: string }
  ) {
    const trimmed = text.trim().slice(0, 2000)
    if (!trimmed || fromId === selfId.value) {
      return
    }
    const member = members.value.find((item) => item.id === fromId)
    pushChat({
      fromId,
      fromNickname: nickname || member?.user.nickname || 'unknown',
      text: trimmed,
      ts: Date.now(),
      isSelf: false,
      isPrivate: extra?.isPrivate,
      toId: extra?.toId,
      toNickname: extra?.isPrivate ? userStore.userInfo.nickname : undefined
    })
  }

  function setChatTarget(peerId: string) {
    chatTargetId.value = members.value.some((item) => item.id === peerId) ? peerId : ''
  }

  async function sendChat() {
    const text = chatDraft.value.trim()
    if (!text || !canSendChat.value) {
      return
    }
    const toId = chatTargetId.value
    const toMember = toId ? members.value.find((item) => item.id === toId) : undefined
    if (toId && !toMember) {
      chatTargetId.value = ''
    }
    chatDraft.value = ''
    const payload = { text: text.slice(0, 2000) }
    pushChat({
      fromId: selfId.value,
      fromNickname: userStore.userInfo.nickname,
      text: payload.text,
      ts: Date.now(),
      isSelf: true,
      isPrivate: !!toMember,
      toId: toMember?.id,
      toNickname: toMember?.user.nickname
    })
    sendSignal({
      type: 'chat',
      to: toMember?.id,
      data: payload
    })
  }

  async function copyLink() {
    if (!shareLink.value) {
      return
    }
    await copyToClipboard(shareLink.value)
    toast.add({
      severity: 'success',
      summary: 'Success',
      detail: t('hint.linkCopied'),
      life: 3e3
    })
  }

  async function renderQRCode(canvas: HTMLCanvasElement | null) {
    if (!canvas || !shareLink.value) {
      return
    }
    await toCanvas(canvas, shareLink.value, { scale: 5 })
  }

  function setDragging(value: boolean) {
    isFileDragging.value = value
  }

  function connectSocket() {
    hasJoined = false
    disposeAllLinks()
    members.value = []
    selfId.value = ''
    tearDownSocket()

    try {
      ws = new WebSocket(getWsUrl())
    } catch (error) {
      console.error(error)
      status.value.error.code = -5
      status.value.error.msg = `${error}`
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      status.value.isConnectServer = true
      sendSignal({
        type: 'join',
        room: roomCode.value,
        user: userStore.userInfo,
        clientId: getClientId()
      })
    }
    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      if (data.type === 'ping') {
        sendSignal({ type: 'pong' })
        return
      }
      if (data.type === 'joined') {
        handleJoined(data)
        return
      }
      if (data.type === 'peerJoin') {
        handlePeerJoin(data)
        return
      }
      if (data.type === 'roomMembers') {
        handleRoomMembers(data.members)
        return
      }
      if (data.type === 'peerLeave') {
        handlePeerLeft(data.id, data.user)
        return
      }
      if (data.type === 'peerUser') {
        patchMember(data.id, { user: data.user })
        return
      }
      if (data.type === 'chat') {
        receiveChat(data.from, String(data.data?.text || ''), data.user?.nickname, {
          isPrivate: !!data.private,
          toId: data.to
        })
        return
      }
      if (
        data.from &&
        (data.type === 'offerFile' ||
          data.type === 'acceptFile' ||
          data.type === 'rejectFile' ||
          data.type === 'err')
      ) {
        await handleObjData(data.from, { type: data.type, data: data.data })
        return
      }
      if (data.type === 'sdp') {
        await applyRemoteSDP(data.from, data.data)
        return
      }
      if (data.type === 'candidate') {
        await applyRemoteCandidate(data.from, data.data)
        return
      }
      if (data.type === 'err') {
        status.value.isConnecting = false
        status.value.error.code = data.data
        status.value.error.msg = data.msg || ''
      }
    }
    ws.onclose = () => {
      status.value.isConnectServer = false
      hasJoined = false
      if (intentionalClose) {
        return
      }
      scheduleReconnect()
    }
    ws.onerror = (error) => {
      console.error(error)
      status.value.isConnectServer = false
    }
  }

  function initialize(code: string) {
    const nextCode = code.trim().toUpperCase()
    if (!isValidRoomCode(nextCode)) {
      return
    }
    if (
      roomCode.value === nextCode &&
      ws &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    resetState()
    intentionalClose = false
    isModernFileAPISupport.value = isModernFileAPIAvailable()
    isDirSupport.value = supportsDirectorySelection()
    roomCode.value = nextCode
    status.value.isConnecting = true

    unwatchUser = watch(
      () => [userStore.userInfo.nickname, userStore.userInfo.avatarURL],
      () => {
        if (!hasJoined) {
          return
        }
        sendSignal({ type: 'updateUser', user: userStore.userInfo })
        broadcastJSON({ type: 'user', data: userStore.userInfo }).catch(console.warn)
      }
    )
    bindLifecycle()
    connectSocket()
  }

  function cleanup() {
    resetState()
  }

  return {
    roomCode,
    selfId,
    members,
    status,
    chatMessages,
    chatDraft,
    chatTargetId,
    chatTargetName,
    incomingOffer,
    incomingSummary,
    transferPhase,
    curFile,
    totalFileSize,
    totalTransmittedBytes,
    totalSpeed,
    durationTimeStr,
    remainingTimeStr,
    isModernFileAPISupport,
    isDirSupport,
    isFileDragging,
    shareLink,
    isBusy,
    hasConnectedPeer,
    canSendChat,
    canInteractWith,
    initialize,
    cleanup,
    sendChat,
    setChatTarget,
    sendSelectedFile,
    sendSelectedDir,
    handleDropFile,
    acceptIncomingOffer,
    rejectIncomingOffer,
    copyLink,
    renderQRCode,
    setDragging
  }
})
