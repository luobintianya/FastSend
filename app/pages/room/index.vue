<script setup lang="ts">
defineI18nRoute({
  paths: {
    en: '/room',
    zh: '/room'
  }
})

const route = useRoute()
const localePath = useLocalePath()

const raw = `${route.query.room || ''}`.trim().toUpperCase()
const code = isValidRoomCode(raw) ? raw : import.meta.client ? genRoomCode() : ''
if (code) {
  await navigateTo(localePath(`/room/${code}`), { replace: true })
}
</script>

<template>
  <div class="flex justify-center py-24">
    <div class="loader"></div>
  </div>
</template>

<style scoped>
.loader {
  width: 72px;
  height: 28px;
  --g: radial-gradient(
      farthest-side,
      transparent calc(95% - 3px),
      currentColor calc(100% - 3px) 98%,
      transparent 101%
    )
    no-repeat;
  background: var(--g), var(--g), var(--g);
  background-size: 20px 20px;
  animation: l9 1s infinite alternate;
}
@keyframes l9 {
  0% {
    background-position:
      0 50%,
      50% 50%,
      100% 50%;
  }
  100% {
    background-position:
      0 50%,
      50% 50%,
      100% 50%;
  }
}
</style>
