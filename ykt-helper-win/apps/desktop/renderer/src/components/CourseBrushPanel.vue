<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  DefaultCourseBrushConfig,
  type CourseBrushConfig,
  type CourseBrushState,
} from '@ykt/contracts';

const state = ref<CourseBrushState>({
  status: 'idle',
  config: { ...DefaultCourseBrushConfig },
  currentRoute: 'unknown',
  currentTaskTitle: '未开始',
  completedCount: 0,
  answeredQuestionCount: 0,
  parentTabId: null,
  activeTaskTabId: null,
  lastProbe: null,
  lastAiAnswer: null,
  logs: [],
});

const busy = ref('');
const errorMsg = ref('');
let unsubscribe: (() => void) | undefined;

const speedOptions = [1.0, 1.25, 1.5, 2.0, 3.0, 4.0];

const statusLabel = computed(() => {
  switch (state.value.status) {
    case 'running':
      return '运行中';
    case 'paused':
      return '已暂停';
    case 'stopping':
      return '停止中';
    default:
      return '空闲';
  }
});

onMounted(async () => {
  unsubscribe = window.yuketang.onCourseBrushStateChanged((next) => {
    state.value = next;
  });
  try {
    state.value = await window.yuketang.getCourseBrushState();
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '无法读取刷课状态';
  }
});

onUnmounted(() => {
  unsubscribe?.();
});

async function runAction(key: string, fn: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = key;
  errorMsg.value = '';
  try {
    await fn();
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '操作执行失败';
  } finally {
    busy.value = '';
  }
}

function updateConfig(patch: Partial<CourseBrushConfig>): void {
  void runAction('config', async () => {
    state.value = await window.yuketang.updateCourseBrushConfig(patch);
  });
}

function onSpeedChange(event: Event): void {
  const rate = Number((event.target as HTMLSelectElement).value);
  if (Number.isFinite(rate)) {
    updateConfig({ playbackRate: rate });
  }
}

function startBrush(): void {
  void runAction('start', async () => {
    state.value = await window.yuketang.startCourseBrush();
  });
}

function pauseBrush(): void {
  void runAction('pause', async () => {
    state.value = await window.yuketang.pauseCourseBrush();
  });
}

function stopBrush(): void {
  void runAction('stop', async () => {
    state.value = await window.yuketang.stopCourseBrush();
  });
}

function probePage(): void {
  void runAction('probe', async () => {
    await window.yuketang.probeCourseBrushPage(true);
    state.value = await window.yuketang.getCourseBrushState();
  });
}

function solveSingle(submit: boolean): void {
  void runAction(submit ? 'solve-submit' : 'solve-dry', async () => {
    await window.yuketang.solveCurrentBrushQuestion(submit);
    state.value = await window.yuketang.getCourseBrushState();
  });
}

function solveAllOnPage(): void {
  void runAction('solve-all', async () => {
    state.value = await window.yuketang.solveAllBrushQuestionsOnPage();
  });
}

function clearLogs(): void {
  void runAction('clear-logs', async () => {
    state.value = await window.yuketang.clearCourseBrushLogs();
  });
}
</script>

