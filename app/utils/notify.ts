import { ref } from 'vue'

export const unreadCount = ref(0)
export const titleBlinkOn = ref(false)

let titleBound = false
let blinkTimer: ReturnType<typeof setInterval> | undefined

function startBlink() {
  if (blinkTimer) {
    return
  }
  titleBlinkOn.value = true
  blinkTimer = setInterval(() => {
    titleBlinkOn.value = !titleBlinkOn.value
  }, 900)
}

function stopBlink() {
  if (blinkTimer) {
    clearInterval(blinkTimer)
    blinkTimer = undefined
  }
  titleBlinkOn.value = false
}

export function clearUnread() {
  unreadCount.value = 0
  stopBlink()
}

function bumpUnread() {
  unreadCount.value += 1
  startBlink()
}

function bindTitleReset() {
  if (!import.meta.client || titleBound) {
    return
  }
  titleBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearUnread()
    }
  })
}

export function isTabVisible() {
  if (!import.meta.client) {
    return true
  }
  return document.visibilityState === 'visible'
}

export function isPageActive() {
  if (!import.meta.client) {
    return true
  }
  return isTabVisible() && document.hasFocus()
}

export async function requestNotifyPermission(): Promise<boolean> {
  if (!import.meta.client || typeof Notification === 'undefined') {
    return false
  }
  if (Notification.permission === 'granted') {
    return true
  }
  if (Notification.permission === 'denied') {
    return false
  }
  try {
    const result = await Notification.requestPermission()
    return result === 'granted'
  } catch {
    return false
  }
}

export function isNotifyMuted() {
  return import.meta.client && localStorage.getItem('fastsendNotifyMuted') === '1'
}

export function showAppNotification(
  title: string,
  options?: {
    force?: boolean
    body?: string
    tag?: string
    icon?: string
    badge?: string
    requireInteraction?: boolean
  }
): 'in-app' | 'background' {
  if (!import.meta.client) {
    return 'in-app'
  }

  bindTitleReset()

  const visible = isTabVisible()
  if (!visible) {
    bumpUnread()
  }

  const { force, ...notifyOptions } = options || {}
  const wantDesktop = force || !visible
  if (!wantDesktop || isNotifyMuted()) {
    return visible ? 'in-app' : 'background'
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return visible ? 'in-app' : 'background'
  }

  try {
    const notification = new Notification(title, {
      icon: '/favicon.webp',
      badge: '/favicon.webp',
      ...notifyOptions
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    if (!notifyOptions.requireInteraction) {
      setTimeout(() => notification.close(), 8e3)
    }
  } catch (error) {
    console.warn(error)
  }
  return visible ? 'in-app' : 'background'
}
