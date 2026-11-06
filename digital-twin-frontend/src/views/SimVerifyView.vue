<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import {
  getActiveHull,
  getActiveHullId,
  getEditableEquipments,
  getEditableHulls,
  phaseName,
  resetEquipmentsToDefaults,
  resetHullsToDefaults,
  saveEquipments,
  saveHulls,
} from '@/services/equipmentMap'
import { simApi, wsUrl } from '@/services/simApi'
import { createTwinBridge } from '@/services/twinBridge'

const plans = ref([])
const modesId = ref(null)
const selectedSimuId = ref('')
const simStatus = ref(null)
const sentinel = ref(null)
const mockStatus = ref(null)
const busy = ref(false)
const errMsg = ref('')
let errMsgTimer = null
/** 默认云渲染信令，不再提供模式切换 */
const cloudAddress = ref(import.meta.env.VITE_CLOUD_SIGNAL || 'ws://127.0.0.1:9000/')
const cloudEl = ref(null)
const sendLogEl = ref(null)
const faultLogEl = ref(null)
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
/** 对齐水下模拟页：左侧态势推送日志 / 右侧故障回传 */
const sendLogs = ref([])
const faultLogs = ref([])
const activeHullId = ref(getActiveHullId())
/** 孪生场景对象目录（供 Tag 下拉） */
const sceneObjects = ref([])

let pollTimer = null
let mockWs = null
let resultWs = null
/** 页面卸载后禁止 WS 自动重连 */
let socketsWanted = true
const twin = createTwinBridge({
  onLog: (e) => {
    // Mock→DDS 态势栏：不要云渲染调试噪音（scene/debug/普通 info）
    // 仅保留孪生侧 error，业务提示走页面 pushLog
    if (e.level === 'scene' || e.level === 'debug') return
    if (e.level !== 'error') return
    pushSendLog(e.msg, 'error')
  },
  onSceneState: (s) => {
    sceneState.value = s
    if (s.activeHullId) activeHullId.value = s.activeHullId
  },
  onSceneObjects: (list) => {
    sceneObjects.value = list || []
  },
})

const selectedPlan = computed(() => plans.value.find((p) => String(p.simuId) === String(selectedSimuId.value)))
const hullRows = ref(getEditableHulls())
const hullDirty = ref(false)
const activeHullLabel = computed(
  () =>
    hullRows.value.find((h) => h.id === activeHullId.value)?.label ||
    activeHullId.value ||
    '-',
)
const switchingHull = ref(false)
/** 已应用航行态势的舰体 ObjectId 集合（按艇记忆，换艇不丢失） */
const poseBoundObjectIds = ref(/** @type {string[]} */ ([]))
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
/** 页面可编辑：仿真设备 ↔ 孪生 ObjectId（locked 为 UI 态，不落盘） */
const mappingRows = ref(
  getEditableEquipments().map((r) => ({ ...r, locked: true })),
)
const mappingDirty = ref(false)
const DEFAULT_EQUIP_TREE_ID = 19

const mapModal = ref({
  open: false,
  step: 'tree', // tree | bind
  loading: false,
  error: '',
  treeId: null,
  treeName: '',
  flatNodes: [],
  selectedNode: null,
  objectIdDraft: '',
  idManual: false,
})

/** API 调试弹窗：左侧语句 / 右侧结果；执行冷却 5s */
const apiModal = ref({
  open: false,
  input: '',
  output: '',
  running: false,
})
const apiCooldownSec = ref(0)
let apiCooldownTimer = null

const sceneObjectIdOptions = computed(() =>
  (sceneObjects.value || []).filter((o) => o.objectId),
)

/** 必须依赖响应式 activeHullId；勿优先 getActiveHull()（非响应式会导致换艇按钮不更新） */
const activeHullObjectId = computed(() => {
  const id = activeHullId.value
  const hull =
    hullRows.value.find((h) => h.id === id || h.objectId === id) || getActiveHull()
  return String(hull?.objectId || '').trim()
})

const poseBoundForActiveHull = computed(() => {
  const id = activeHullObjectId.value
  return !!id && poseBoundObjectIds.value.includes(id)
})

/** 至少一艘舰已应用航行态势，才允许启动联合仿真 */
const hasPoseBinding = computed(() => poseBoundObjectIds.value.length > 0)

const simRunning = computed(() => !!simStatus.value?.running)

function clearErrMsg() {
  if (errMsgTimer) {
    clearTimeout(errMsgTimer)
    errMsgTimer = null
  }
  errMsg.value = ''
}

/** 顶部错误条：几秒后自动消失 */
function showErr(msg, ms = 5000) {
  if (errMsgTimer) {
    clearTimeout(errMsgTimer)
    errMsgTimer = null
  }
  errMsg.value = String(msg || '')
  if (!errMsg.value) return
  errMsgTimer = setTimeout(() => {
    errMsg.value = ''
    errMsgTimer = null
  }, ms)
}

function flattenEquipTree(nodes, depth = 0, acc = []) {
  for (const n of nodes || []) {
    acc.push({
      id: n.id,
      parentNodeId: n.parentNodeId,
      deviceCode: n.deviceCode || '',
      deviceName: n.deviceName || '',
      depth,
      hasChildren: Array.isArray(n.children) && n.children.length > 0,
    })
    if (n.children?.length) flattenEquipTree(n.children, depth + 1, acc)
  }
  return acc
}

function scrollLogToEnd(el) {
  nextTick(() => {
    if (el) el.scrollTop = el.scrollHeight
  })
}

function pushSendLog(msg, level = 'info') {
  sendLogs.value.push({ msg, level, at: new Date().toLocaleTimeString() })
  if (sendLogs.value.length > 200) sendLogs.value.splice(0, sendLogs.value.length - 200)
  scrollLogToEnd(sendLogEl.value)
}

function pushLog(msg, level = 'info') {
  pushSendLog(msg, level)
}

function pushFault(msg, level = 'fault') {
  faultLogs.value.push({ msg, level, at: new Date().toLocaleTimeString() })
  if (faultLogs.value.length > 200) faultLogs.value.splice(0, faultLogs.value.length - 200)
  scrollLogToEnd(faultLogEl.value)
}

function clearAllLogs() {
  sendLogs.value = []
  faultLogs.value = []
}

async function refreshMeta() {
  clearErrMsg()
  try {
    const data = await simApi.getPlans()
    plans.value = data.jointList || data.list || []
    modesId.value = data.modesId
    if (!selectedSimuId.value && plans.value.length) {
      selectedSimuId.value = String(plans.value[0].simuId)
    }
  } catch (e) {
    showErr(e.message)
  }
}

function isSimStepsDone(st) {
  const cur = Number(st?.currentStep)
  const total = Number(st?.totalSteps)
  return Number.isFinite(total) && total > 0 && Number.isFinite(cur) && cur >= total
}