<template>
  <div class="course-brush-panel">
    <div class="heading">
      <div>
        <h2>自动刷课 & AI 作业联调</h2>
        <p class="muted">
          原生截图视觉审题 + 闭环 DOM 控制 · 支持 V2 / Pro / AI 图谱全路由
        </p>
      </div>
      <span class="status-badge" :class="state.status">{{ statusLabel }}</span>
    </div>

    <div v-if="errorMsg" class="notice error" role="alert">
      {{ errorMsg }}
    </div>

    <section class="card">
      <div class="stat-row">
        <div>
          <span class="label">当前任务</span>
          <strong class="task-title">{{ state.currentTaskTitle }}</strong>
        </div>
        <div class="counters">
          <span>已刷章节：<strong>{{ state.completedCount }}</strong></span>
          <span>已答题目：<strong>{{ state.answeredQuestionCount }}</strong></span>
        </div>
      </div>

      <div class="btn-row">
        <button
          type="button"
          class="primary"
          :disabled="state.status === 'running' || Boolean(busy)"
          @click="startBrush"
        >
          {{ state.status === 'paused' ? '▶ 继续刷课' : '🚀 启动自动刷课' }}
        </button>
        <button
          type="button"
          :disabled="state.status !== 'running' || Boolean(busy)"
          @click="pauseBrush"
        >
          ⏸ 暂停
        </button>
        <button
          type="button"
          class="danger"
          :disabled="state.status === 'idle' || Boolean(busy)"
          @click="stopBrush"
        >
          ⏹ 停止
        </button>
      </div>
    </section>

    <section class="card">
      <h3>刷课配置</h3>
      <div class="config-grid">
        <label class="field">
          <span>视频/音频倍速</span>
          <select
            :value="state.config.playbackRate"
            @change="onSpeedChange"
          >
            <option v-for="s in speedOptions" :key="s" :value="s">
              {{ s }}x 倍速
            </option>
          </select>
        </label>

        <label class="check">
          <input
            type="checkbox"
            :checked="state.config.muteAudio"
            @change="updateConfig({ muteAudio: !state.config.muteAudio })"
          />
          <span>默认静音播放</span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            :checked="state.config.enableVideo"
            @change="updateConfig({ enableVideo: !state.config.enableVideo })"
          />
          <span>刷视频 / 音频</span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            :checked="state.config.enableCourseware"
            @change="
              updateConfig({ enableCourseware: !state.config.enableCourseware })
            "
          />
          <span>刷课件 PPT（含内嵌视频）</span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            :checked="state.config.enableReplay"
            @change="updateConfig({ enableReplay: !state.config.enableReplay })"
          />
          <span>刷课堂回放</span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            :checked="state.config.enableDiscussion"
            @change="
              updateConfig({ enableDiscussion: !state.config.enableDiscussion })
            "
          />
          <span>讨论区自动跟评</span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            :checked="state.config.enableHomework"
            @change="
              updateConfig({ enableHomework: !state.config.enableHomework })
            "
          />
          <span>作业 / 习题 AI 自动作答</span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            :checked="state.config.autoSubmitHomework"
            @change="
              updateConfig({
                autoSubmitHomework: !state.config.autoSubmitHomework,
              })
            "
          />
          <span>作答后自动点击「提交」</span>
        </label>
      </div>
    </section>

    <section class="card">
      <h3>🛠️ 页面探测 & 手动控制</h3>
      <div class="btn-grid">
        <button
          type="button"
          :disabled="Boolean(busy)"
          @click="probePage"
        >
          {{ busy === 'probe' ? '探测中…' : '🔍 探测当前页面' }}
        </button>
        <button
          type="button"
          :disabled="Boolean(busy)"
          @click="solveSingle(false)"
        >
          {{ busy === 'solve-dry' ? '解答中…' : '🧪 单题 AI 试答（不提交）' }}
        </button>
        <button
          type="button"
          class="primary"
          :disabled="Boolean(busy)"
          @click="solveSingle(true)"
        >
          {{ busy === 'solve-submit' ? '作答提交中…' : '⚡ 单题 AI 作答并提交' }}
        </button>
        <button
          type="button"
          class="primary"
          :disabled="Boolean(busy)"
          @click="solveAllOnPage"
        >
          {{ busy === 'solve-all' ? '批量作答中…' : '📝 自动作答本页全部题' }}
        </button>
      </div>

      <div v-if="state.lastProbe" class="probe-box">
        <div class="probe-line">
          <span>识别路由：</span>
          <strong>{{ state.lastProbe.routeLabel }} ({{ state.lastProbe.route }})</strong>
        </div>
        <div v-if="state.lastProbe.directoryItemsTotal > 0" class="probe-line">
          <span>课程目录：</span>
          <strong>
            待完成 {{ state.lastProbe.directoryItemsPending }} / 共
            {{ state.lastProbe.directoryItemsTotal }} 项
          </strong>
        </div>
        <div
          v-if="
            state.lastProbe.mediaStatus.hasVideo ||
            state.lastProbe.mediaStatus.hasAudio
          "
          class="probe-line"
        >
          <span>音视频状态：</span>
          <strong>
            {{ state.lastProbe.mediaStatus.paused ? '已暂停' : '播放中' }} ·
            {{ state.lastProbe.mediaStatus.playbackRate ?? 1 }}x ·
            {{ state.lastProbe.mediaStatus.progressText || '进行中' }}
          </strong>
        </div>

        <template v-if="state.lastProbe.questionProbe.found">
          <div class="probe-line">
            <span>当前题目：</span>
            <strong>
              第 {{ state.lastProbe.questionProbe.questionIndex + 1 }} /
              {{ state.lastProbe.questionProbe.totalQuestions }} 题 ·
              {{ state.lastProbe.questionProbe.typeLabel }}
              <span
                v-if="state.lastProbe.questionProbe.hasEncryptedFont"
                class="tag warn"
              >
                含加密字体
              </span>
              <span
                v-if="state.lastProbe.questionProbe.alreadyAnswered"
                class="tag ok"
              >
                已作答/已批改
              </span>
            </strong>
          </div>
          <div class="probe-line">
            <span>控件识别：</span>
            <span>
              选项 {{ state.lastProbe.questionProbe.options.length }} 个 ·
              填空输入框 {{ state.lastProbe.questionProbe.blankCount }} 个 ·
              提交按钮：{{
                state.lastProbe.questionProbe.submitButtonText
                  ? `${state.lastProbe.questionProbe.submitButtonText} (${state.lastProbe.questionProbe.canSubmit ? '可点' : '待选选项后激活'})`
                  : '未检测到'
              }}
            </span>
          </div>
          <ul
            v-if="state.lastProbe.questionProbe.options.length"
            class="opt-list"
          >
            <li
              v-for="opt in state.lastProbe.questionProbe.options"
              :key="opt.index"
              :class="{ selected: opt.selected }"
            >
              <strong>{{ opt.label }}.</strong>
              <span>{{ opt.text || '(图像/公式选项)' }}</span>
              <em v-if="opt.selected">[当前已选]</em>
            </li>
          </ul>
          <details
            v-if="state.lastProbe.questionProbe.screenshotDataUrl"
            class="screenshot-preview"
          >
            <summary>查看题目区域原生高清截图（供视觉大模型审题）</summary>
            <img
              :src="state.lastProbe.questionProbe.screenshotDataUrl"
              alt="当前题目裁剪截图"
            />
          </details>
        </template>
      </div>

      <div v-if="state.lastAiAnswer" class="ai-result-box">
        <div class="probe-line">
          <span>最近 AI 作答：</span>
          <strong>
            {{ state.lastAiAnswer.questionTitle }} → 【{{
              state.lastAiAnswer.answerText
            }}】
          </strong>
        </div>
        <p v-if="state.lastAiAnswer.explanation" class="muted small">
          解析：{{ state.lastAiAnswer.explanation }}
        </p>
      </div>
    </section>

    <section class="card logs-card">
      <div class="logs-header">
        <h3>运行与联调日志 ({{ state.logs.length }})</h3>
        <button
          type="button"
          class="small-btn"
          :disabled="!state.logs.length"
          @click="clearLogs"
        >
          清空
        </button>
      </div>
      <div v-if="!state.logs.length" class="empty">
        暂无日志。打开雨课堂课程学习页或作业页后，可点击「探测当前页面」或「启动自动刷课」。
      </div>
      <ul v-else class="log-list">
        <li
          v-for="item in state.logs"
          :key="item.id"
          :class="item.level"
        >
          <span class="time">{{ item.timestamp }}</span>
          <span class="msg">{{ item.message }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.course-brush-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
  line-height: 1.5;
}
.heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.heading h2 {
  margin: 0;
  font-size: 16px;
}
.muted {
  color: var(--text-muted);
  margin: 2px 0 0;
}
.small {
  font-size: 12px;
}
.status-badge {
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--surface-subtle, #eef1f5);
}
.status-badge.running {
  background: #e6f6ec;
  color: #1f6f43;
}
.status-badge.paused {
  background: #fff4df;
  color: #8a5a00;
}
.card {
  border: 1px solid var(--line, #dde2ea);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--surface, #fff);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card h3 {
  margin: 0;
  font-size: 14px;
}
.stat-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stat-row .label {
  font-size: 12px;
  color: var(--text-muted);
  display: block;
}
.task-title {
  display: block;
  word-break: break-word;
}
.counters {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--text-muted);
}
.btn-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.btn-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
button,
select {
  font: inherit;
  border: 1px solid var(--line-strong, #c5cdd8);
  border-radius: 6px;
  padding: 6px 10px;
  background: var(--surface, #fff);
  color: var(--text, #1d2430);
  cursor: pointer;
}
button.primary {
  background: #1f6feb;
  border-color: #1f6feb;
  color: #fff;
  font-weight: 500;
}
button.danger {
  background: #fff0ee;
  border-color: #e4b4ae;
  color: #93413b;
}
button.small-btn {
  padding: 2px 8px;
  font-size: 12px;
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-items: center;
}
.field {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.probe-box,
.ai-result-box {
  background: var(--surface-subtle, #f6f8fa);
  border-radius: 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.probe-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  margin-left: 4px;
}
.tag.warn {
  background: #fff3dc;
  color: #85570d;
}
.tag.ok {
  background: #e6f6ec;
  color: #1f6f43;
}
.opt-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.opt-list li.selected {
  color: #1f6feb;
  font-weight: 600;
}
.opt-list em {
  margin-left: 6px;
  font-style: normal;
  color: #1f6f43;
}
.screenshot-preview img {
  margin-top: 6px;
  max-width: 100%;
  border-radius: 6px;
  border: 1px solid var(--line, #dde2ea);
}
.logs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.log-list li {
  display: flex;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 4px;
  background: var(--surface-subtle, #f6f8fa);
}
.log-list li.success {
  background: #eaf7ef;
  color: #1d643b;
}
.log-list li.warn {
  background: #fff6e5;
  color: #85570d;
}
.log-list li.error {
  background: #fff0ee;
  color: #93413b;
}
.log-list .time {
  color: var(--text-muted);
  flex-shrink: 0;
}
.notice.error {
  background: #fff0ee;
  color: #93413b;
  padding: 8px 10px;
  border-radius: 6px;
}
.empty {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
