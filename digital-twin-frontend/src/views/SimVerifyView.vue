<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { getActiveHullId, listHulls, phaseName } from '@/services/equipmentMap'
import { simApi, wsUrl } from '@/services/simApi'
import { createTwinBridge } from '@/services/twinBridge'

const plans = ref([])
const modesId = ref(null)
const selectedSimuId = ref('')
const modelGroups = ref(null)
const simStatus = ref(null)
const sentinel = ref(null)
const mockStatus = ref(null)
const busy = ref(false)
const errMsg = ref('')
const twinMode = ref('preview')
const cloudAddress = ref('ws://127.0.0.1:9000/')
const cloudEl = ref(null)
const sceneState = ref({
  mode: 'preview',
  connected: false,
  currentPhase: null,
  selectedTarget: null,
  activeHullId: getActiveHullId(),
  faultTargets: [],
  repairTargets: [],
})
const pose = ref({ lat: null, lon: null, speed: null, depth: null, phaseId: null })
const logs = ref([])
const faultLogs = ref([])
const activeHullId = ref(getActiveHullId())

let pollTimer = null
let mockWs = null
let resultWs = null
const twin = createTwinBridge({
  onLog: (e) => pushLog(e.msg, e.level),
  onSceneState: (s) => {
    sceneState.value = s
    if (s.activeHullId) activeHullId.value = s.activeHullId
  },
})

const selectedPlan = computed(() => plans.value.find((p) => String(p.simuId) === String(selectedSimuId.value)))
const hulls = listHulls()
const activeHullLabel = computed(
  () => hulls.find((h) => h.id === activeHullId.value)?.label || activeHullId.value || '-',
)
const switchingHull = ref(false)
/** 官方 environment.setWeather：1–11 */
const weatherOptions = [
  { value: 1, label: '晴空万里' },
  { value: 2, label: '少云' },
  { value: 3, label: '多云' },
  { value: 4, label: '阴天' },
  { value: 5, label: '雾天' },
  { value: 6, label: '小雨' },
  { value: 7, label: '中雨' },
  { value: 8, label: '暴风雨' },
  { value: 9, label: '小雪' },
  { value: 10, label: '中雪' },
  { value: 11, label: '暴风雪' },
]
const weatherLevel = ref(1)

function pushLog(msg, level = 'info') {
  logs.value.unshift({ msg, level, at: new Date().toLocaleTimeString() })
  if (logs.value.length > 200) logs.value.length = 200
}

function pushFault(msg) {
  faultLogs.value.unshift({ msg, at: new Date().toLocaleTimeString() })
  if (faultLogs.value.length > 100) faultLogs.value.length = 100
}

async function refreshMeta() {
  errMsg.value = ''
  try {
    const data = await simApi.getPlans()
    plans.value = data.jointList || data.list || []
    modesId.value = data.modesId
    if (!selectedSimuId.value && plans.value.length) {
      selectedSimuId.value = String(plans.value[0].simuId)
    }
    if (modesId.value) {
      modelGroups.value = await simApi.getModelGroups(modesId.value)
    }
  } catch (e) {
    errMsg.value = e.message
  }
}

async function refreshStatus() {
  try {
    ;[simStatus.value, sentinel.value, mockStatus.value] = await Promise.all([
      simApi.getStatus().catch(() => null),
      simApi.getSentinel().catch(() => null),
      simApi.mockStatus().catch(() => null),
    ])
  } catch {
    /* ignore poll errors */
  }
}

function connectSockets() {
  mockWs?.close()
  resultWs?.close()

  mockWs = new WebSocket(wsUrl('/ws/mock'))
  mockWs.onopen = () => pushLog('Mock WS 已连接')
  mockWs.onclose = () => pushLog('Mock WS 断开', 'warn')
  mockWs.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      const body = msg.DATABODY || msg.databody || msg
      const phaseId = body.phaseId
      pose.value = {
        lat: body.latitude,
        lon: body.longitude,
        speed: body.speed,
        depth: body.situation?.depth ?? tryParseDepth(body.situation),
        phaseId,
      }
      if (phaseId && String(phaseId) !== String(sceneState.value.currentPhase)) {
        twin.applyPhase(phaseId)
      }
    } catch {
      /* ignore malformed */
    }
  }

  resultWs = new WebSocket(wsUrl('/mw/ws/results'))
  resultWs.onopen = () => pushLog('Results WS 已连接')
  resultWs.onclose = () => pushLog('Results WS 断开', 'warn')
  resultWs.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      const body = msg.databody || msg.DATABODY || msg
      const type = body.type || msg.type
      if (type === 'FAULT_EVENT' || body.fault) {
        const fault = body.fault || body
        const status = fault.status || type
        const name = fault.equipmentName || fault.faultName
        pushFault(`${status} | ${fault.faultName || ''} @ ${name}`)
        await twin.highlightFault(name, status)
      } else if (type === 'SIMULATION_START' || type === 'SIMULATION_ENDED') {
        pushFault(`${type} simuId=${body.simuId || ''}`)
        pushLog(`仿真生命周期: ${type}`)
      }
    } catch {
      /* ignore */
    }
  }
}

