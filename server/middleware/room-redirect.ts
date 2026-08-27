const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/i

function localePrefix(pathname: string) {
  if (pathname === '/zh' || pathname.startsWith('/zh/')) {
    return '/zh'
  }
  if (pathname === '/en' || pathname.startsWith('/en/')) {
    return '/en'
  }
  return ''
}

export default defineEventHandler((event) => {
  const url = getRequestURL(event)
  const pathname = url.pathname.replace(/\/$/, '') || '/'
  const prefix = localePrefix(pathname)
  const pathNoLocale = prefix ? pathname.slice(prefix.length) || '/' : pathname

  const pretty = pathNoLocale.match(/^\/r\/([A-Z0-9]{4,8})$/i)
  if (pretty?.[1]) {
    return sendRedirect(event, `${prefix}/room/${pretty[1].toUpperCase()}`, 302)
  }

  const queryRoom = `${url.searchParams.get('room') || ''}`.trim().toUpperCase()
  if (ROOM_CODE_RE.test(queryRoom) && (pathNoLocale === '/' || pathNoLocale === '/room')) {
    return sendRedirect(event, `${prefix}/room/${queryRoom}`, 302)
  }
})
