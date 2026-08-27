<script setup lang="ts">
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const localePath = useLocalePath()
const toast = useToast()
const userStore = useUserStore()
const roomStore = useRoomStore()
const { userInfo } = storeToRefs(userStore)
const {
  roomCode,
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
  hasConnectedPeer,
  canSendChat,
  isBusy
} = storeToRefs(roomStore)

const qrcodeElm = ref<HTMLCanvasElement | null>(null)
const chatBox = ref<HTMLElement | null>(null)
const chatInputWrap = ref<HTMLElement | null>(null)
const fileDragArea = ref<HTMLElement | null>(null)
const formatSize = humanFileSize

const { data: transCount, error: transCountError } = await useFetch('/api/transCount', {
  method: 'post',
  server: false
})

useSeoMeta({
  title: t('home')
})

function paramCode() {
  const raw = route.params.code
  const value = Array.isArray(raw) ? raw[0] : raw
  return `${value || ''}`.trim().toUpperCase()
}

function roomPath(code: string) {
  return localePath(`/room/${code}`)
}

function ensureRoom() {
  const fromQuery = `${route.query.room || ''}`.trim().toUpperCase()
  let raw = paramCode() || fromQuery
  if (!isValidRoomCode(raw)) {
    router.replace(roomPath(genRoomCode()))
    return
  }
  if (paramCode() !== raw) {
    router.replace(roomPath(raw))
    return
  }
  roomStore.initialize(raw)
}

function goNewRoom() {
  router.replace(roomPath(genRoomCode()))
}

const nicknameDraft = ref('')
const nicknameBox = ref<HTMLElement | null>(null)
const editingNickname = ref(false)

watch(
  () => userInfo.value.nickname,
  (value) => {
    if (!editingNickname.value) {
      nicknameDraft.value = value
    }
  },
  { immediate: true }
)

function saveNickname() {
  if (!editingNickname.value) {
    return
  }
  editingNickname.value = false
  userStore.setNickname(nicknameDraft.value)
  nicknameDraft.value = userInfo.value.nickname
}

function startEditNickname() {
  nicknameDraft.value = userInfo.value.nickname
  editingNickname.value = true
  nextTick(() => {
    const input = nicknameBox.value?.querySelector('input')
    input?.focus()
    input?.select()
  })
}

watch(roomCode, () => {
  nextTick(() => {
    roomStore.renderQRCode(qrcodeElm.value).catch(console.warn)
  })
})

watch(
  chatMessages,
  () => {
    nextTick(() => {
      if (chatBox.value) {
        chatBox.value.scrollTop = chatBox.value.scrollHeight
      }
    })
  },
  { deep: true }
)

watch(isFileDragging, (val) => {
  if (!fileDragArea.value) {
    return
  }
  if (val) {
    fileDragArea.value.style.display = 'flex'
    fileDragArea.value.style.opacity = '1'
  } else {
    fileDragArea.value.style.opacity = '0'
    setTimeout(() => {
      if (fileDragArea.value) {
        fileDragArea.value.style.display = 'none'
      }
    }, 300)
  }
})

watch(transCountError, (error) => {
  if (!error) {
    return
  }
  toast.add({
    severity: 'error',
    summary: 'Error',
    detail: t('hint.serviceUnavailable')
  })
})

watch(
  () => [route.params.code, route.query.room],
  () => ensureRoom()
)

onMounted(() => {
  userStore.initializeFromStorage()
  ensureRoom()

  window.ondragenter = (e) => {
    e.preventDefault()
    if (hasConnectedPeer.value) {
      roomStore.setDragging(true)
    }
  }
  window.ondragleave = (e: DragEvent) => {
    e.preventDefault()
    if (!e.relatedTarget) {
      roomStore.setDragging(false)
    }
  }
  window.ondragover = (e) => {
    e.preventDefault()
  }
  window.ondrop = (e) => {
    e.preventDefault()
    roomStore.setDragging(false)
  }
})

onUnmounted(() => {
  roomStore.cleanup()
  window.ondragenter = null
  window.ondragleave = null
  window.ondragover = null
  window.ondrop = null
})
</script>

