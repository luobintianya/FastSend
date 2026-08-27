<script setup lang="ts">
defineI18nRoute({
  paths: {
    en: '/room/[code]',
    zh: '/room/[code]'
  }
})

useSeoMeta({
  title: 'Fast Send'
})
</script>

<template>
  <RoomHome />
</template>
