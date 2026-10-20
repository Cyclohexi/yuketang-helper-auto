<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { AppUpdateState } from '@ykt/contracts';

const state = ref<AppUpdateState>();
const error = ref('');
let unsubscribe: (() => void) | undefined;
const busy = computed(() =>
  ['checking', 'downloading', 'installing'].includes(state.value?.phase ?? ''),
);
const label = computed(() => {
  switch (state.value?.phase) {
    case 'checking':
      return '检查更新中…';
    case 'available':
      return `下载新版 ${state.value.latestVersion}`;
    case 'downloading':
      return state.value.progress === undefined
        ? '更新下载中…'
        : `下载 ${state.value.progress}%`;
    case 'ready':
      return '重启更新';
    case 'installing':
      return '正在安装…';
    case 'error':
      return '更新失败 · 重试';
    case 'current':
      return `v${state.value.currentVersion} · 已是最新`;
    default:
      return state.value
        ? `v${state.value.currentVersion} · 检查更新`
        : '检查更新';
  }
});

onMounted(async () => {
  unsubscribe = window.yuketang.onAppUpdateStateChanged((value) => {
    state.value = value;
    error.value = '';
  });
  try {
    state.value = await window.yuketang.getAppUpdateState();
  } catch {
    error.value = '无法读取更新状态，请重试。';
  }
});
onUnmounted(() => unsubscribe?.());

async function act(): Promise<void> {
  error.value = '';
  try {
    if (state.value?.phase === 'available')
      state.value = await window.yuketang.downloadAppUpdate();
    else if (state.value?.phase === 'ready') {
      if (
        window.confirm(
          '立即关闭应用并安装更新？正在进行的课堂和课程自动化任务将停止，本地设置和登录数据会保留。',
        )
      ) {
        state.value = await window.yuketang.installAppUpdate();
      }
    } else state.value = await window.yuketang.checkAppUpdate();
  } catch {
    error.value = '更新操作失败，请重试。';
  }
}
</script>

<template>
  <div v-if="state?.phase !== 'disabled'" class="app-update-control">
    <button
      type="button"
      :disabled="busy"
      :class="{
        highlight: state?.phase === 'available' || state?.phase === 'ready',
      }"
      :title="error || state?.message || '检查应用更新'"
      @click="act"
    >
      {{ label }}
    </button>
    <span class="update-announcement" role="status" aria-live="polite">{{
      error || state?.message
    }}</span>
  </div>
</template>

<style scoped>
.app-update-control {
  margin-left: auto;
  flex-shrink: 0;
  padding: 0 12px;
}
button {
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 5px 10px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}
button.highlight {
  color: var(--green-strong);
  background: var(--green-soft);
  border-color: var(--green);
}
button:disabled {
  cursor: wait;
  opacity: 0.7;
}
button:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 2px;
}
.update-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
