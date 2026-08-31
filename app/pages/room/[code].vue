<script setup lang="ts">
import { titleBlinkOn, unreadCount } from '~/utils/notify'

defineI18nRoute({
  paths: {
    en: '/room/[code]',
    zh: '/room/[code]'
  }
})

const { t } = useI18n()
const pageTitle = computed(() => {
  if (unreadCount.value > 0 && titleBlinkOn.value) {
    return `(${unreadCount.value}) ${t('hint.newMessage')}`
  }
  return t('home')
})

useSeoMeta({
  title: pageTitle
})
</script>

<template>
  <RoomHome />
</template>
