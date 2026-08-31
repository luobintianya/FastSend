import CryptoJS from 'crypto-js'

/**
 * 获取浏览器当前滚动高度
 * @returns 浏览器滚动高度
 */
export function getScrollTop(): number {
  // 检查 window 和 document 是否存在，以处理 SSR 的情况
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return 0
  }
  // 使用不同的方式获取滚动条高度，以处理浏览器兼容性问题
  if (typeof window.scrollY !== 'undefined') {
    // 支持现代浏览器
    return window.scrollY
  } else if (document.documentElement && document.documentElement.scrollTop) {
    // 兼容IE 6-8
    return document.documentElement.scrollTop
  } else if (document.body && document.body.scrollTop) {
    // 兼容一些老的浏览器
    return document.body.scrollTop
  }
  return 0
}

/**
 * 判断浏览器是否支持现代文件操作
 */
export function isModernFileAPIAvailable() {
  const fileHandleSupported = 'FileSystemHandle' in window
  const openFilePickerSupported = 'showOpenFilePicker' in window
  const saveFilePickerSupported = 'showSaveFilePicker' in window
  const directoryPickerSupported = 'showDirectoryPicker' in window

  return (
    fileHandleSupported &&
    openFilePickerSupported &&
    saveFilePickerSupported &&
    directoryPickerSupported
  )
}

/**
 * 判断浏览器是否支持目录选择
 * @returns 是否支持目录选择
 */
export function supportsDirectorySelection() {
  var input = document.createElement('input')
  input.type = 'file'
  return 'webkitdirectory' in input || 'directory' in input
}

/**
 * 生成随机字符串
 * @param length 长度
 * @returns
 */
export function genRandomString(length: number): string {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let randomString = ''
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length)
    randomString += charset.charAt(randomIndex)
  }
  return randomString
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * 生成房间编码（避开易混淆字符）
 */
export function genRoomCode(length = 6): string {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARS.charAt(Math.floor(Math.random() * ROOM_CODE_CHARS.length))
  }
  return code
}

/**
 * 校验房间编码
 */
export function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{4,8}$/i.test(code)
}

export function getClientId(): string {
  if (!import.meta.client) {
    return ''
  }
  const key = 'fastsendClientId'
  let id = localStorage.getItem(key)
  if (!id) {
    id = genRandomString(16)
    localStorage.setItem(key, id)
  }
  return id
}

/**
 * 选择头像图片
 * @param cb 回调
 * @returns
 */
export function selectAvatar(cb: (url: string) => void) {
  if (typeof window === 'undefined') {
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = () => {
    if (input.files && input.files.length > 0) {
      const file = input.files[0]
      input.onchange = null
      input.remove()
      createImageBitmap(file!)
        .then((img) => {
          // 将图片转256x256的webp格式，节省空间
          const oc = new OffscreenCanvas(256, 256)
          const ctx = oc.getContext('2d')
          if (!ctx) {
            throw new Error('Failed to create context')
          }
          ctx.drawImage(img, 0, 0, 256, 256)
          return oc.convertToBlob({ type: 'image/webp', quality: 0.61 })
        })
        .then((blob) => {
          // 再转换成DataURL方便存储
          const fr = new FileReader()
          fr.onload = () => {
            cb(fr.result + '')
          }
          fr.readAsDataURL(blob)
        })
        .catch(console.warn)
    } else {
      cb('')
      input.onchange = null
      input.remove()
    }
  }
  input.click()
}

/**
 * 将字节格式化为人类友好的文本
 *
 * @param bytes 字节数量
 * @param decimals 显示的小数位数
 *
 * @return 格式化后的字符串
 */
export function humanFileSize(bytes: number, decimals = 2): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  const value = bytes / Math.pow(k, i)
  if (i === 0) {
    return `${Math.round(value)}B`
  }
  return `${value.toFixed(decimals)}${sizes[i]}`
}

/**
 * 用滑动窗口 + EMA 估算速率。TURN/弱网下字节会一截截到达，
 * 若只看最近一两秒，界面会在高峰和 0B/s 之间跳。
 */