async function refreshStatus() {
  try {
    const [sim, sent, mock] = await Promise.all([
      simApi.getStatus().catch(() => null),
      simApi.getSentinel().catch(() => null),
      simApi.mockStatus().catch(() => null),
    ])
    // 轮询失败时保留上一拍，避免误判 running 掉线而乱停巡航
    if (sent != null) sentinel.value = sent
    if (mock != null) mockStatus.value = mock
    if (sim != null) {
      const wasRunning = !!simStatus.value?.running
      simStatus.value = sim
      const nowRunning = !!sim.running
      const stepsDone = isSimStepsDone(sim)
      // 自行结束常不推 SIMULATION_ENDED：靠 running 下落或步数跑完回位（只在 wasRunning 边沿触发一次）
      if (wasRunning && (!nowRunning || stepsDone)) {
        if (stepsDone && simStatus.value) {
          simStatus.value = { ...simStatus.value, running: false }
        }
        await twin.clearFaultVisuals()
        if (twin.isHullCruiseActive()) {
          pushLog('联合仿真已结束，舰体回位')
          await stopHullCruiseAndReset()
        }
      }
    }
  } catch {
    /* ignore poll errors */
  }
}

function connectMockWs() {
  if (mockWs && (mockWs.readyState === WebSocket.OPEN || mockWs.readyState === WebSocket.CONNECTING)) {
    return
  }
  try {
    mockWs?.close()
  } catch {
    /* ignore */
  }
  mockWs = new WebSocket(wsUrl('/ws/mock'))
  mockWs.onopen = () => pushSendLog('Mock WS 已连接', 'info')
  mockWs.onclose = () => {
    mockWs = null
    if (!socketsWanted) return
    pushSendLog('Mock WS 断开（5 秒后重连）', 'error')
    setTimeout(() => {
      if (socketsWanted && !mockWs) connectMockWs()
    }, 5000)
  }
  mockWs.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      const body = msg.DATABODY || msg.databody || msg
      const phaseId = body.phaseId
      const depth = body.situation?.depth ?? tryParseDepth(body.situation)
      pose.value = {
        lat: body.latitude,
        lon: body.longitude,
        speed: body.speed,
        depth,
        phaseId,
      }
      let line = `任务阶段:${phaseId ?? '-'} 经度:${body.longitude ?? '-'} 纬度:${body.latitude ?? '-'} 航速:${body.speed ?? '-'}节 深度:${depth ?? '-'}`
      if (body.situation != null && typeof body.situation === 'object') {
        const sit = body.situation
        if (sit.situation != null) line += ` 态势:${sit.situation}`
      }
      pushSendLog(line, 'mock-data')
      if (phaseId && String(phaseId) !== String(sceneState.value.currentPhase)) {
        twin.applyPhase(phaseId)
      }
      // 仅联合仿真运行中推进；仿真结束后即使 Mock 还在推也不再动
      if (
        poseBoundForActiveHull.value &&
        twin.isHullCruiseActive() &&
        simStatus.value?.running &&
        !isSimStepsDone(simStatus.value)
      ) {
        twin.advanceHullCruise({ speed: body.speed })
      }
    } catch {
      /* ignore malformed */
    }
  }
}

/** 对齐 underwater-mock/mw/index.html：/mw/ws/results → 右侧故障栏 */
function connectResultsWs() {
  if (resultWs && (resultWs.readyState === WebSocket.OPEN || resultWs.readyState === WebSocket.CONNECTING)) {
    return
  }
  try {
    resultWs?.close()
  } catch {
    /* ignore */
  }
  resultWs = new WebSocket(wsUrl('/mw/ws/results'))
  resultWs.onopen = () => pushFault('结果实时流已连接（适用性模型哨兵 BID=3401）', 'info')
  resultWs.onerror = () => {
    /* onclose 负责重连 */
  }
  resultWs.onclose = () => {
    resultWs = null
    if (!socketsWanted) return
    pushFault('结果实时流断开（5 秒后重连）', 'error')
    setTimeout(() => {
      if (socketsWanted && !resultWs) connectResultsWs()
    }, 5000)
  }
  resultWs.onmessage = async (ev) => {
    try {
      const entry = JSON.parse(ev.data)
      const body = entry.databody || entry.DATABODY || {}
      const type = String(body.type || entry.type || '').toUpperCase()
      const header = `SID:${entry.sid ?? '-'} BID:${entry.bid ?? '-'}`

      if (type === 'FAULT_EVENT' || body.fault) {
        const fault = body.fault || {}
        const status = fault.status || '-'
        const eqName = fault.equipmentName || '-'
        const faultName = fault.faultName || '-'
        const repairableFlag = fault.repairable
        const repairable = repairableFlag ? '可维修' : '不可维修'
        const influence = fault.influence ? ` 影响:${fault.influence}` : ''
        if (status === 'FAULT_OCCUR') {
          pushFault(
            `[${header}] 故障发生: ${eqName} - ${faultName} (${repairable}) 时间:${body.timestamp ?? '-'}s${influence}`,
            'fault',
          )
        } else if (status === 'REPAIR_START') {
          pushFault(`[${header}] 开始维修: ${eqName} - ${faultName}`, 'info')
        } else if (status === 'REPAIR_END') {
          pushFault(`[${header}] 维修完成: ${eqName} - ${faultName}`, 'info')
        } else {
          pushFault(`[${header}] 故障事件: ${eqName} - ${faultName} 状态:${status}`, 'info')
        }
        await twin.highlightFault(eqName, status, {
          repairable: repairableFlag,
          faultName,
        })
      } else if (type === 'SIMULATION_START') {
        pushFault(`[${header}] 仿真开始 (simuId=${body.simuId || '-'})`, 'info')
        await twin.clearFaultVisuals()
      } else if (type.includes('SIMULATION_END')) {
        pushFault(
          `[${header}] 仿真结束 (reason=${body.reason || '-'}, totalSteps=${body.totalSteps || '-'}, simuId=${body.simuId || '-'})`,
          'ended',
        )
        pushLog('收到仿真结束事件，舰体回位')
        await twin.clearFaultVisuals()
        await stopHullCruiseAndReset()
      } else {
        pushFault(`[${header}] 未知类型: ${JSON.stringify(body)}`, 'info')
      }
    } catch {
      pushFault(`解析失败 原文: ${ev.data}`, 'error')
    }
  }
}

function connectSockets() {
  connectMockWs()
  connectResultsWs()
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
  clearErrMsg()
  try {
    await nextTick()
    if (!cloudEl.value) throw new Error('云渲染容器未就绪')
    if (!window.PiClientJS?.PiClient) {
      throw new Error('PiClientJS 未加载，请硬刷新页面（需 /cimpro/*.js）')
    }
    await twin.connect({
      mode: 'cloud',
      container: cloudEl.value,
      address: cloudAddress.value,
    })
    nextTick(() => focusCloudStream())
  } catch (e) {
    showErr(e.message)
    pushLog(e.message, 'error')
  } finally {
    busy.value = false
  }
}

async function onDisconnectCloud() {
  twin.destroy()
  pushLog('已断开云渲染', 'error')
}