<template>
  <div class="md:px-[10vw] pb-4">
    <div
      class="fixed top-0 left-0 right-0 bottom-0 inset-0 -z-50 h-full w-full bg-white dark:bg-zinc-950 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#25272b_1px,transparent_1px)] [background-size:16px_16px]"
    ></div>

    <div
      ref="fileDragArea"
      @dragover.prevent
      @drop="roomStore.handleDropFile"
      class="file-drag-area fixed left-0 top-0 right-0 bottom-0 flex-col items-center justify-center bg-white/60 dark:bg-black/60 backdrop-blur-sm border border-dashed border-neutral-500 z-40"
    >
      <Icon name="solar:file-send-linear" size="48" />
      <p class="mt-4">{{ $t('label.dragHereToSendFile') }}</p>
    </div>

    <p
      class="text-xs md:text-sm text-neutral-600 dark:text-neutral-400 px-4 pt-2"
      v-show="!isModernFileAPISupport"
    >
      <span class="text-red-500">*</span>{{ $t('hint.noModernFileAPIWarn') }}
    </p>

    <!-- 错误 -->
    <div v-if="status.error.code !== 0" class="text-center py-10">
      <Icon name="solar:sad-square-line-duotone" size="100" />
      <p class="text-xl tracking-wider py-8">{{ $t('hint.serverError') }}</p>
      <p class="text-sm tracking-wider pb-8 mt-2">({{ $t('hint.closeTheProxy') }})</p>
      <Button severity="contrast" class="tracking-wider" @click="goNewRoom">
        <Icon name="solar:refresh-linear" class="mr-2" />{{ $t('btn.newRoom') }}
      </Button>
    </div>

    <template v-else>
      <div class="px-3 sm:px-4 pt-2 max-w-6xl mx-auto">
        <div
          v-if="transferPhase !== 'idle'"
          class="mb-4 rounded-2xl bg-white/80 dark:bg-zinc-900/80 p-4 shadow"
        >
          <p class="text-sm tracking-wider mb-2">
            {{
              transferPhase === 'waitingAccept' ? $t('hint.waitingAccept') : $t('hint.inTransit')
            }}
          </p>
          <p class="text-sm truncate">{{ curFile.name }}</p>
          <ProgressBar
            :value="
              Math.round(totalFileSize === 0 ? 0 : (totalTransmittedBytes / totalFileSize) * 100)
            "
          />
          <p class="text-right text-sm mt-1">
            <span>{{ formatSize(totalSpeed) }}/s</span>
            <span class="ml-4">{{ formatSize(totalTransmittedBytes) }}</span>
            <span class="mx-1">/</span>
            <span>{{ formatSize(totalFileSize) }}</span>
          </p>
          <p class="text-right text-xs text-neutral-500 mt-1">
            {{ durationTimeStr }} / {{ remainingTimeStr }}
          </p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px] gap-4 items-start">
          <section class="min-w-0 flex flex-col">
            <div
              ref="chatBox"
              class="h-[52vh] md:h-[calc(100vh-10rem)] min-h-48 overflow-y-auto rounded-t-2xl border border-b-0 border-neutral-200 dark:border-neutral-700 bg-white/80 dark:bg-zinc-900/80 p-3 space-y-2"
            >
              <p v-if="chatMessages.length === 0" class="text-sm text-neutral-400 text-center py-10">
                {{ $t('label.messagePlaceholder') }}
              </p>
              <div
                v-for="msg in chatMessages"
                :key="msg.id"
                class="text-sm"
                :class="msg.isSystem ? 'text-center' : msg.isSelf ? 'text-right' : 'text-left'"
              >
                <p v-if="msg.isSystem" class="text-xs text-neutral-400 py-1">{{ msg.text }}</p>
                <template v-else>
                  <span class="text-xs text-neutral-400 mr-2">
                    {{ msg.fromNickname }}
                    <span v-if="msg.isPrivate" class="text-amber-600">
                      · {{ $t('label.privateMessage') }}
                      <template v-if="msg.isSelf && msg.toNickname"> → {{ msg.toNickname }}</template>
                    </span>
                  </span>
                  <span
                    class="inline-block max-w-[80%] px-3 py-1.5 rounded-2xl break-words text-left"
                    :class="
                      msg.isSelf
                        ? 'bg-neutral-800 text-white dark:bg-neutral-200 dark:text-black'
                        : msg.isPrivate
                          ? 'bg-amber-50 dark:bg-amber-950/40'
                          : 'bg-neutral-100 dark:bg-zinc-800'
                    "
                  >
                    {{ msg.text }}
                  </span>
                </template>
              </div>
            </div>
            <div
              class="flex flex-row flex-wrap gap-2 p-2 rounded-b-2xl border border-neutral-200 dark:border-neutral-700 bg-white/90 dark:bg-zinc-900/90"
              ref="chatInputWrap"
            >
              <select
                v-model="chatTargetId"
                class="max-w-[40%] rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent text-sm px-2 py-2"
                :disabled="!members.length"
              >
                <option value="">{{ $t('label.chatEveryone') }}</option>
                <option v-for="member in members" :key="member.id" :value="member.id">
                  {{ member.user.nickname }}
                </option>
              </select>
              <InputText
                v-model="chatDraft"
                class="flex-1 min-w-[8rem]"
                :placeholder="
                  chatTargetName
                    ? $t('label.chatPrivateTo', { name: chatTargetName })
                    : $t('label.messagePlaceholder')
                "
                :disabled="!canSendChat"
                @keydown.enter.prevent="roomStore.sendChat"
              />
              <Button
                severity="contrast"
                :disabled="!canSendChat || !chatDraft.trim()"
                @click="roomStore.sendChat"
              >
                {{ $t('btn.send') }}
              </Button>
            </div>
          </section>

          <aside class="flex flex-col gap-3 md:sticky md:top-2">
            <p class="text-sm text-neutral-500">
              {{ $t('label.onlineCount', { count: members.length + 1 }) }}
            </p>

            <div
              class="flex items-center gap-3 p-3 rounded-2xl shadow bg-white/80 dark:bg-zinc-900/80"
            >
              <Avatar
                shape="circle"
                size="large"
                :image="userInfo.avatarURL"
                class="shadow cursor-pointer shrink-0"
                @click="userStore.openAvatarPicker"
              />
              <div class="min-w-0 flex-1" ref="nicknameBox">
                <InputText
                  v-if="editingNickname"
                  v-model="nicknameDraft"
                  class="w-full"
                  maxlength="16"
                  :placeholder="$t('label.nickname')"
                  @keydown.enter.prevent="saveNickname"
                  @blur="saveNickname"
                />
                <button
                  v-else
                  type="button"
                  class="font-medium truncate text-left w-full hover:opacity-80"
                  :title="$t('label.clickToEditName')"
                  @click="startEditNickname"
                >
                  {{ userInfo.nickname }}
                </button>
                <p v-if="editingNickname" class="text-xs text-neutral-500 mt-1">
                  {{ $t('label.you') }}
                </p>
                <button
                  v-else
                  type="button"
                  class="text-xs text-neutral-500 mt-1 inline-flex items-center gap-1"
                  @click="startEditNickname"
                >
                  {{ $t('label.you') }}
                  <Icon name="solar:pen-linear" size="12" />
                </button>
              </div>
            </div>

            <div
              v-for="member in members"
              :key="member.id"
              class="flex items-start gap-3 p-3 rounded-2xl shadow bg-white/80 dark:bg-zinc-900/80"
              :class="chatTargetId === member.id ? 'ring-2 ring-amber-400' : ''"
            >
              <div class="relative shrink-0">
                <Avatar shape="circle" size="large" :image="member.user.avatarURL" class="shadow" />
                <span
                  class="absolute bottom-0.5 right-0.5 size-3 rounded-full border-2 border-white dark:border-zinc-900"
                  :class="member.isConnected ? 'bg-emerald-500' : 'bg-amber-400'"
                ></span>
              </div>
              <div class="min-w-0 flex-1">
                <p class="font-medium truncate">{{ member.user.nickname }}</p>
                <div class="flex items-center gap-1 mt-0.5 text-xs">
                  <template v-if="member.linkType === 'lan'">
                    <Icon name="solar:wifi-router-linear" class="text-emerald-600" />
                    <span class="text-emerald-600">{{ $t('label.lan') }}</span>
                  </template>
                  <template v-else-if="member.linkType === 'wan'">
                    <Icon name="solar:global-linear" class="text-sky-600" />
                    <span class="text-sky-600">{{ $t('label.wan') }}</span>
                  </template>
                  <span v-else :class="member.isConnected ? 'text-emerald-600' : 'text-amber-600'">
                    {{
                      member.isConnected
                        ? $t('label.p2pReady')
                        : member.isConnecting
                          ? $t('label.connectingPeer')
                          : $t('label.online')
                    }}
                  </span>
                </div>
                <div class="flex flex-wrap gap-1.5 mt-2">
                  <Button
                    size="small"
                    severity="contrast"
                    :disabled="!roomStore.canInteractWith(member.id)"
                    @click="roomStore.sendSelectedFile(member.id)"
                  >
                    <Icon name="solar:file-line-duotone" class="mr-1" />{{ $t('btn.sendFile') }}
                  </Button>
                  <Button
                    size="small"
                    outlined
                    severity="contrast"
                    :disabled="!roomStore.canInteractWith(member.id) || !isDirSupport"
                    @click="roomStore.sendSelectedDir(member.id)"
                  >
                    <Icon name="solar:folder-with-files-line-duotone" class="mr-1" />{{
                      $t('btn.sendDir')
                    }}
                  </Button>
                </div>
              </div>
            </div>

            <div
              v-if="members.length === 0"
              class="flex flex-col items-center justify-center py-8 px-4 rounded-2xl border border-dashed border-neutral-400 dark:border-neutral-600"
            >
              <div class="loader mb-3"></div>
              <p class="text-sm tracking-wider text-neutral-500 text-center">
                {{ $t('label.waitingPeer') }}
              </p>
            </div>
          </aside>
        </div>
      </div>
    </template>

    <!-- 房间编码与分享 -->
    <div class="mt-10 px-4 pt-6 pb-4 border-t border-neutral-200 dark:border-neutral-800">
      <div class="max-w-xl mx-auto text-center">
        <h1 class="text-3xl md:text-4xl tracking-wider font-serif">Fast Send</h1>
        <p class="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {{ $t('description') }}
        </p>
        <p class="mt-6 text-sm tracking-wider text-neutral-500">{{ $t('label.roomCode') }}</p>
        <p
          class="mt-3 inline-block text-3xl md:text-5xl tracking-widest border py-3 px-6 border-dashed border-neutral-400 dark:border-neutral-500"
        >
          {{ roomCode || '------' }}
        </p>
        <p class="mt-3 text-xs text-neutral-500">{{ $t('label.shareToJoin') }}</p>
        <canvas ref="qrcodeElm" class="size-40 mx-auto mt-4"></canvas>
        <div class="flex flex-row items-center justify-center gap-3 mt-4">
          <Button size="small" severity="contrast" @click="roomStore.copyLink" class="tracking-wider">
            <Icon name="solar:link-minimalistic-2-linear" class="mr-2" />{{ $t('btn.copyLink') }}
          </Button>
          <Button size="small" outlined severity="contrast" @click="goNewRoom" class="tracking-wider">
            <Icon name="solar:refresh-linear" class="mr-2" />{{ $t('btn.newRoom') }}
          </Button>
        </div>
        <div class="flex flex-row items-baseline justify-center pt-8 text-sm">
          <span>{{ $t('label.transmitted') }}</span>
          <span class="text-2xl m-2 tracking-wider">{{ transCount }}</span>
          <span>{{ $t('label.times') }}</span>
        </div>
      </div>
    </div>

    <!-- 接收确认弹窗 -->
    <Dialog
      :visible="!!incomingOffer"
      modal
      dismissable-mask
      :header="
        incomingOffer?.payload.type === 'transDir'
          ? $t('label.incomingFolder')
          : $t('label.incomingFile')
      "
      class="w-[90vw] md:w-[28rem]"
      @update:visible="(val: boolean) => !val && roomStore.rejectIncomingOffer()"
    >
      <div v-if="incomingOffer && incomingSummary" class="space-y-3">
        <div class="flex items-center gap-3">
          <Avatar shape="circle" :image="incomingOffer.from.avatarURL" />
          <p class="text-sm">
            <b>{{ incomingOffer.from.nickname }}</b>
            {{
              incomingOffer.payload.type === 'transDir'
                ? $t('hint.confirmReceiveFolder')
                : $t('hint.confirmReceiveFile')
            }}
          </p>
        </div>
        <div class="rounded-lg bg-neutral-50 dark:bg-zinc-800 p-3 text-sm">
          <p class="font-medium truncate">{{ incomingSummary.name }}</p>
          <p class="text-neutral-500 mt-1">
            {{ $t('label.fileCount', { count: incomingSummary.count }) }}
            · {{ formatSize(incomingSummary.totalSize) }}
          </p>
        </div>
      </div>
      <template #footer>
        <Button outlined severity="danger" :disabled="isBusy" @click="roomStore.rejectIncomingOffer">
          <Icon name="solar:close-square-linear" class="mr-2" />{{ $t('btn.decline') }}
        </Button>
        <Button severity="contrast" :disabled="isBusy" @click="roomStore.acceptIncomingOffer()">
          <Icon name="solar:check-square-linear" class="mr-2" />{{ $t('btn.accept') }}
        </Button>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.file-drag-area {
  display: none;
  opacity: 0;
  transition-property: opacity;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 300ms;
}

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
  20% {
    background-position:
      0 0,
      50% 50%,
      100% 50%;
  }
  40% {
    background-position:
      0 100%,
      50% 0,
      100% 50%;
  }
  60% {
    background-position:
      0 50%,
      50% 100%,
      100% 0;
  }
  80% {
    background-position:
      0 50%,
      50% 50%,
      100% 100%;
  }
  100% {
    background-position:
      0 50%,
      50% 50%,
      100% 50%;
  }
}
</style>