export function createSpeedTracker(windowMs = 5000) {
  let samples: Array<{ t: number; bytes: number }> = []
  let smoothed = 0

  return {
    reset() {
      samples = []
      smoothed = 0
    },
    update(bytes: number, lifetimeElapsedSec: number): number {
      const now = Date.now()
      const safeBytes = Math.max(0, bytes)
      samples.push({ t: now, bytes: safeBytes })
      const cutoff = now - windowMs
      samples = samples.filter((item) => item.t >= cutoff)

      const first = samples[0]
      const last = samples[samples.length - 1]
      const lifetime = safeBytes / Math.max(lifetimeElapsedSec, 0.5)

      let instant = lifetime
      if (first && last) {
        const dt = (last.t - first.t) / 1000
        if (dt >= 1) {
          instant = Math.max(0, (last.bytes - first.bytes) / dt)
        }
      }

      // 窗口几乎停住时用全程均值托底，避免突然变成 0B/s
      if (instant < lifetime * 0.2) {
        instant = instant * 0.3 + lifetime * 0.7
      }

      if (smoothed <= 0) {
        smoothed = instant
      } else {
        smoothed = smoothed * 0.82 + instant * 0.18
      }
      return smoothed
    }
  }
}

export function doDownloadFromHref(href: string, filename: string) {
  const a = document.createElement('a')
  a.style.display = 'none'
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * 从Blob下载
 *
 * @param {Blob} blob
 * @param {string} filename
 */
export function doDownloadFromBlob(blob: Blob | File, filename: string) {
  const objUrl = URL.createObjectURL(blob)
  doDownloadFromHref(objUrl, filename)
  URL.revokeObjectURL(objUrl)
}

function copyTextFallback(text: string): boolean {
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.top = '0'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  el.setSelectionRange(0, text.length)
  const ok = document.execCommand('copy')
  document.body.removeChild(el)
  return ok
}

export async function copyToClipboard(content: string | ImageData): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }

  try {
    if (typeof content === 'string') {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content)
        return true
      }
      return copyTextFallback(content)
    }

    const canvas = document.createElement('canvas')
    canvas.width = content.width
    canvas.height = content.height
    const context = canvas.getContext('2d')

    if (!context) {
      throw new Error('Failed to get canvas context')
    }

    context.putImageData(content, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve))

    if (!blob) {
      throw new Error('Failed to create blob from canvas')
    }

    if (!navigator.clipboard?.write) {
      return false
    }
    const item = new ClipboardItem({ 'image/png': blob })
    await navigator.clipboard.write([item])
    return true
  } catch (error) {
    if (typeof content === 'string') {
      try {
        return copyTextFallback(content)
      } catch {
        console.warn(error)
        return false
      }
    }
    console.warn(error)
    return false
  }
}

/**
 * 判断当前页面是否在独立窗口打开（PWA）
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return window.matchMedia('(display-mode: standalone)').matches
}

/**
 * 从localStorage读取值，如果未找到并且提供了默认值，则更新localStorage并返回默认值
 * @param key
 * @param defVal
 * @returns
 */
export function getValFromLocalStorage<T>(key: string, defVal?: T): T | null {
  const val = localStorage.getItem(key)
  if (val) {
    try {
      return JSON.parse(val)
    } catch (e) {}
  }
  if (defVal !== undefined) {
    localStorage.setItem(key, JSON.stringify(defVal))
    return defVal
  }
  return null
}

// 计算文件或Blob的MD5哈希值
export async function calcMD5(file: File | Blob) {
  const hasher = CryptoJS.algo.MD5.create()

  const sliceSize = 1024 * 1024
  const count = Math.ceil(file.size / sliceSize)
  for (let i = 0; i < count; i++) {
    const ab = await file.slice(i * sliceSize, (i + 1) * sliceSize).arrayBuffer()
    hasher.update(CryptoJS.lib.WordArray.create(ab))
  }
  return hasher.finalize().toString(CryptoJS.enc.Base64)
}

/**
 * 将毫秒数格式化为 HH:mm:ss
 * @param {number} milliseconds
 * @returns
 */
export function formatTime(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return '--:--'
  }
  // 计算小时数
  const hours = Math.floor(milliseconds / (1000 * 60 * 60))
  // 计算剩余的分钟数
  const minutes = Math.floor((milliseconds % (1000 * 60 * 60)) / (1000 * 60))
  // 计算剩余的秒数
  const seconds = Math.floor((milliseconds % (1000 * 60)) / 1000)

  // 格式化分钟和秒数为两位数
  const formattedMinutes = minutes.toString().padStart(2, '0')
  const formattedSeconds = seconds.toString().padStart(2, '0')

  return hours === 0
    ? `${formattedMinutes}:${formattedSeconds}`
    : `${hours}:${formattedMinutes}:${formattedSeconds}`
}

/**
 * 按当前速度估算剩余时间。速度过低或尚未开始传输时不给出离谱数字。
 */
export function formatRemainingTime(remainingBytes: number, bytesPerSec: number) {
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) {
    return '00:00'
  }
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 256) {
    return '--:--'
  }
  const ms = (remainingBytes / bytesPerSec) * 1e3
  if (ms > 10 * 3600 * 1000) {
    return '--:--'
  }
  return formatTime(ms)
}