async function onEnterPlayMode() {
  try {
    await twin.enterPlayMode()
    pushLog('已进入播放模式')
  } catch (e) {
    pushLog(e.message, 'error')
  }
}

function onReviveMouse() {
  const ok = twin.reviveMouseInput?.({ hard: true })
  pushLog(
    ok
      ? '已重绑鼠标并 Leave→Enter 复位（HoveringMouse：按住左键拖拽转视角）'
      : '恢复拖拽失败（未连接或无 pixelStreaming）',
    ok ? 'info' : 'warn',
  )
  nextTick(() => focusCloudStream())
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
  // 映射弹窗打开时不要抢焦点，否则 ObjectId 输入框里 Shift+字母会被云渲染侧吃掉
  if (mapModal.value.open) return
  const ae = document.activeElement
  if (
    ae &&
    (ae.tagName === 'INPUT' ||
      ae.tagName === 'TEXTAREA' ||
      ae.tagName === 'SELECT' ||
      ae.isContentEditable)
  ) {
    return
  }
  const root = cloudEl.value
  if (!root) return
  root.focus?.({ preventScroll: true })
  const video = root.querySelector?.('video')
  video?.focus?.({ preventScroll: true })
  // 部分 PixelStreaming 实现挂在 video 上收指针，点一下确保命中
  video?.setAttribute?.('tabindex', '0')
  // Leave→Enter 复位（光标已在画面内时浏览器不会再进 mouseenter）
  twin.reviveMouseInput?.()
}

function markMappingDirty() {
  mappingDirty.value = true
}

function persistMappingRows({ lockAll = false } = {}) {
  const lockedByKey = new Map(
    mappingRows.value.map((r) => [
      `${r.equipmentId}|${r.equipmentName}|${r.objectId}`,
      lockAll ? true : r.locked !== false,
    ]),
  )
  const saved = saveEquipments(mappingRows.value)
  mappingRows.value = saved.map((r) => ({
    ...r,
    locked: lockedByKey.get(`${r.equipmentId}|${r.equipmentName}|${r.objectId}`) !== false,
  }))
  mappingDirty.value = false
  return saved
}

function resetMapping() {
  mappingRows.value = resetEquipmentsToDefaults().map((r) => ({ ...r, locked: true }))
  mappingDirty.value = false
  pushLog('已清空映射表')
}

function removeMappingRow(index) {
  mappingRows.value.splice(index, 1)
  markMappingDirty()
}

function startEditRow(row) {
  row.locked = false
}

function finishEditRow(row) {
  row.locked = true
  persistMappingRows()
  pushLog(
    `已更新映射：${row.equipmentName || row.equipmentId} → ObjectId=${row.objectId || '（空）'}`,
  )
}

async function focusByObjectId(row) {
  const objectId = String(row.objectId || '').trim()
  if (!objectId) {
    pushLog('请先绑定孪生 ObjectId', 'warn')
    return
  }
  try {
    await twin.flyToObjectId(objectId)
    pushLog(`聚焦 ObjectId=${objectId}（设备 ${row.equipmentName || row.equipmentId || '-'}）`)
  } catch (e) {
    pushLog(e.message, 'error')
  } finally {
    nextTick(() => focusCloudStream())
  }
}

async function resolveEquipTreeId() {
  if (selectedSimuId.value) {
    try {
      const detail = await simApi.getPlan(selectedSimuId.value)
      if (detail?.treeId != null) return Number(detail.treeId)
    } catch {
      /* 回退默认树 */
    }
  }
  return DEFAULT_EQUIP_TREE_ID
}

async function openAddMappingModal() {
  mapModal.value = {
    open: true,
    step: 'tree',
    loading: true,
    error: '',
    treeId: null,
    treeName: '',
    flatNodes: [],
    selectedNode: null,
    objectIdDraft: '',
    idManual: false,
  }
  try {
    const treeId = await resolveEquipTreeId()
    const data = await simApi.getEquipDetail(treeId)
    const eq = data?.equipment || {}
    mapModal.value.treeId = eq.id ?? treeId
    mapModal.value.treeName = eq.name || `装备树 ${treeId}`
    mapModal.value.flatNodes = flattenEquipTree(data?.structureTree || [])
    if (!mapModal.value.flatNodes.length) {
      mapModal.value.error = '装备结构树为空'
    }
  } catch (e) {
    mapModal.value.error = e.message || String(e)
  } finally {
    mapModal.value.loading = false
  }
  void twin.refreshSceneObjects?.().then((list) => {
    if (list) sceneObjects.value = list
  })
}

function closeMapModal() {
  mapModal.value.open = false
}

function selectEquipNode(node) {
  mapModal.value.selectedNode = node
}

function confirmEquipNode() {
  const node = mapModal.value.selectedNode
  if (!node) {
    pushLog('请先在装备树中选择一个设备', 'warn')
    return
  }
  mapModal.value.step = 'bind'
  mapModal.value.objectIdDraft = ''
  mapModal.value.idManual = sceneObjectIdOptions.value.length === 0
}

function backToTreeStep() {
  mapModal.value.step = 'tree'
}

function confirmMappingBind() {
  const node = mapModal.value.selectedNode
  if (!node) return
  const objectId = String(mapModal.value.objectIdDraft || '').trim()
  if (!objectId) {
    pushLog('请选择或填写孪生 ObjectId', 'warn')
    return
  }
  const existsIdx = mappingRows.value.findIndex(
    (r) =>
      (node.id != null && String(r.equipmentId) === String(node.id)) ||
      (r.equipmentName && r.equipmentName === node.deviceName),
  )
  const row = {
    equipmentId: node.id != null ? String(node.id) : String(node.deviceCode || ''),
    equipmentName: node.deviceName || '',
    objectId,
    tag: '',
    aliases: node.deviceName ? [node.deviceName, node.deviceName.replace(/-$/, '')] : [],
    locked: true,
  }
  if (existsIdx >= 0) {
    mappingRows.value[existsIdx] = row
  } else {
    mappingRows.value.push(row)
  }
  persistMappingRows({ lockAll: false })
  const last = mappingRows.value.find(
    (r) => r.equipmentName === row.equipmentName && r.objectId === row.objectId,
  )
  if (last) last.locked = true
  pushLog(`映射已建立：${row.equipmentName} → ObjectId=${row.objectId}`)
  closeMapModal()
}

async function refreshSceneObjectOptions() {
  try {
    const list = await twin.refreshSceneObjects()
    sceneObjects.value = list || []
    if (!sceneObjectIdOptions.value.length) {
      mapModal.value.idManual = true
      pushLog('未枚举到场景 ObjectId，请手填（或在画面点选对象后再刷新）', 'warn')
    } else {
      mapModal.value.idManual = false
      pushLog(`已刷新场景对象 ${sceneObjectIdOptions.value.length} 个`)
    }
  } catch (e) {
    mapModal.value.idManual = true
    pushLog(e.message, 'error')
  }
}

function markHullDirty() {
  hullDirty.value = true
}