function tryParseDepth(situation) {
  if (typeof situation !== 'string') return null
  try {
    return JSON.parse(situation).depth ?? null
  } catch {
    return null
  }
}

async function onConnectTwin() {
  busy.value = true
  errMsg.value = ''
  try {
    if (twinMode.value === 'cloud') {
      await nextTick()
      if (!cloudEl.value) throw new Error('云渲染容器未就绪')
      if (!window.PiClientJS?.PiClient) {
        throw new Error('PiClientJS 未加载，请硬刷新页面（需 /cimpro/*.js）')
      }
    }
    await twin.connect({
      mode: twinMode.value,
      container: cloudEl.value,
      address: cloudAddress.value,
    })
    nextTick(() => focusCloudStream())
  } catch (e) {
    errMsg.value = e.message
    pushLog(e.message, 'error')
  } finally {
    busy.value = false
  }
}

async function onDisconnectCloud() {
  twin.destroy()
  pushLog('已断开云渲染')
}

async function onEnterPlayMode() {
  try {
    await twin.enterPlayMode()
  } catch (e) {
    pushLog(e.message, 'error')
  }
}

async function onApplyWeather(level = weatherLevel.value) {
  weatherLevel.value = Number(level)
  try {
    await twin.testWeather(weatherLevel.value)
    const name = weatherOptions.find((w) => w.value === weatherLevel.value)?.label
    pushLog(`天气 → ${weatherLevel.value} ${name || ''}`)
  } catch (e) {
    pushLog(e.message, 'error')
  } finally {
    nextTick(() => focusCloudStream())
  }
}

function focusCloudStream() {
  const root = cloudEl.value
  if (!root) return
  root.focus?.({ preventScroll: true })
  const video = root.querySelector?.('video')
  video?.focus?.({ preventScroll: true })
  // 部分 PixelStreaming 实现挂在 video 上收指针，点一下确保命中
  video?.setAttribute?.('tabindex', '0')
}

async function onSelectHull(hull) {
  if (switchingHull.value) return
  if (hull.id === activeHullId.value) {
    void twin.selectActiveHull(hull.id, { fly: true })
    return
  }
  switchingHull.value = true
  activeHullId.value = hull.id
  pushLog(`切换舰体 → ${hull.label} (${hull.id})`)
  try {
    await twin.selectActiveHull(hull.id, { fly: true })
  } catch (e) {
    pushLog(e.message, 'error')
  } finally {
    switchingHull.value = false
    // 点过侧栏按钮后焦点离开视频，拖拽会失灵；切完抢回焦点
    nextTick(() => focusCloudStream())
  }
}

async function startMock() {
  busy.value = true
  errMsg.value = ''
  try {
    const plan = selectedPlan.value
    if (plan?.phaseData?.length) {
      await simApi.mockConfig({
        phases: plan.phaseData.map((p) => ({
          phaseId: String(p.phaseId),
          indTotalMinutes: Number(p.stageHours || 0) * 60 + Number(p.stageMinutes || 0) || undefined,
        })),
      })
    }
    await simApi.mockStart()
    pushLog('Mock 已启动')
    await refreshStatus()
  } catch (e) {
    errMsg.value = e.message
  } finally {
    busy.value = false
  }
}

async function stopMock() {
  busy.value = true
  try {
    await simApi.mockStop()
    pushLog('Mock 已停止')
    await refreshStatus()
  } catch (e) {
    errMsg.value = e.message
  } finally {
    busy.value = false
  }
}

async function startJoint() {
  busy.value = true
  errMsg.value = ''
  try {
    if (!sentinel.value?.ddsConnected && !sentinel.value?.sentinelOn) {
      await simApi.startSentinel().catch(() => null)
    }
    const plan = selectedPlan.value
    const phaseModelGroups = (plan?.phaseData || []).map((p) => ({
      phaseId: String(p.phaseId),
      modelGroupId: modesId.value,
    }))
    await simApi.startSim({
      simuId: selectedSimuId.value,
      speed: 1,
      phaseModelGroups,
    })
    pushLog(`联合仿真已启动 simuId=${selectedSimuId.value}`)
    await refreshStatus()
  } catch (e) {
    errMsg.value = e.message
  } finally {
    busy.value = false
  }
}

