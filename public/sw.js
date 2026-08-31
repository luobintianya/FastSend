self.__WB_MANIFEST

// 不在 install 时 skipWaiting，也不在 activate 时清缓存并 claim。
// 否则新 SW 一接管，页面会自动 reload，弱网下会再拉一遍整包 JS。