function persistHullRows() {
  const lockedByKey = new Map(
    hullRows.value.map((h) => [`${h.id}|${h.label}|${h.tag}`, h.locked !== false]),
  )
  const saved = saveHulls(hullRows.value)
  hullRows.value = saved.map((h) => ({
    ...h,
    locked: lockedByKey.get(`${h.id}|${h.label}|${h.tag}`) !== false,
  }))
  hullDirty.value = false
  return saved
}

function resetHullMapping() {
  if (simRunning.value) return
  hullRows.value = resetHullsToDefaults().map((h) => ({ ...h, locked: true }))
  activeHullId.value = getActiveHullId()
  hullDirty.value = false
  pushLog('已恢复默认舰体（051C型驱逐舰 / 小绿）')
}

function addHullRow() {
  if (simRunning.value) return
  hullRows.value.push({
    id: '',
    label: '',
    objectId: '',
    tag: '',
    aliases: [],
    locked: false,
  })
  markHullDirty()
}

function removeHullRow(index) {
  if (simRunning.value) return
  const row = hullRows.value[index]
  hullRows.value.splice(index, 1)
  markHullDirty()
  if (row?.id && row.id === activeHullId.value) {
    activeHullId.value = hullRows.value[0]?.id || ''
  }
}

function startEditHull(row) {
  if (simRunning.value) return
  row.locked = false
}

function onHullRowClick(row) {
  if (simRunning.value || !row?.locked || !row.objectId || switchingHull.value) return
  void onSelectHull(row)
}

function finishEditHull(row) {
  if (!String(row.label || '').trim() && !String(row.objectId || '').trim()) {
    pushLog('舰体名称与 ObjectId 不能都为空', 'warn')
    return
  }
  if (!row.id) row.id = String(row.objectId || row.label).trim()
  row.locked = true
  persistHullRows()
  pushLog(`已更新舰体：${row.label} → ObjectId=${row.objectId || '（空）'}`)
}

async function onSelectHull(hull) {
  if (switchingHull.value || simRunning.value) return
  if (!hull.objectId) {
    pushLog('请先填写引擎 ObjectId（如 SceneMeshObject_0）', 'warn')
    return
  }
  if (hullDirty.value || !hull.locked) {
    persistHullRows()
  }
  const key = hull.id || hull.objectId
  const nextObjectId = String(hull.objectId || '').trim()
  if (key === activeHullId.value) {
    void twin.selectActiveHull(key, { fly: true })
    return
  }
  // 换艇：保留各艇「已应用」状态；仅结束当前巡航，切到已应用艇且仿真中则接上
  if (twin.isHullCruiseActive()) {
    await stopHullCruiseAndReset()
  }
  switchingHull.value = true
  activeHullId.value = key
  pushLog(`切换舰体 → ${hull.label || key} (ObjectId=${hull.objectId})`)
  try {
    await twin.selectActiveHull(key, { fly: true })
    // 仅联合仿真运行中才接巡航；Mock 启停不影响舰体运动
    if (
      nextObjectId &&
      poseBoundObjectIds.value.includes(nextObjectId) &&
      simStatus.value?.running
    ) {
      await startHullCruiseIfBound()
    }
  } catch (e) {
    pushLog(e.message, 'error')
  } finally {
    switchingHull.value = false
    nextTick(() => focusCloudStream())
  }
}

async function startHullCruiseIfBound() {
  if (!poseBoundForActiveHull.value) return false
  if (!sceneState.value.connected) {
    pushLog('云渲染未连接，无法启动舰体巡航', 'warn')
    return false
  }
  const objectId = activeHullObjectId.value
  if (!objectId) {
    pushLog('当前舰体未配置 ObjectId，无法巡航', 'warn')
    return false
  }
  try {
    const info = await twin.beginHullCruise(objectId, { moveTime: 1 })
    pushLog(
      `舰体巡航已启动 ObjectId=${objectId} 模式=${info.mode}（步距由态势航速决定，约 1s 平滑）`,
    )
    return true
  } catch (e) {
    pushLog(e.message || String(e), 'error')
    return false
  }
}

async function stopHullCruiseAndReset() {
  if (!twin.isHullCruiseActive()) return
  try {
    const ok = await twin.endHullCruise()
    pushLog(ok ? '舰体已瞬移回启动仿真时的位置' : '舰体复位未执行（无巡航快照）', ok ? 'info' : 'warn')
  } catch (e) {
    pushLog(e.message || String(e), 'error')
  }
}

async function onApplyPoseBinding() {
  if (simRunning.value || poseBoundForActiveHull.value) return
  const objectId = activeHullObjectId.value
  if (!objectId) {
    pushLog('请先选中并填写当前舰体 ObjectId', 'warn')
    return
  }
  if (!sceneState.value.connected) {
    pushLog('请先连接云渲染', 'warn')
    return
  }
  if (!poseBoundObjectIds.value.includes(objectId)) {
    poseBoundObjectIds.value = [...poseBoundObjectIds.value, objectId]
  }
  pushLog(`应用航行态势成功：联合仿真运行时 ${objectId} 将沿 +X 平滑移动`)
  if (simStatus.value?.running) {
    await startHullCruiseIfBound()
  }
}

async function startMock() {
  busy.value = true
  clearErrMsg()
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
    pushLog('Mock 已启动（不影响舰体巡航）')
    await refreshStatus()
  } catch (e) {
    showErr(e.message)
  } finally {
    busy.value = false
  }
}

async function stopMock() {
  busy.value = true
  try {
    await simApi.mockStop()
    pushLog('Mock 已停止（不影响舰体巡航）')
    await refreshStatus()
  } catch (e) {
    showErr(e.message)
  } finally {
    busy.value = false
  }
}

async function startJoint() {
  if (!hasPoseBinding.value) {
    showErr('请先为至少一艘舰应用航行态势')
    return
  }
  busy.value = true
  clearErrMsg()
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
    await startHullCruiseIfBound()
  } catch (e) {
    showErr(e.message)
  } finally {
    busy.value = false
  }
}

async function stopJoint() {
  busy.value = true
  try {
    // 先瞬移回位+镜头，再等停仿真 API（避免停仿真接口拖慢视觉复位）
    await stopHullCruiseAndReset()
    await simApi.stopSim({ simuId: selectedSimuId.value })
    pushLog('联合仿真已停止')
    await refreshStatus()
  } catch (e) {
    showErr(e.message)
  } finally {
    busy.value = false
  }
}

function openApiModal() {
  apiModal.value.open = true
}

function closeApiModal() {
  apiModal.value.open = false
}