async function stopJoint() {
  busy.value = true
  try {
    await simApi.stopSim({ simuId: selectedSimuId.value })
    pushLog('联合仿真已停止')
    await refreshStatus()
  } catch (e) {
    errMsg.value = e.message
  } finally {
    busy.value = false
  }
}

function hullClass(hull) {
  return hull.id === activeHullId.value ? 'hull-card active' : 'hull-card'
}

onMounted(async () => {
  await refreshMeta()
  await refreshStatus()
  connectSockets()
  await twin.connect({ mode: 'preview' })
  pollTimer = setInterval(refreshStatus, 5000)
})

onUnmounted(() => {
  clearInterval(pollTimer)
  mockWs?.close()
  resultWs?.close()
  twin.destroy()
})
</script>

<template>
  <div class="page">
    <header class="header">
      <div>
        <h1>孪生开发流验证</h1>
        <p class="sub">CIMPro 场景对象 ↔ underwater-mock 仿真链路</p>
      </div>
      <div class="status-chips">
        <span class="chip" :class="{ on: mockStatus?.running }">Mock {{ mockStatus?.running ? '运行' : '停止' }}</span>
        <span class="chip" :class="{ on: simStatus?.running }">联合仿真 {{ simStatus?.running ? '运行' : '停止' }}</span>
        <span class="chip" :class="{ on: sentinel?.ddsConnected || sentinel?.sentinelOn }">
          Sentinel {{ sentinel?.ddsConnected || sentinel?.sentinelOn ? '就绪' : '未连' }}
        </span>
      </div>
    </header>

    <p v-if="errMsg" class="error-banner">{{ errMsg }}</p>

    <section class="panel controls">
      <div class="row">
        <label>试验方案</label>
        <select v-model="selectedSimuId">
          <option v-for="p in plans" :key="p.simuId" :value="String(p.simuId)">
            {{ p.simuName || p.name || p.simuId }}
          </option>
        </select>
        <span class="hint">模型集 ID: {{ modesId ?? '-' }}</span>
        <button type="button" class="ghost" :disabled="busy" @click="refreshMeta">刷新</button>
      </div>

      <div v-if="selectedPlan?.phaseData?.length" class="phases">
        阶段:
        <span v-for="p in selectedPlan.phaseData" :key="p.phaseId" class="phase-tag">
          {{ p.phaseId }} {{ p.phaseName || phaseName(p.phaseId) }}
        </span>
      </div>

      <div class="row buttons">
        <button type="button" class="primary" :disabled="busy" @click="startMock">启动 Mock</button>
        <button type="button" :disabled="busy" @click="stopMock">停止 Mock</button>
        <button type="button" class="primary" :disabled="busy || !selectedSimuId" @click="startJoint">
          启动联合仿真
        </button>
        <button type="button" class="danger" :disabled="busy" @click="stopJoint">停止联合仿真</button>
      </div>
    </section>

    <section v-if="twinMode === 'cloud'" class="panel stream-panel">
      <div class="row stream-toolbar">
        <h3>云渲染画面</h3>
        <span class="hint" :class="{ on: sceneState.connected }">
          {{ sceneState.connected ? '已连接（投屏 + emit 通道）' : '未连接' }}
          · 接入方式对齐官方 前端示例/pixel.html
        </span>
      </div>
      <div class="pixel-shell" title="点击画面可重新获得拖拽焦点">
        <div
          ref="cloudEl"
          id="renderContainer"
          class="cloud-box active"
          tabindex="0"
          @pointerdown.capture="focusCloudStream"
        />
      </div>
    </section>

    <div class="grid">
      <section class="panel">
        <h3>孪大师连接</h3>
        <div class="row">
          <label>模式</label>
          <select v-model="twinMode">
            <option value="preview">preview（先联调业务，不连客户端）</option>
            <option value="embed">embed（页面跑在 CIMPro 内）</option>
            <option value="cloud">cloud（PiStudio 像素流）</option>
          </select>
        </div>
        <div v-if="twinMode === 'cloud'" class="row">
          <label>信令</label>
          <input v-model="cloudAddress" class="grow" />
        </div>
        <div class="row buttons">
          <button type="button" class="primary" :disabled="busy" @click="onConnectTwin">连接云渲染</button>
          <button type="button" class="danger" :disabled="busy" @click="onDisconnectCloud">断开</button>
          <button type="button" :disabled="busy || !sceneState.connected" @click="onEnterPlayMode">
            播放模式 / 藏 UI
          </button>
        </div>
        <div v-if="twinMode === 'cloud'" class="weather-block">
          <div class="row">
            <label>天气</label>
            <select v-model.number="weatherLevel" :disabled="!sceneState.connected" class="weather-select">
              <option v-for="w in weatherOptions" :key="w.value" :value="w.value">
                {{ w.value }} · {{ w.label }}
              </option>
            </select>
            <button type="button" class="primary" :disabled="!sceneState.connected" @click="onApplyWeather()">
              应用天气
            </button>
          </div>
          <div class="weather-chips">
            <button
              v-for="w in weatherOptions"
              :key="w.value"
              type="button"
              class="weather-chip"
              :class="{ on: weatherLevel === w.value }"
              :disabled="!sceneState.connected"
              @click="onApplyWeather(w.value)"
            >
              {{ w.label }}
            </button>
          </div>
          <p class="hint">对应官方 API：environment.setWeather，weather = 1–11（雨/雪越往后越强）</p>
        </div>
        <p class="hint">
          当前: {{ sceneState.mode }} · 连接 {{ sceneState.connected ? '是' : '否' }} · 阶段
          {{ sceneState.currentPhase || '-' }}
        </p>
      </section>

      <section class="panel">
        <h3>场景舰体切换</h3>
        <p class="hint">点一张卡即可切换当前舰并飞相机；灰底只是「未选中」，不是灰掉不能点。</p>
        <div class="hull-grid">
          <button
            v-for="hull in hulls"
            :key="hull.id"
            type="button"
            :class="hullClass(hull)"
            :disabled="switchingHull"
            @click="onSelectHull(hull)"
          >
            <strong>{{ hull.label }}</strong>
            <span class="hull-id">{{ hull.id }}</span>
            <span class="hull-tag">{{ hull.id === activeHullId ? '当前' : '点此切换' }}</span>
          </button>
        </div>
        <p class="hint">当前舰：{{ activeHullLabel }}{{ switchingHull ? '（切换中…）' : '' }}</p>
        <div class="pose">
          <div>经度 {{ pose.lon ?? '-' }}</div>
          <div>纬度 {{ pose.lat ?? '-' }}</div>
          <div>航速 {{ pose.speed ?? '-' }}</div>
          <div>深度 {{ pose.depth ?? '-' }}</div>
          <div>phaseId {{ pose.phaseId ?? '-' }}</div>
          <div>步数 {{ simStatus?.currentStep ?? '-' }} / {{ simStatus?.totalSteps ?? '-' }}</div>
        </div>
      </section>

      <section class="panel">
        <h3>模型集（只读）</h3>
        <pre class="pre">{{ modelGroups ? JSON.stringify(modelGroups, null, 2) : '未加载' }}</pre>
      </section>

      <section class="panel">
        <h3>故障回传</h3>
        <div class="log">
          <div v-for="(l, i) in faultLogs" :key="i" class="fault">[{{ l.at }}] {{ l.msg }}</div>
          <div v-if="!faultLogs.length" class="hint">等待 /mw/ws/results …</div>
        </div>
      </section>

      <section class="panel wide">
        <h3>联调日志</h3>
        <div class="log">
          <div v-for="(l, i) in logs" :key="i" :class="l.level">[{{ l.at }}] {{ l.msg }}</div>
        </div>
        <p class="hint">
          映射文件: src/config/equipment-map.json · 模型:
          ../assets/models/sim_submarine_verify.gltf · 导入说明: ../assets/IMPORT_TO_CIMPRO.md
        </p>
        <p class="hint">
          可选舰体 {{ hulls.map((h) => h.id).join(' / ') }} · 当前 {{ activeHullId }}
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 20px 24px 40px;
  background: radial-gradient(1200px 600px at 10% -10%, #1a3a4a 0%, transparent 55%),
    linear-gradient(160deg, #0b1220, #121a2b 40%, #0e1624);
  color: #e8eef7;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 16px;
}
h1 {
  margin: 0;
  font-size: 1.5rem;
  letter-spacing: 0.02em;
}
.sub {
  margin: 4px 0 0;
  color: #8aa0b8;
  font-size: 13px;
}
.status-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #35506a;
  background: #152033;
  font-size: 12px;
  color: #9bb0c7;
}
.chip.on {
  border-color: #2f8f5b;
  color: #9be7b8;
  background: #123526;
}
.error-banner {
  background: #4a1d1d;
  border: 1px solid #a33;
  color: #ffb4b4;
  padding: 8px 12px;
  border-radius: 8px;
}
.panel {
  background: rgba(22, 32, 48, 0.92);
  border: 1px solid #2a3b55;
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 12px;
}
.panel h3 {
  margin: 0 0 10px;
  font-size: 14px;
  color: #9ec5e8;
  border-bottom: 1px solid #2a3b55;
  padding-bottom: 6px;
}
.controls .row,
.row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
label {
  font-size: 13px;
  color: #9bb0c7;
}
select,
input {
  background: #0f1724;
  border: 1px solid #3a4f6a;
  color: #e8eef7;
  border-radius: 6px;
  padding: 6px 10px;
  min-width: 220px;
}
input.grow {
  flex: 1;
  min-width: 280px;
}
.hint {
  color: #7f93ab;
  font-size: 12px;
}
.phases {
  font-size: 12px;
  color: #a8c7a0;
  margin-bottom: 10px;
}
.phase-tag {
  display: inline-block;
  margin-right: 8px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #1c2c1c;
}
button {
  background: #2a3f63;
  border: none;
  color: #fff;
  padding: 7px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
button:hover {
  filter: brightness(1.08);
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
button.primary {
  background: #2f8f5b;
}
button.danger {
  background: #b33b3b;
}
button.ghost {
  background: #243247;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.wide {
  grid-column: 1 / -1;
}
.stream-panel {
  margin-bottom: 12px;
}
.stream-toolbar {
  justify-content: space-between;
  margin-bottom: 8px;
}
.stream-toolbar h3 {
  margin: 0;
  font-size: 14px;
  color: #9ec5e8;
}
.stream-toolbar .hint.on {
  color: #9be7b8;
}
.weather-block {
  margin-top: 4px;
  margin-bottom: 8px;
}
.weather-select {
  min-width: 160px;
}
.weather-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 4px;
}
.weather-chip {
  padding: 4px 10px;
  font-size: 12px;
  background: #1a2738;
  border: 1px solid #334860;
  border-radius: 999px;
  color: #9bb0c7;
}
.weather-chip.on {
  border-color: #4ea1ff;
  color: #d7e6f7;
  background: #15304a;
}
.weather-chip:disabled {
  opacity: 0.45;
}
/* 对齐官方 pixel.html：固定壳 + 绝对铺满的 renderContainer */
.pixel-shell {
  position: relative;
  width: 100%;
  height: min(56vh, 640px);
  background: #000;
  border-radius: 8px;
  border: 1px solid #35506a;
  overflow: hidden;
}
.cloud-box {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #000;
  box-sizing: border-box;
  outline: none;
  cursor: grab;
}
.cloud-box:focus,
.cloud-box:focus-within {
  outline: 1px solid #4ea1ff55;
}
.cloud-box :deep(video),
.cloud-box :deep(canvas) {
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
  pointer-events: auto !important;
}
.hull-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 10px;
}
.hull-card {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: #152033;
  border: 1px solid #334860;
  padding: 10px 12px;
}
.hull-card.active {
  border-color: #4ea1ff;
  box-shadow: 0 0 0 1px #4ea1ff55;
  background: #15304a;
}
.hull-card .hull-id {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: #8aa0b8;
}
.hull-card .hull-tag {
  font-size: 11px;
  color: #7f93ab;
}
.hull-card.active .hull-tag {
  color: #9be7b8;
}
.eq-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.eq {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #152033;
  border: 1px solid #334860;
  padding: 8px 10px;
}
.eq strong {
  font-size: 12px;
  color: #d7e6f7;
}
.eq span {
  font-size: 11px;
  color: #8aa0b8;
}
.eq.selected {
  border-color: #4ea1ff;
  box-shadow: 0 0 0 1px #4ea1ff55;
}
.eq.fault {
  border-color: #ff6b4a;
  background: #3a1a14;
}
.eq.repair {
  border-color: #e6b84d;
  background: #3a3014;
}
.pose {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
  margin-top: 12px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: #9cdcfe;
}
.pre {
  max-height: 240px;
  overflow: auto;
  background: #0d1420;
  padding: 8px;
  border-radius: 8px;
  font-size: 11px;
  color: #9cdcfe;
}
.log {
  height: 220px;
  overflow: auto;
  background: #0d1420;
  border-radius: 8px;
  padding: 8px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
.log .error {
  color: #ff8e8e;
}
.log .warn {
  color: #e6c07b;
}
.log .fault {
  color: #ffb074;
}
.log .info {
  color: #a8d5a2;
}
@media (max-width: 960px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .eq-grid {
    grid-template-columns: 1fr;
  }
}
</style>