/** 解析 piclient.emit / emit / JSON 调用语句 */
function parseApiStatement(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('请输入调用语句')

  if (raw.startsWith('{')) {
    const obj = JSON.parse(raw)
    const action = obj.action || obj.event || obj.name
    if (!action) throw new Error('JSON 需包含 action（或 event/name）字段')
    return { action: String(action), param: obj.param ?? obj.params ?? obj.data ?? {} }
  }

  const emitMatch = raw.match(
    /^(?:piclient\.)?emit\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([\s\S]*))?\s*\)\s*;?\s*$/i,
  )
  if (emitMatch) {
    const action = emitMatch[1]
    const paramSrc = (emitMatch[2] || '').trim()
    let param = {}
    if (paramSrc && paramSrc !== 'undefined' && paramSrc !== 'null') {
      param = new Function(`"use strict"; return (${paramSrc})`)()
    }
    return { action, param: param && typeof param === 'object' ? param : {} }
  }

  const nl = raw.indexOf('\n')
  if (nl > 0) {
    const action = raw.slice(0, nl).trim()
    const rest = raw.slice(nl + 1).trim() || '{}'
    if (!/^[\w./-]+$/.test(action)) throw new Error(`无法识别事件名：${action}`)
    return { action, param: JSON.parse(rest) }
  }

  if (/^[\w./-]+$/.test(raw)) return { action: raw, param: {} }

  throw new Error(
    '无法解析。示例：\npiclient.emit("object.move", { target: "SceneMeshObject_0", geo: "120,35,0" })',
  )
}

function startApiCooldown(sec = 5) {
  if (apiCooldownTimer) {
    clearInterval(apiCooldownTimer)
    apiCooldownTimer = null
  }
  apiCooldownSec.value = sec
  apiCooldownTimer = setInterval(() => {
    apiCooldownSec.value -= 1
    if (apiCooldownSec.value <= 0) {
      apiCooldownSec.value = 0
      clearInterval(apiCooldownTimer)
      apiCooldownTimer = null
    }
  }, 1000)
}

function appendApiOutput(line) {
  const stamp = new Date().toLocaleTimeString()
  const prev = apiModal.value.output ? `${apiModal.value.output}\n` : ''
  apiModal.value.output = `${prev}[${stamp}] ${line}`
}

async function runApiStatement() {
  if (apiModal.value.running || apiCooldownSec.value > 0) return
  apiModal.value.running = true
  startApiCooldown(5)
  try {
    const { action, param } = parseApiStatement(apiModal.value.input)
    appendApiOutput(`执行 → ${action} ${JSON.stringify(param)}`)
    if (!sceneState.value.connected) {
      throw new Error('云渲染未连接，无法执行')
    }
    const res = await twin.emit(action, param)
    appendApiOutput(`成功 ← ${res == null ? '(无返回体)' : JSON.stringify(res)}`)
  } catch (e) {
    appendApiOutput(`失败 ← ${e?.message || e}`)
  } finally {
    apiModal.value.running = false
  }
}

onMounted(async () => {
  socketsWanted = true
  await refreshMeta()
  await refreshStatus()
  connectSockets()
  // 仿真运行中加快轮询，便于自行结束后及时回位
  pollTimer = setInterval(() => {
    void refreshStatus()
  }, 2000)
  // 默认云渲染：容器就绪后自动连接
  await onConnectTwin()
})

onUnmounted(() => {
  socketsWanted = false
  clearInterval(pollTimer)
  if (apiCooldownTimer) clearInterval(apiCooldownTimer)
  if (errMsgTimer) clearTimeout(errMsgTimer)
  mockWs?.close()
  resultWs?.close()
  twin.destroy()
})
</script>

<template>
  <div class="page">
    <header class="header">
      <div>
        <h1>适用性仿真模型</h1>
        <p class="sub">云渲染场景 · underwater-mock 仿真链路</p>
      </div>
      <div class="status-chips">
        <span class="chip" :class="{ on: sceneState.connected }">
          云渲染 {{ sceneState.connected ? '已连' : '未连' }}
        </span>
        <span class="chip" :class="{ on: mockStatus?.running }">Mock {{ mockStatus?.running ? '运行' : '停止' }}</span>
        <span class="chip" :class="{ on: simStatus?.running }">联合仿真 {{ simStatus?.running ? '运行' : '停止' }}</span>
        <span class="chip" :class="{ on: sentinel?.ddsConnected || sentinel?.sentinelOn }">
          Sentinel {{ sentinel?.ddsConnected || sentinel?.sentinelOn ? '就绪' : '未连' }}
        </span>
      </div>
    </header>

    <p v-if="errMsg" class="error-banner" role="alert">{{ errMsg }}</p>

    <section class="panel controls">
      <div class="row">
        <label>试验方案</label>
        <select v-model="selectedSimuId">
          <option v-for="p in plans" :key="p.simuId" :value="String(p.simuId)">
            {{ p.simuName || p.name || p.simuId }}
          </option>
        </select>
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
        <button
          type="button"
          class="primary"
          :disabled="busy || !selectedSimuId || !hasPoseBinding || simRunning"
          :title="!hasPoseBinding ? '请先为舰体应用航行态势' : ''"
          @click="startJoint"
        >
          启动联合仿真
        </button>
        <button type="button" class="danger" :disabled="busy || !simRunning" @click="stopJoint">
          停止联合仿真
        </button>
        <button type="button" class="clear-btn" @click="clearAllLogs">清除所有日志</button>
      </div>
    </section>

    <div class="stage">
      <!-- 左侧：态势 + 舰体 + 天气（底边与中间云渲染齐平） -->
      <aside class="side-col side-col-left">
        <section class="panel side-panel">
          <h3>航行态势</h3>
          <div class="pose">
            <div>经度 {{ pose.lon ?? '-' }}</div>
            <div>纬度 {{ pose.lat ?? '-' }}</div>
            <div>航速 {{ pose.speed ?? '-' }}</div>
            <div>深度 {{ pose.depth ?? '-' }}</div>
            <div>phaseId {{ pose.phaseId ?? '-' }}</div>
            <div>步数 {{ simStatus?.currentStep ?? '-' }} / {{ simStatus?.totalSteps ?? '-' }}</div>
          </div>
        </section>

        <section class="panel side-panel" :class="{ 'panel-locked': simRunning }">
          <h3>
            场景舰体{{ hullDirty ? '（未保存）' : ''
            }}{{ simRunning ? '（仿真中锁定）' : '' }}
          </h3>
          <p class="hint">
            暂用 ObjectId 切换 · 点整行聚焦 · 当前 {{ activeHullLabel
            }}{{ switchingHull ? '（切换中…）' : '' }}
            · 航行态势：沿 +X 平滑移动（步距跟态势航速），停止后回到启动时位置
          </p>
          <fieldset class="hull-fieldset" :disabled="simRunning">
            <div class="map-table-wrap side-scroll hull-table-wrap">
              <table class="map-table compact hull-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>ObjectId</th>
                    <th style="width: 4.8rem"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(row, idx) in hullRows"
                    :key="row.id || idx"
                    :class="{
                      'row-editing': !row.locked,
                      'row-active-hull': row.id === activeHullId || row.objectId === activeHullId,
                      'hull-row-clickable': !simRunning && row.locked && !!row.objectId,
                    }"
                    @click="onHullRowClick(row)"
                  >
                    <td>
                      <span v-if="row.locked" class="hull-cell-text">{{ row.label || '—' }}</span>
                      <input
                        v-else
                        v-model="row.label"
                        class="map-input flat"
                        placeholder="名称"
                        @input="markHullDirty"
                      />
                    </td>
                    <td>
                      <span v-if="row.locked" class="hull-cell-text mono">{{ row.objectId || '—' }}</span>
                      <input
                        v-else
                        v-model="row.objectId"
                        class="map-input mono flat"
                        placeholder="SceneMeshObject_0"
                        @input="markHullDirty"
                      />
                    </td>
                    <td class="map-actions map-actions-inline" @click.stop>
                      <button
                        v-if="row.locked"
                        type="button"
                        class="ghost btn-mini"
                        @click="startEditHull(row)"
                      >
                        编辑
                      </button>
                      <button v-else type="button" class="primary btn-mini" @click="finishEditHull(row)">
                        完成
                      </button>
                      <button type="button" class="danger btn-mini" @click="removeHullRow(idx)">删</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="row buttons">
              <button
                type="button"
                class="primary"
                :disabled="simRunning || poseBoundForActiveHull || !sceneState.connected"
                @click="onApplyPoseBinding"
              >
                {{ poseBoundForActiveHull ? '已应用航行态势' : '应用航行态势' }}
              </button>
              <button type="button" class="primary" :disabled="simRunning" @click="addHullRow">
                添加
              </button>
              <button type="button" :disabled="simRunning" @click="resetHullMapping">默认</button>
            </div>
          </fieldset>
        </section>

        <section class="panel side-panel weather-panel">
          <h3>天气</h3>
          <div class="row">
            <select
              v-model.number="weatherLevel"
              :disabled="!sceneState.connected"
              class="weather-select"
            >
              <option v-for="w in weatherOptions" :key="w.value" :value="w.value">
                {{ w.value }} · {{ w.label }}
              </option>
            </select>
            <button
              type="button"
              class="primary"
              :disabled="!sceneState.connected"
              @click="onApplyWeather()"
            >
              应用
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
        </section>
      </aside>

      <!-- 中间：云渲染 -->
      <section class="panel stream-panel">
        <div class="row stream-toolbar">
          <h3>云渲染画面</h3>
          <div class="stream-actions">
            <span class="hint" :class="{ on: sceneState.connected }">
              {{ sceneState.connected ? '已连接' : '未连接' }} · {{ cloudAddress }}
            </span>
            <button type="button" class="ghost" @click="openApiModal">API 调试</button>
            <button type="button" class="ghost" :disabled="busy" @click="onConnectTwin">重连</button>
            <button
              type="button"
              class="ghost"
              :disabled="!sceneState.connected"
              @click="onEnterPlayMode"
            >
              播放模式
            </button>
            <button
              type="button"
              class="ghost"
              :disabled="!sceneState.connected"
              title="鼠标拖拽失效时点此重绑输入"
              @click="onReviveMouse"
            >
              恢复拖拽
            </button>
            <button type="button" class="danger" :disabled="busy" @click="onDisconnectCloud">断开</button>
          </div>
        </div>
        <div
          class="pixel-shell"
          title="HoveringMouse：按住左键拖画面转视角。失效时点画面或「恢复拖拽」。勿同时开 player.html 抢输入权。"
        >
          <div
            ref="cloudEl"
            id="renderContainer"
            class="cloud-box active"
            tabindex="0"
            @pointerdown.capture="focusCloudStream"
            @pointerenter="focusCloudStream"
          />
        </div>
      </section>

      <!-- 右侧：设备映射（底边与云渲染齐平） -->
      <aside class="side-col side-col-right">
        <section class="panel side-panel grow-panel">
          <h3>设备 ↔ ObjectId{{ mappingDirty ? '（未保存）' : '' }}</h3>
          <p class="hint">从装备树添加；故障高亮走 ObjectId</p>
          <div class="map-table-wrap side-scroll tall hull-table-wrap">
            <table class="map-table compact hull-table">
              <thead>
                <tr>
                  <th>设备</th>
                  <th>ObjectId</th>
                  <th style="width: 5.5rem"></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, idx) in mappingRows"
                  :key="idx"
                  :class="{ 'row-editing': !row.locked }"
                >
                  <td>
                    <template v-if="row.locked">
                      <span class="hull-cell-text">{{ row.equipmentName || '—' }}</span>
                      <span class="hull-cell-text mono tiny-id">{{ row.equipmentId || '' }}</span>
                    </template>
                    <div v-else class="eq-cell">
                      <input
                        v-model="row.equipmentName"
                        class="map-input flat"
                        placeholder="设备名"
                        @input="markMappingDirty"
                      />
                      <input
                        v-model="row.equipmentId"
                        class="map-input mono flat tiny"
                        placeholder="仿真ID"
                        @input="markMappingDirty"
                      />
                    </div>
                  </td>
                  <td>
                    <span v-if="row.locked" class="hull-cell-text mono">{{ row.objectId || '—' }}</span>
                    <input
                      v-else
                      v-model="row.objectId"
                      class="map-input mono flat"
                      placeholder="SceneMeshObject_…"
                      @input="markMappingDirty"
                    />
                  </td>
                  <td class="map-actions map-actions-inline">
                    <button
                      type="button"
                      class="ghost btn-mini"
                      :disabled="!row.objectId"
                      @click="focusByObjectId(row)"
                    >
                      聚焦
                    </button>
                    <button
                      v-if="row.locked"
                      type="button"
                      class="ghost btn-mini"
                      @click="startEditRow(row)"
                    >
                      编辑
                    </button>
                    <button v-else type="button" class="primary btn-mini" @click="finishEditRow(row)">
                      完成
                    </button>
                    <button type="button" class="danger btn-mini" @click="removeMappingRow(idx)">
                      删
                    </button>
                  </td>
                </tr>
                <tr v-if="!mappingRows.length">
                  <td colspan="3" class="hint" style="padding: 12px">暂无映射</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="row buttons">
            <button type="button" class="primary" @click="openAddMappingModal">添加映射</button>
            <button type="button" @click="resetMapping">清空</button>
          </div>
        </section>
      </aside>
    </div>

    <!-- 底部：对齐水下模拟系统两栏日志 -->
    <div class="bottom-panels">
      <section class="panel log-panel">
        <h3>📡 Mock 推送给数据分发服务（DDS）的态势数据</h3>
        <div ref="sendLogEl" class="log log-tall">
          <div v-if="!sendLogs.length" class="hint">等待数据...</div>
          <div v-for="(l, i) in sendLogs" :key="i" :class="l.level">[{{ l.at }}] {{ l.msg }}</div>
        </div>
      </section>
      <section class="panel log-panel">
        <h3>🔄 数据分发服务回传的故障信息（水下系统收到的）</h3>
        <div ref="faultLogEl" class="log log-tall">
          <div v-if="!faultLogs.length" class="hint">等待数据...</div>
          <div v-for="(l, i) in faultLogs" :key="i" :class="l.level || 'fault'">
            [{{ l.at }}] {{ l.msg }}
          </div>
        </div>
      </section>
    </div>

    <!-- API 调试弹窗 -->
    <div v-if="apiModal.open" class="modal-mask" @click.self="closeApiModal">
      <div class="modal-card api-modal-card" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h3>API 调试</h3>
          <button type="button" class="ghost modal-close" @click="closeApiModal">关闭</button>
        </header>
        <p class="hint">
          支持
          <code>piclient.emit("事件名", &#123; ... &#125;)</code>
          、首行事件名+下行 JSON、或
          <code>&#123; "action": "...", "param": &#123;&#125; &#125;</code>
        </p>
        <div class="api-console">
          <div class="api-pane">
            <div class="api-pane-title">调用语句</div>
            <textarea
              v-model="apiModal.input"
              class="api-textarea"
              spellcheck="false"
              placeholder='piclient.emit("事件名", { 参数名: "参数值" })'
            />
          </div>
          <div class="api-pane">
            <div class="api-pane-title">执行结果</div>
            <pre class="api-output">{{ apiModal.output || '等待执行…' }}</pre>
          </div>
        </div>
        <footer class="modal-foot">
          <button type="button" class="ghost" @click="apiModal.output = ''">清空结果</button>
          <button
            type="button"
            class="primary"
            :disabled="apiModal.running || apiCooldownSec > 0 || !String(apiModal.input || '').trim()"
            @click="runApiStatement"
          >
            <template v-if="apiCooldownSec > 0">执行（{{ apiCooldownSec }}s）</template>
            <template v-else-if="apiModal.running">执行中…</template>
            <template v-else>执行</template>
          </button>
        </footer>
      </div>
    </div>

    <!-- 添加映射弹窗 -->
    <div v-if="mapModal.open" class="modal-mask" @click.self="closeMapModal">
      <div class="modal-card" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h3 v-if="mapModal.step === 'tree'">选择仿真设备</h3>
          <h3 v-else>绑定孪生 ObjectId</h3>
          <button type="button" class="ghost modal-close" @click="closeMapModal">关闭</button>
        </header>

        <template v-if="mapModal.step === 'tree'">
          <p class="hint">
            {{ mapModal.treeName || '装备结构树' }}
            <span v-if="mapModal.treeId">（ID {{ mapModal.treeId }}）</span>
            · 点击节点后「确定」
          </p>
          <div v-if="mapModal.loading" class="modal-body hint">加载装备树中…</div>
          <div v-else-if="mapModal.error" class="modal-body error-text">{{ mapModal.error }}</div>
          <div v-else class="equip-tree">
            <button
              v-for="node in mapModal.flatNodes"
              :key="node.id"
              type="button"
              class="equip-tree-node"
              :class="{
                selected: mapModal.selectedNode?.id === node.id,
                branch: node.hasChildren,
              }"
              :style="{ paddingLeft: 12 + node.depth * 16 + 'px' }"
              @click="selectEquipNode(node)"
            >
              <span class="equip-tree-name">{{ node.deviceName || '-' }}</span>
              <span class="equip-tree-code">{{ node.deviceCode || '' }}</span>
            </button>
          </div>
          <footer class="modal-foot">
            <button type="button" class="ghost" @click="closeMapModal">取消</button>
            <button
              type="button"
              class="primary"
              :disabled="!mapModal.selectedNode"
              @click="confirmEquipNode"
            >
              确定
            </button>
          </footer>
        </template>

        <template v-else>
          <div class="modal-body tag-step">
            <div class="kv-line">
              <span class="k">已选设备</span>
              <span class="v">
                {{ mapModal.selectedNode?.deviceName || '-' }}
                <span class="mono">
                  {{ mapModal.selectedNode?.deviceCode ? `(${mapModal.selectedNode.deviceCode})` : '' }}
                </span>
              </span>
            </div>
            <div class="kv-line">
              <span class="k">ObjectId</span>
              <div class="tag-pick">
                <template v-if="!mapModal.idManual && sceneObjectIdOptions.length">
                  <select v-model="mapModal.objectIdDraft" class="map-input mono grow">
                    <option value="">请选择（名称 + ObjectId）</option>
                    <option
                      v-for="o in sceneObjectIdOptions"
                      :key="o.objectId"
                      :value="o.objectId"
                    >
                      {{ o.name }} ({{ o.objectId }})
                    </option>
                  </select>
                  <button type="button" class="ghost" @click="mapModal.idManual = true">改手填</button>
                </template>
                <template v-else>
                  <input
                    v-model="mapModal.objectIdDraft"
                    class="map-input mono grow"
                    placeholder="如 SceneMeshObject_2"
                  />
                  <button
                    v-if="sceneObjectIdOptions.length"
                    type="button"
                    class="ghost"
                    @click="mapModal.idManual = false"
                  >
                    改下拉
                  </button>
                </template>
                <button type="button" class="ghost" @click="refreshSceneObjectOptions">刷新对象</button>
              </div>
            </div>
            <p class="hint">
              暂用引擎 ObjectId。可在云渲染画面点选对象后「刷新对象」，或直接手填。
            </p>
          </div>
          <footer class="modal-foot">
            <button type="button" class="ghost" @click="backToTreeStep">返回</button>
            <button
              type="button"
              class="primary"
              :disabled="!String(mapModal.objectIdDraft || '').trim()"
              @click="confirmMappingBind"
            >
              确认建立映射
            </button>
          </footer>
        </template>
      </div>
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
  margin-bottom: 12px;
}
.hull-fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.panel-locked {
  opacity: 0.55;
  filter: grayscale(0.25);
}
.panel-locked .hull-fieldset {
  pointer-events: none;
  user-select: none;
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
  min-width: 0;
}
.controls select {
  min-width: 220px;
}
input.grow {
  flex: 1;
  min-width: 180px;
}
.side-panel select,
.side-panel input {
  min-width: 0;
  width: 100%;
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
button.clear-btn {
  background: #c67a1a;
}
/* 三列等高：行高取最高列；中间画面设最小高度，避免 flex 塌成一条缝像「空白」 */
.stage {
  display: grid;
  grid-template-columns: minmax(240px, 0.9fr) minmax(400px, 1.8fr) minmax(260px, 1fr);
  gap: 12px;
  align-items: stretch;
  margin-bottom: 12px;
}
.side-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.side-col-left .weather-panel {
  margin-top: auto;
  flex-shrink: 0;
}
.side-panel {
  margin-bottom: 0;
}
.grow-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.stream-panel {
  box-sizing: border-box;
  margin-bottom: 0;
  min-width: 0;
  /* 关键：不要用 height:100% + flex:1 把画面压到 0 */
  min-height: min(52vh, 560px);
  height: 100%;
  padding: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
}
.stream-toolbar {
  justify-content: space-between;
  margin-bottom: 8px;
  flex-shrink: 0;
}
.stream-toolbar h3 {
  margin: 0;
  font-size: 14px;
  color: #9ec5e8;
  border: none;
  padding: 0;
}
.stream-toolbar .hint.on {
  color: #9be7b8;
}
.stream-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.weather-select {
  min-width: 140px;
}
.weather-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
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
.bottom-panels {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.log-panel {
  flex: 1;
  min-width: 280px;
  margin-bottom: 0;
  display: flex;
  flex-direction: column;
}
.side-scroll {
  max-height: 160px;
  overflow: auto;
}
.side-scroll.tall {
  flex: 1;
  max-height: none;
  min-height: 0;
  overflow: auto;
}
.eq-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.map-input.tiny {
  font-size: 11px;
  padding: 3px 6px;
  opacity: 0.85;
}
.map-table.compact th,
.map-table.compact td {
  padding: 6px 8px;
}
@media (max-width: 960px) {
  .stage {
    grid-template-columns: 1fr;
  }
  .stream-panel {
    height: auto;
    min-height: min(48vh, 480px);
  }
  .grow-panel {
    min-height: auto;
  }
}
.map-table-wrap {
  overflow: auto;
  margin: 8px 0 10px;
  border: 1px solid #2a3b55;
  border-radius: 8px;
}
.map-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.map-table th,
.map-table td {
  padding: 8px 10px;
  border-bottom: 1px solid #2a3b55;
  text-align: left;
  vertical-align: middle;
}
.map-table th {
  background: #121a28;
  color: #9ec5e8;
  font-weight: 600;
}
.map-input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  background: #0f1724;
  border: 1px solid #3a4f6a;
  color: #e8eef7;
  border-radius: 6px;
  padding: 6px 8px;
}
.map-input.mono {
  font-family: ui-monospace, Consolas, monospace;
}
.map-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.map-actions-inline {
  flex-wrap: nowrap;
  gap: 4px;
  align-items: center;
}
.btn-mini {
  padding: 3px 7px;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
}
.map-input:disabled {
  opacity: 0.85;
  color: #c5d3e4;
  border-color: #2a3b55;
  cursor: default;
}
.map-input-gap {
  margin-top: 6px;
}
.row-editing td {
  background: #152033;
}
.row-active-hull td:first-child {
  box-shadow: inset 3px 0 0 #4ea1ff;
}
.hull-row-clickable {
  cursor: pointer;
}
.hull-row-clickable:hover td {
  background: #15304a;
}
.hull-table-wrap {
  border: none;
  background: transparent;
}
.hull-table th {
  background: transparent;
  border-bottom: 1px solid #2a3b55;
  padding: 4px 6px;
  font-size: 12px;
  font-weight: 500;
  color: #7f93ab;
}
.hull-table td {
  padding: 5px 6px;
  border-bottom: 1px solid #1c2838;
  vertical-align: middle;
}
.hull-table .map-actions-inline {
  justify-content: flex-end;
}
.hull-cell-text {
  display: block;
  font-size: 13px;
  color: #d7e6f7;
  line-height: 1.35;
  word-break: break-all;
}
.hull-cell-text.mono {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: #9bb0c7;
}
.hull-cell-text.tiny-id {
  font-size: 11px;
  color: #6a7f96;
  margin-top: 2px;
}
.map-input.flat {
  background: transparent;
  border: 1px solid #3a4f6a;
  border-radius: 4px;
  padding: 3px 6px;
  min-width: 0;
  width: 100%;
}
.mono {
  font-family: ui-monospace, Consolas, monospace;
}
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(6, 12, 22, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.modal-card {
  width: min(640px, 100%);
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  background: #121a28;
  border: 1px solid #35506a;
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid #2a3b55;
}
.modal-head h3 {
  margin: 0;
  font-size: 15px;
  color: #9ec5e8;
  border: none;
  padding: 0;
}
.modal-close {
  padding: 4px 10px;
}
.modal-card > .hint {
  padding: 8px 16px 0;
  margin: 0;
}
.modal-body {
  padding: 12px 16px;
  overflow: auto;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #2a3b55;
}
.api-modal-card {
  width: min(960px, 100%);
  max-height: min(85vh, 820px);
}
.api-console {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 0 16px 12px;
  min-height: 320px;
  flex: 1;
  overflow: hidden;
}
.api-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid #2a3b55;
  border-radius: 8px;
  overflow: hidden;
  background: #0c1420;
}
.api-pane-title {
  padding: 8px 10px;
  font-size: 12px;
  color: #9bb0c7;
  border-bottom: 1px solid #2a3b55;
  background: #152033;
}
.api-textarea,
.api-output {
  flex: 1;
  margin: 0;
  padding: 10px 12px;
  border: none;
  resize: none;
  outline: none;
  background: transparent;
  color: #e8eef7;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  min-height: 260px;
}
.api-output {
  color: #9be7b8;
}
@media (max-width: 800px) {
  .api-console {
    grid-template-columns: 1fr;
  }
}
.equip-tree {
  overflow: auto;
  max-height: min(48vh, 420px);
  margin: 0 16px 8px;
  border: 1px solid #2a3b55;
  border-radius: 8px;
  background: #0f1724;
}
.equip-tree-node {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid #1c2838;
  border-radius: 0;
  padding: 8px 12px;
  color: #d7e6f7;
  font-size: 13px;
}
.equip-tree-node:hover {
  background: #1a2738;
}
.equip-tree-node.selected {
  background: #15304a;
  box-shadow: inset 3px 0 0 #4ea1ff;
}
.equip-tree-node.branch .equip-tree-name {
  color: #9ec5e8;
  font-weight: 600;
}
.equip-tree-code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: #7f93ab;
  flex-shrink: 0;
}
.tag-step .kv-line {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}
.tag-step .k {
  width: 4.5rem;
  flex-shrink: 0;
  color: #9bb0c7;
  font-size: 13px;
  padding-top: 8px;
}
.tag-step .v {
  flex: 1;
  font-size: 14px;
}
.tag-pick {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.tag-pick .grow {
  flex: 1;
  min-width: 200px;
}
.error-text {
  color: #ffb4b4;
}
/* 画面壳吃满工具栏以下剩余高度；保底高度防止塌缩 */
.pixel-shell {
  position: relative;
  width: 100%;
  flex: 1 1 auto;
  min-height: 280px;
  background: #000;
  border-radius: 8px;
  border: 1px solid #35506a;
  overflow: hidden;
  isolation: isolate;
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
  border-radius: 8px;
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
  max-width: 100% !important;
  max-height: 100% !important;
  object-fit: contain !important;
  pointer-events: auto !important;
  border-radius: 8px;
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
  margin-top: 0;
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
  overflow-y: auto;
  background: #0d1420;
  border-radius: 8px;
  padding: 8px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}
.log-tall {
  height: 320px;
}
.log > div {
  border-bottom: 1px solid #1c2838;
  padding: 4px 0;
}
.log .error {
  color: #ff6b6b;
}
.log .warn {
  color: #e6c07b;
}
.log .fault {
  color: #ffb74d;
}
.log .info {
  color: #8bc34a;
}
.log .mock-data {
  color: #42a5f5;
}
.log .ended {
  color: #64ff64;
}
</style>
