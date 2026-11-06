/**
 * TwinMaster (PiClient) bridge — cloud path aligned with 前端示例/pixel.html.
 * - preview: no CIMPro
 * - embed: pageReady() inside CIMPro webview
 * - cloud: UMD PiClientJS + lib-pixelstreamingfrontend (NOT ESM)
 */

import {
  getActiveHull,
  getActiveHullId,
  listHulls,
  phaseBanner,
  resolveBinding,
  setActiveHullId,
} from '@/services/equipmentMap'

function getPiClientCtor() {
  const Ctor = window.PiClientJS?.PiClient
  if (!Ctor) {
    throw new Error(
      'PiClientJS 未加载。请确认 index.html 已引入 /cimpro/lib-pixelstreamingfrontend.js 与 /cimpro/index.umd.js（官方云渲染不支持 ESM）',
    )
  }
  return Ctor
}

function pickObjectId(res) {
  if (!res) return null
  const p = res.params || res.param || res
  return (
    p.objectId ||
    p.ObjectId ||
    p.id ||
    p.target ||
    res.target ||
    p.objects?.[0] ||
    (typeof p === 'string' ? p : null) ||
    null
  )
}

/** 从 getInfo / click / getChild 响应里尽量抽出 name / tag / objectId */
function pickSceneObjectMeta(res) {
  if (!res) return null
  const p = res.params || res.param || res.data || res
  const list = Array.isArray(p)
    ? p
    : Array.isArray(p?.objects)
      ? p.objects
      : Array.isArray(p?.children)
        ? p.children
        : Array.isArray(p?.list)
          ? p.list
          : [p]
  const out = []
  for (const item of list) {
    if (item == null) continue
    if (typeof item === 'string') {
      out.push({ objectId: item, name: item, tag: '' })
      continue
    }
    const objectId = String(
      item.objectId || item.ObjectId || item.id || item.target || item.uid || '',
    )
    const name = String(
      item.displayName || item.name || item.objectName || item.label || objectId || '',
    )
    const tag = String(item.tag || item.Tag || item.mark || item.marker || '')
    if (!objectId && !name && !tag) continue
    out.push({ objectId, name: name || tag || objectId, tag })
    if (Array.isArray(item.children)) {
      for (const child of pickSceneObjectMeta({ objects: item.children }) || []) {
        out.push(child)
      }
    }
  }
  return out.length ? out : null
}

export function createTwinBridge({ onLog, onSceneState, onSceneObjects } = {}) {
  let piclient = null
  let mode = 'preview'
  let cloudConnected = false
  /** displayName / 逻辑名 → 引擎 ObjectId */
  const objectIdCache = new Map()
  /** key = tag || objectId → { name, tag, objectId } */
  const sceneObjectCatalog = new Map()
  const faultTargets = new Set()
  const repairTargets = new Set()
  /**
   * 故障可视化状态（按设备 ObjectId）
   * @type {Map<string, {
   *   state: 'WAITING_REPAIR'|'REPAIRING'|'FAILURE_NON_REPAIRABLE',
   *   equipmentName: string,
   *   poiTag: string,
   *   poiCreated: boolean,
   *   hlOn: boolean,
   *   blinkTimer: ReturnType<typeof setInterval> | null,
   * }>}
   */
  const faultVisuals = new Map()
  /** POI 相对设备向上偏移（引擎单位） */
  const FAULT_POI_OFFSET = '0,0,280'
  const FAULT_VISUAL_STYLE = {
    WAITING_REPAIR: { label: '保障延误', color: '#FFA94D', blinkMs: 1200 },
    REPAIRING: { label: '维修中', color: '#9C6BFF', blinkMs: 0 },
    FAILURE_NON_REPAIRABLE: { label: '不可修', color: '#FF6B6B', blinkMs: 1600 },
  }
  let currentPhase = null
  let selectedTarget = null
  /**
   * @type {null | {
   *   objectId: string,
   *   mode: 'absolute' | 'offset',
   *   home: {x:number,y:number,z:number} | null,
   *   step: number,
   *   stepDx: number,
   *   moveTime: number,
   *   timers: ReturnType<typeof setTimeout>[],
   * }}
   */
  let hullCruise = null
  /** 最近一次巡航快照：轮询/停止竞态清掉 hullCruise 后仍可瞬移回位 */
  let cruiseSnapshot = null
  /** 结束回位中：禁止再 advance；并用于延迟盖写未完成的 moveSync */
  let cruiseClosing = false
  let cruiseReinforceTimer = null
  /** 与 mock 1s 一条对齐的默认步距（引擎单位）；实际每步可被态势航速覆盖 */
  const HULL_CRUISE_DEFAULT_STEP_DX = 400
  const HULL_CRUISE_SLICES = 12
  /** 跟镜定时器：高频短 fly 叠加以避免 1s 一顿 */
  let cruiseCamTimer = null
  let cruiseCamTargetId = ''

  const log = (msg, level = 'info') => onLog?.({ msg, level, at: Date.now() })

  function clearHullCruiseTimers() {
    if (!hullCruise?.timers?.length) return
    for (const t of hullCruise.timers) clearTimeout(t)
    hullCruise.timers = []
  }

  function clearCruiseReinforceTimer() {
    if (cruiseReinforceTimer) {
      clearTimeout(cruiseReinforceTimer)
      cruiseReinforceTimer = null
    }
  }

  function stopCruiseCameraFollow() {
    if (cruiseCamTimer) {
      clearInterval(cruiseCamTimer)
      cruiseCamTimer = null
    }
    cruiseCamTargetId = ''
  }

  /**
   * 连续跟镜：每隔一段发一次短时 camera.fly（时长 > 间隔，轨迹重叠更平滑）
   * 一律 emitNow，避免 await 超时堆积。
   */
  function startCruiseCameraFollow(objectId) {
    const id = String(objectId || '').trim()
    if (!id || !cloudConnected || cruiseClosing) return
    if (cruiseCamTimer && cruiseCamTargetId === id) return
    stopCruiseCameraFollow()
    cruiseCamTargetId = id
    emitNow('camera.focus', { target: id })
    emitNow('camera.fly', { target: id, time: '0.8' })
    cruiseCamTimer = setInterval(() => {
      if (!cloudConnected || !cruiseCamTargetId || cruiseClosing) return
      emitNow('camera.fly', { target: cruiseCamTargetId, time: '0.45' })
    }, 220)
  }

  /** 解析引擎坐标：支持 "x,y,z" / "X=a Y=b Z=c" / {x,y,z}；优先 pos，避免误用 geo */
  function parseXYZToken(c) {
    if (c == null) return null
    if (Array.isArray(c) && c.length >= 3) {
      const x = Number(c[0])
      const y = Number(c[1])
      const z = Number(c[2])
      if ([x, y, z].every(Number.isFinite)) return { x, y, z }
      return null
    }
    if (typeof c === 'string') {
      const s = c.trim()
      // CIMPro getChild: "X=-39362.536 Y=27211.383 Z=795.617"
      const m = s.match(
        /X\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*Y\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*Z\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i,
      )
      if (m) {
        const x = Number(m[1])
        const y = Number(m[2])
        const z = Number(m[3])
        if ([x, y, z].every(Number.isFinite)) return { x, y, z }
      }
      if (s.includes(',')) {
        const parts = s.split(',').map((p) => Number(String(p).trim()))
        if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
          return { x: parts[0], y: parts[1], z: parts[2] }
        }
      }
      return null
    }
    if (typeof c === 'object' && !Array.isArray(c)) {
      const x = Number(c.x ?? c.X)
      const y = Number(c.y ?? c.Y)
      const z = Number(c.z ?? c.Z)
      if ([x, y, z].every(Number.isFinite)) return { x, y, z }
    }
    return null
  }

  function parseEngineXYZ(res) {
    if (!res) return null
    const preferred = []
    const fallback = []
    const pushPref = (v) => {
      if (v != null) preferred.push(v)
    }
    const pushFb = (v) => {
      if (v != null) fallback.push(v)
    }
    const walk = (node, depth = 0) => {
      if (!node || depth > 5) return
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, depth + 1))
        return
      }
      if (typeof node !== 'object') return
      // 引擎世界坐标：pos / engine / position（不要用 geo，量级是经纬/局部）
      pushPref(node.pos)
      pushPref(node.engine)
      pushPref(node.position)
      pushPref(node.worldLocation)
      pushPref(node.Location)
      pushPref(node.Engine)
      pushPref(node.location)
      pushFb(node.geo)
      if (node.transform) walk(node.transform, depth + 1)
      if (node.params) walk(node.params, depth + 1)
      if (node.param) walk(node.param, depth + 1)
      if (node.data) walk(node.data, depth + 1)
      if (node.Objects) walk(node.Objects, depth + 1)
      if (node.objects) walk(node.objects, depth + 1)
    }
    walk(res)
    for (const c of preferred) {
      const p = parseXYZToken(c)
      if (p) return p
    }
    for (const c of fallback) {
      const p = parseXYZToken(c)
      if (p) return p
    }
    return null
  }

  /** 启动巡航前尽量拿到引擎世界坐标（getInfo 常空，getChild 常有 pos） */
  async function resolveHullHome(objectId) {
    const id = String(objectId || '').trim()
    if (!id) return null
    const fromInfo =
      parseEngineXYZ(await queryObjectInfo({ target: id }, 2000)) ||
      parseEngineXYZ(await queryObjectInfo({ objectId: id }, 1200)) ||
      parseEngineXYZ(await queryObjectInfo({ displayName: id }, 1200))
    if (fromInfo) return fromInfo
    const child = await withTimeout(
      Promise.resolve(piclient?.emit?.('object.getChild', { target: id })),
      2500,
      `getChild ${id}`,
    )
    return parseEngineXYZ(child)
  }

  function emitScene() {
    onSceneState?.({
      mode,
      connected: mode === 'cloud' ? cloudConnected : !!piclient,
      currentPhase,
      selectedTarget,
      activeHullId: getActiveHullId(),
      faultTargets: [...faultTargets],
      repairTargets: [...repairTargets],
    })
  }

  function emitSceneObjects() {
    onSceneObjects?.(listSceneObjects())
  }

  function upsertSceneObject(meta) {
    if (!meta) return
    const tag = String(meta.tag || '').trim()
    const objectId = String(meta.objectId || '').trim()
    const name = String(meta.name || '').trim() || tag || objectId
    if (!tag && !objectId) return
    const key = tag || objectId
    const prev = sceneObjectCatalog.get(key) || {}
    const next = {
      name: name || prev.name || key,
      tag: tag || prev.tag || '',
      objectId: objectId || prev.objectId || '',
    }
    sceneObjectCatalog.set(key, next)
    if (tag && objectId) objectIdCache.set(tag, objectId)
    if (name && objectId) objectIdCache.set(name, objectId)
  }

  function listSceneObjects() {
    return [...sceneObjectCatalog.values()]
      .map((o) => ({
        ...o,
        label: o.tag ? `${o.name} (${o.tag})` : `${o.name}（无 Tag）`,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
  }

  function bindCommonListeners() {
    if (!piclient) return
    piclient.on('cloud.init', '', (res) => {
      log(`cloud.init ${JSON.stringify(res)}`, 'debug')
    })
    piclient.on('object.onClick', '', (res) => {
      selectedTarget = res?.target || res?.params?.objects?.[0] || null
      if (selectedTarget) objectIdCache.set(String(selectedTarget), String(selectedTarget))
      const metas = pickSceneObjectMeta(res)
      if (metas) {
        metas.forEach(upsertSceneObject)
        emitSceneObjects()
      } else if (selectedTarget) {
        upsertSceneObject({ objectId: String(selectedTarget), name: String(selectedTarget), tag: '' })
        emitSceneObjects()
      }
      // 场景点选只更新目录，不写入 Mock 态势日志（level=scene 会被页面过滤）
      log(`场景点击: ${selectedTarget}`, 'scene')
      emitScene()
    })
    piclient.on('object.onSelect', '', (res) => {
      const id = pickObjectId(res)
      if (id) objectIdCache.set(String(id), String(id))
      const metas = pickSceneObjectMeta(res)
      if (metas) {
        metas.forEach(upsertSceneObject)
        emitSceneObjects()
      }
      log(`对象选择: ${id || '-'}`, 'scene')
    })
    piclient.on('object.getInfo', '', (res) => {
      const metas = pickSceneObjectMeta(res)
      if (metas) {
        metas.forEach(upsertSceneObject)
        emitSceneObjects()
      }
      // 调试噪音：不进态势栏
      log(`object.getInfo 回调: ${JSON.stringify(res)}`, 'debug')
    })
    piclient.on('global', '', (res) => {
      const action = String(res?.action || res?.event || res?.type || '')
      // 全部全局回包仅作调试；点选类仍标 scene
      if (/onClick|onSelect|onUnSelect|onMoved/i.test(action)) {
        log(`<全局> ${action}`, 'scene')
        return
      }
      log(`<全局> ${JSON.stringify(res)}`, 'debug')
    })
  }

  /**
   * 官方 API：camera.* / object.* 的 target 是引擎 ObjectId，不是大纲显示名。
   * 先用 object.getInfo({ displayName }) 解析，再缓存。
   */
  function queryObjectInfo(param, timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (!piclient) {
        resolve(null)
        return
      }
      let settled = false
      const done = (res) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(res || null)
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      try {
        piclient.once?.('object.getInfo', '', (res) => done(res))
      } catch {
        /* once 不可用时依赖 emit then */
      }
      Promise.resolve(piclient.emit('object.getInfo', param))
        .then((res) => {
          if (res) done(res)
        })
        .catch(() => {})
    })
  }

  async function resolveObjectId(logicalName) {
    if (!logicalName) return null
    const key = String(logicalName)
    if (objectIdCache.has(key)) return objectIdCache.get(key)

    // 已是引擎 ObjectId（如 SceneMeshObject_1）→ 直接用，避免 getInfo 拖死
    if (/^SceneMeshObject_/i.test(key)) {
      objectIdCache.set(key, key)
      return key
    }

    const nameVariants = [...new Set([key, key.toLowerCase()])]
    for (const displayName of nameVariants) {
      const info = await withTimeout(queryObjectInfo({ displayName }, 1200), 1300, `getInfo ${displayName}`)
      const id = pickObjectId(info)
      if (id) {
        objectIdCache.set(key, String(id))
        objectIdCache.set(displayName, String(id))
        log(`解析对象 ${key} → ObjectId=${id}`)
        return String(id)
      }
    }

    log(`未解析到 ObjectId，直传「${key}」`, 'warn')
    objectIdCache.set(key, key)
    return key
  }

  /**
   * 飞向对象：优先 Tag，其次 ObjectId / 显示名。
   * @param {string|{tag?:string, target?:string}} ref
   */
  async function flyToTarget(ref) {
    const tag = typeof ref === 'object' ? String(ref?.tag || '').trim() : ''
    const logical = typeof ref === 'object' ? ref?.target : ref

    if (tag) {
      void emit('camera.focus', { tag })
      void emit('camera.fly', { tag, time: '2.0' })
      const info = await withTimeout(queryObjectInfo({ tag }, 1200), 1300, `getInfo tag=${tag}`)
      const id = pickObjectId(info)
      if (id) {
        void emit('camera.focus', { target: id })
        void emit('camera.fly', { target: id, time: '2.0' })
        objectIdCache.set(tag, String(id))
        log(`相机对准 tag=${tag} (id=${id})`)
        return String(id)
      }
      log(
        `场景未解析到 Tag「${tag}」（getInfo 无 ObjectId）。请确认 CIMPro 已保存该标记后重新发布/进播放`,
        'warn',
      )
      return tag
    }

    if (!logical) return null
    const objectId = await resolveObjectId(logical)
    if (!objectId) return null
    void emit('camera.focus', { target: objectId })
    void emit('camera.fly', { target: objectId, time: '2.0' })
    log(`相机对准 ${logical} (id=${objectId})`)
    return objectId
  }

  /** 官方 pixel.html togglePlay：藏编辑器 UI + 进播放模式 */
  async function enterPlayMode() {
    if (!piclient || !cloudConnected) {
      log('未连接云渲染，无法进入播放模式', 'warn')
      return
    }
    await emit('ui.setClientUIVisible', { visible: 'hide' })
    await emit('mode.enterPlayMode')
    log('已 enterPlayMode + 隐藏客户端 UI', 'debug')
  }

  function getPixelStreaming() {
    return piclient?._cloudrenderIns?.pixelStreaming || null
  }

  function getPsConfig() {
    return piclient?._cloudrenderIns?.config || getPixelStreaming()?.config || null
  }

  /** @type {ReturnType<typeof setTimeout>[]} */
  let mouseReviveTimers = []
  /** @type {null | (() => void)} */
  let mouseGuardCleanup = null

  function clearMouseReviveTimers() {
    for (const t of mouseReviveTimers) clearTimeout(t)
    mouseReviveTimers = []
  }

  function getStreamerHandlers() {
    const ps = getPixelStreaming()
    const rtc = ps?._webRtcController
    return (
      rtc?.streamMessageController?.toStreamerHandlers ||
      ps?.streamMessageController?.toStreamerHandlers ||
      null
    )
  }

  /**
   * 关掉 AFK + 强制 HoveringMouse + 打开鼠标输入。
   * PiClient 默认 AFKTimeout=120 且 useUrlParams:true；streamer InitialSettings 也可能改回。
   */
  function hardenIdleSettings() {
    const cfg = getPsConfig()
    if (!cfg) return
    try {
      cfg.setFlagEnabled?.('TimeoutIfIdle', false)
      cfg.setFlagEnabled?.('HoveringMouse', true)
      cfg.setFlagEnabled?.('MouseInput', true)
      cfg.setFlagEnabled?.('KeyboardInput', true)
      cfg.setNumericSetting?.('AFKTimeout', 0)
    } catch (e) {
      log(`输入保活设置失败: ${e?.message || e}`, 'warn')
    }
  }

  /**
   * 恢复鼠标拖拽。根因（Pixel Streaming / CIMPro 常见）：
   * 1) UE 已收到 MouseLeave，但光标仍在画面内 → 不再触发 mouseenter，拖拽全废（emit 仍正常）
   * 2) HoveringMouse 下在画面外松开左键 → 按钮状态卡住（UE5.2 前端无 window 级 mouseup 修复）
   * 3) AFK / TimeoutIfIdle 超时后输入被掐掉
   * 做法：先 Leave 清状态再 Enter；hard 时重绑监听；DOM 补发 mouseenter。
   * @param {{ hard?: boolean }} [opts]
   */
  function reviveMouseInput(opts = {}) {
    if (!cloudConnected) return false
    const hard = !!opts.hard
    const ps = getPixelStreaming()
    const cfg = getPsConfig()
    hardenIdleSettings()
    try {
      const rtc = ps?._webRtcController
      if (hard) {
        if (rtc?.setMouseInputEnabled) {
          rtc.setMouseInputEnabled(false)
          rtc.setMouseInputEnabled(true)
        } else if (cfg?.setFlagEnabled) {
          cfg.setFlagEnabled('MouseInput', false)
          cfg.setFlagEnabled('MouseInput', true)
        }
      }
      const handlers = getStreamerHandlers()
      // Leave→Enter：清掉 UE 侧残留悬停/按键，再重新进入
      handlers?.get?.('MouseLeave')?.([])
      handlers?.get?.('MouseEnter')?.([])

      const parent =
        rtc?.videoPlayer?.getVideoParentElement?.() ||
        ps?._webRtcController?.videoPlayer?.getVideoParentElement?.() ||
        null
      const video =
        parent?.querySelector?.('video') ||
        piclient?._cloudrenderIns?.$el?.querySelector?.('video') ||
        null
      const target = video || parent
      if (target) {
        try {
          target.dispatchEvent(
            new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }),
          )
        } catch {
          /* ignore */
        }
      }
      return true
    } catch (e) {
      log(`恢复鼠标输入失败: ${e?.message || e}`, 'warn')
      return false
    }
  }

  /**
   * 画面内虚假 mouseleave（子节点/滚动条/叠加层）时自动补 Enter。
   * 拖拽中指针移出再松开导致的卡键，在下次 pointerdown 时由 revive 清掉。
   */
  function installMouseInputGuard(container) {
    mouseGuardCleanup?.()
    mouseGuardCleanup = null
    if (!container) return

    const onLeave = (ev) => {
      if (!cloudConnected) return
      const related = ev.relatedTarget
      if (related && container.contains(related)) return
      // 指针其实还在容器上（letterbox / 子层抖动）→ 立刻补 Enter
      const x = ev.clientX
      const y = ev.clientY
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const hit = document.elementFromPoint(x, y)
        if (hit && container.contains(hit)) {
          reviveMouseInput()
          return
        }
      }
    }
    const onEnterOrDown = () => {
      if (cloudConnected) reviveMouseInput()
    }
    container.addEventListener('mouseleave', onLeave)
    container.addEventListener('pointerenter', onEnterOrDown)
    container.addEventListener('pointerdown', onEnterOrDown)
    mouseGuardCleanup = () => {
      container.removeEventListener('mouseleave', onLeave)
      container.removeEventListener('pointerenter', onEnterOrDown)
      container.removeEventListener('pointerdown', onEnterOrDown)
    }
  }

  /** 连接后视频未立刻 ready，分几次补绑 */
  function schedulePostConnectMouseRevive() {
    clearMouseReviveTimers()
    for (const ms of [300, 1000, 2500]) {
      mouseReviveTimers.push(
        setTimeout(() => {
          if (!cloudConnected) return
          reviveMouseInput({ hard: ms >= 1000 })
        }, ms),
      )
    }
  }

  async function connect({ mode: m = 'preview', container, address } = {}) {
    mode = m
    cloudConnected = false

    if (mode === 'preview') {
      log('预览模式：未连接孪大师，业务流可先联调 underwater-mock')
      emitScene()
      return { mode }
    }

    if (mode === 'embed') {
      const PiClient = getPiClientCtor()
      piclient = new PiClient({ debug: true })
      bindCommonListeners()
      await piclient.pageReady()
      log('CIMPro 内嵌模式 pageReady 完成')
      emitScene()
      return { mode }
    }

    // —— cloud：严格按 前端示例/pixel.html ——
    if (!container || !address) throw new Error('云渲染需要 container 与 address')

    const PiClient = getPiClientCtor()

    if (piclient?.cloudrender) {
      try {
        piclient.cloudrender.destroy()
      } catch {
        /* ignore */
      }
      piclient = null
    }
    if (container) container.innerHTML = ''

    piclient = new PiClient({ debug: true })
    bindCommonListeners()

    // 与官方示例一致的初始化参数
    const initConfig = {
      $el: container,
      address,
      appKey: '',
      mode: 'pixelstreaming',
      token: '123',
      editorMode: false,
      projectId: '',
      showUI: false,
      StreamerId: `simverify_${Date.now()}`,
      initialSettings: {
        MatchViewportRes: false,
        MinQP: 25,
        MaxQP: 35,
        WebRTCMinBitrate: 5000,
        WebRTCMaxBitrate: 100000,
        HoveringMouse: true,
        AutoPlayVideo: true,
        SuppressBrowserKeys: true,
        // 避免空闲一段时间后鼠标拖拽失效（emit 仍可用）
        TimeoutIfIdle: false,
        AFKTimeout: 0,
        MaxReconnectAttempts: 0,
        MouseInput: true,
        KeyboardInput: true,
        TouchInput: true,
      },
      onProgress: (percent) => {
        log(`云渲染进度 ${percent}%`)
      },
      onDisconnect: (msg) => {
        cloudConnected = false
        log(`云渲染断开: ${msg}`, 'error')
        emitScene()
      },
    }

    log(`云渲染连接中 ${address} …`)
    const baseDb = await piclient.cloudrender.init(initConfig)
    cloudConnected = true
    log(`云渲染连接成功；可用事件数 ${(piclient.classEvents || []).length}`)
    if (baseDb) log(`baseDb keys: ${Object.keys(baseDb).join(',')}`)
    if (!piclient._cloudrenderIns?.pixelStreaming) {
      log('未暴露 pixelStreaming，鼠标恢复能力受限（需带 n.pixelStreaming=a 的 index.umd.js）', 'warn')
    }
    hardenIdleSettings()

    // 官方 connect 成功后立刻 togglePlay
    await enterPlayMode()
    hardenIdleSettings()

    installMouseInputGuard(container)
    schedulePostConnectMouseRevive()

    // 切页签：硬恢复；窗口 focus：软恢复（避免频繁 setMouseInputEnabled 拆掉监听）
    const onVis = () => {
      if (document.visibilityState === 'visible') reviveMouseInput({ hard: true })
    }
    const onFocus = () => reviveMouseInput()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    const prevCleanup = piclient.__mouseReviveCleanup
    piclient.__mouseReviveCleanup = () => {
      try {
        prevCleanup?.()
      } catch {
        /* ignore */
      }
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
      clearMouseReviveTimers()
      mouseGuardCleanup?.()
      mouseGuardCleanup = null
    }

    emitScene()
    // 异步拉场景对象目录，不阻塞进 play
    void refreshSceneObjects()
    return { mode, baseDb }
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => {
        setTimeout(() => {
          // 远程云渲染回调常慢于超时阈值，属预期；勿刷态势栏
          log(`${label || '操作'} 超时 ${ms}ms（已继续，不阻塞界面）`, 'debug')
          resolve(null)
        }, ms)
      }),
    ])
  }

  async function emit(action, param) {
    if (mode === 'preview' || !piclient) {
      log(`[preview emit] ${action} ${JSON.stringify(param || {})}`)
      return null
    }
    if (mode === 'cloud' && !cloudConnected) {
      log(`云渲染未就绪，跳过 ${action}`, 'warn')
      return null
    }
    // 客户端部分 API 的 Promise 可能永不 settle，必须加超时，否则页面 busy 锁死
    try {
      return await withTimeout(piclient.emit(action, param), 2500, `emit ${action}`)
    } catch (e) {
      log(`emit ${action} 失败: ${e.message}`, 'error')
      return null
    }
  }

  /** 立即发出、不等待回包（复位/跟镜用，避免被 2.5s 超时拖住） */
  function emitNow(action, param) {
    if (mode === 'preview' || !piclient) return false
    if (mode === 'cloud' && !cloudConnected) return false
    try {
      void piclient.emit(action, param)
      return true
    } catch (e) {
      log(`emitNow ${action} 失败: ${e?.message || e}`, 'error')
      return false
    }
  }

  function syncFaultSetsFromVisuals() {
    faultTargets.clear()
    repairTargets.clear()
    for (const [objectId, entry] of faultVisuals) {
      if (entry.state === 'REPAIRING') repairTargets.add(objectId)
      else faultTargets.add(objectId)
    }
  }

  function stopFaultBlink(entry) {
    if (!entry?.blinkTimer) return
    clearInterval(entry.blinkTimer)
    entry.blinkTimer = null
  }

  function setObjectHighlight(objectId, on) {
    emitNow('object.highlight', {
      target: objectId,
      highlight: on ? 'true' : 'false',
      bAffectChild: 'false',
    })
  }

  function startFaultBlink(objectId, entry, blinkMs) {
    stopFaultBlink(entry)
    entry.hlOn = true
    setObjectHighlight(objectId, true)
    if (!blinkMs || blinkMs <= 0) return
    entry.blinkTimer = setInterval(() => {
      entry.hlOn = !entry.hlOn
      setObjectHighlight(objectId, entry.hlOn)
    }, blinkMs)
  }

  function faultPoiTag(objectId) {
    return `dt_fault_${String(objectId).replace(/[^\w.-]/g, '_')}`
  }

  /**
   * FAULT_EVENT → 大屏对齐状态
   * WAITING_REPAIR / REPAIRING / FAILURE_NON_REPAIRABLE / CLEAR
   */
  function resolveFaultVisualState(status, repairable) {
    const s = String(status || '').toUpperCase()
    if (s === 'REPAIR_END' || s === 'CLEAR' || s === 'FIXED' || s === 'REPAIR_DONE') {
      return 'CLEAR'
    }
    if (s === 'REPAIR_START' || s === 'REPAIRING') return 'REPAIRING'
    if (
      s === 'FAULT_DETAIL' ||
      s === 'FAILURE_NON_REPAIRABLE' ||
      s === 'NON_REPAIRABLE'
    ) {
      return 'FAILURE_NON_REPAIRABLE'
    }
    if (s === 'FAULT_OCCUR' || s === 'FAULT' || s === 'WAITING_REPAIR') {
      const unrepairable =
        repairable === false ||
        repairable === 0 ||
        repairable === '0' ||
        String(repairable).toLowerCase() === 'false'
      return unrepairable ? 'FAILURE_NON_REPAIRABLE' : 'WAITING_REPAIR'
    }
    return null
  }

  async function upsertFaultPoi(objectId, entry, style) {
    const tag = entry.poiTag || faultPoiTag(objectId)
    entry.poiTag = tag
    const payload = {
      tag,
      parentId: objectId,
      offset: FAULT_POI_OFFSET,
      labelText: style.label,
      labelColor: style.color,
      labelSize: '16',
      iconColor: style.color,
      focusFly: false,
      poiType: '2D',
      styleType: 'TextOnly',
    }
    if (entry.poiCreated) {
      emitNow('poi.modifyPOI', {
        tag,
        visibility: '1',
        labelText: style.label,
        labelColor: style.color,
        labelSize: '16',
        iconColor: style.color,
        focusFly: false,
      })
      return
    }
    const res = await emit('poi.createPOI', payload)
    entry.poiCreated = true
    // 自建模型作 parent 时偶发需一次 scale 才显示 POI
    emitNow('object.scale', { target: objectId, scale: '1,1,1' })
    if (res) log(`故障 POI 已创建 tag=${tag}`, 'debug')
  }

  async function hideFaultPoi(entry) {
    if (!entry?.poiTag || !entry.poiCreated) return
    emitNow('poi.modifyPOI', { tag: entry.poiTag, visibility: '0' })
  }

  async function clearOneFaultVisual(objectId) {
    const entry = faultVisuals.get(objectId)
    if (!entry) return
    stopFaultBlink(entry)
    setObjectHighlight(objectId, false)
    await hideFaultPoi(entry)
    faultVisuals.delete(objectId)
  }

  /** 仿真结束 / 断连时清掉全部故障高亮与 POI（不抢镜头） */
  async function clearFaultVisuals() {
    const ids = [...faultVisuals.keys()]
    for (const id of ids) {
      await clearOneFaultVisual(id)
    }
    syncFaultSetsFromVisuals()
    emitScene()
    if (ids.length) log(`已清除 ${ids.length} 处故障视觉`, 'fault')
  }

  /**
   * 故障视觉：高亮慢闪 + 挂父级 TextOnly POI。不 flyTo / 不抢跟舰镜头。
   * @param {string} equipmentName
   * @param {string} status FAULT_OCCUR / REPAIR_START / REPAIR_END / …
   * @param {{ repairable?: boolean, faultName?: string }} [opts]
   */
  async function highlightFault(equipmentName, status, opts = {}) {
    const binding = resolveBinding(equipmentName)
    if (!binding) {
      log(`未映射设备: ${equipmentName}（请在页面「设备↔ObjectId 映射」中配置）`, 'warn')
      return
    }
    const objectId = String(binding.objectId || '').trim()
    if (!objectId) {
      log(`设备「${binding.equipmentName || equipmentName}」未填写 ObjectId，无法定位孪生对象`, 'warn')
      return
    }

    const visualState = resolveFaultVisualState(status, opts.repairable)
    if (!visualState) {
      log(`故障视觉忽略未知状态 status=${status}`, 'debug')
      return
    }

    if (visualState === 'CLEAR') {
      await clearOneFaultVisual(objectId)
      syncFaultSetsFromVisuals()
      log(`故障视觉清除 → ObjectId=${objectId} (${binding.equipmentName})`, 'fault')
      emitScene()
      return
    }

    const style = FAULT_VISUAL_STYLE[visualState]
    let entry = faultVisuals.get(objectId)
    if (!entry) {
      entry = {
        state: visualState,
        equipmentName: binding.equipmentName || equipmentName,
        poiTag: faultPoiTag(objectId),
        poiCreated: false,
        hlOn: false,
        blinkTimer: null,
      }
      faultVisuals.set(objectId, entry)
    }
    entry.state = visualState
    entry.equipmentName = binding.equipmentName || equipmentName

    // 保可见 + 高亮/慢闪 + 状态 POI；绝不切换相机
    await emit('object.visible', { target: objectId, visible: 'show' })
    startFaultBlink(objectId, entry, style.blinkMs)
    await upsertFaultPoi(objectId, entry, style)

    syncFaultSetsFromVisuals()
    log(
      `故障视觉 ${status}→${visualState} → ObjectId=${objectId} (${binding.equipmentName})「${style.label}」，未切换视角`,
      'fault',
    )
    emitScene()
  }

  async function applyPhase(phaseId) {
    currentPhase = String(phaseId || '')
    const active = phaseBanner(currentPhase)
    if (active) {
      for (const b of ['Phase_Banner_552', 'Phase_Banner_553', 'Phase_Banner_554']) {
        const objectId = await resolveObjectId(b)
        await emit('object.visible', {
          target: objectId,
          visible: b === active ? 'show' : 'hide',
        })
      }
    }
    log(`阶段切换 → ${currentPhase}`)
    emitScene()
  }

  async function selectActiveHull(hullId, { fly = true } = {}) {
    const id = setActiveHullId(hullId)
    const hull = getActiveHull()
    // 暂用引擎 ObjectId（CIMPro Tag 保存不稳定）；有 Tag 且以后恢复时可再优先 Tag
    const objectId = String(hull?.objectId || '').trim()
    selectedTarget = objectId || id
    log(`切换当前舰体 → ${hull?.label || id}${objectId ? ` (ObjectId=${objectId})` : ''}`)
    emitScene()
    if (fly) {
      if (objectId) await flyToTarget(objectId)
      else {
        log('舰体未填写 ObjectId，无法切换相机', 'warn')
      }
    }
    return id
  }

  async function selectEquipmentTarget(nameOrIdOrTag) {
    const binding = resolveBinding(nameOrIdOrTag)
    if (binding?.objectId) {
      selectedTarget = binding.objectId
      await flyToTarget(binding.objectId)
      emitScene()
      return binding.objectId
    }
    const raw = String(nameOrIdOrTag || '')
    selectedTarget = raw
    await flyToTarget(raw)
    emitScene()
    return raw
  }

  async function flyToObjectId(objectId) {
    if (!objectId) return null
    selectedTarget = objectId
    const id = await flyToTarget(objectId)
    emitScene()
    return id
  }

  /** @deprecated 保留别名；现已优先 ObjectId */
  async function flyToTag(tagOrId) {
    if (!tagOrId) return null
    if (/^SceneMeshObject_/i.test(String(tagOrId))) return flyToObjectId(tagOrId)
    selectedTarget = tagOrId
    const id = await flyToTarget({ tag: tagOrId })
    emitScene()
    return id
  }

  /** 手动探测大纲名 → ObjectId，结果写进联调日志 */
  async function probeObject(displayName) {
    const name = displayName || getActiveHullId() || 'Sub_Hull_051C'
    objectIdCache.delete(name)
    const id = await resolveObjectId(name)
    log(`探测 ${name} → ${id || '失败'}`)
    return id
  }

  /**
   * 拉取孪生场景对象（供 Tag 下拉）。只收录引擎真实返回的对象，绝不塞本地映射假数据。
   * 公开 API 未必能枚举全场景：失败时目录为空 → UI 应手填 Tag；点选场景仍会经 onClick 写入。
   */
  async function refreshSceneObjects() {
    // 刷新时清空，避免残留此前误写入的「映射表伪装对象」
    sceneObjectCatalog.clear()

    if (mode === 'preview' || !piclient || (mode === 'cloud' && !cloudConnected)) {
      log('云渲染未连接，无法枚举孪生对象（请手填 Tag）', 'warn')
      emitSceneObjects()
      return listSceneObjects()
    }

    const roots = [
      ...listHulls().flatMap((h) => [h.objectId, h.id].filter(Boolean)),
      getActiveHullId(),
      getActiveHull()?.objectId,
    ].filter(Boolean)

    for (const root of new Set(roots)) {
      const res = await emit('object.getChild', { target: root })
      const metas = pickSceneObjectMeta(res)
      if (metas?.length) {
        metas.forEach(upsertSceneObject)
        log(`object.getChild ${root} → ${metas.length} 个子对象`)
      }
      const byName = await withTimeout(queryObjectInfo({ displayName: root }, 1000), 1100, `getInfo ${root}`)
      const nameMetas = pickSceneObjectMeta(byName)
      if (nameMetas?.length) nameMetas.forEach(upsertSceneObject)
    }

    // 对目录里已有 tag 再拉一次 getInfo，补全引擎侧 displayName（不凭空造项）
    const knownTags = [...sceneObjectCatalog.values()].map((o) => o.tag).filter(Boolean)
    for (const tag of new Set(knownTags)) {
      const info = await withTimeout(queryObjectInfo({ tag }, 1000), 1100, `getInfo tag=${tag}`)
      const metas = pickSceneObjectMeta(info)
      if (metas?.length) {
        metas.forEach((m) => upsertSceneObject({ ...m, tag: m.tag || tag }))
      }
    }

    emitSceneObjects()
    const list = listSceneObjects()
    const tagged = list.filter((o) => o.tag).length
    if (!tagged) {
      log('未从孪生引擎枚举到带 Tag 的对象，请手填 Tag，或在场景中点选对象后再刷新', 'warn')
    } else {
      log(`场景对象目录 ${list.length} 条（含 Tag ${tagged} 条）`)
    }
    return list
  }

  /** 官方示例里的天气测试，用来确认 emit 通道真通了 */
  async function testWeather(weather = 1) {
    await emit('environment.setWeather', { weather })
    log(`测试 emit environment.setWeather=${weather}`)
  }

  /**
   * 启动舰体沿 +X 平滑巡航：优先记录引擎坐标；读不到则用相对 offset 切片平滑。
   * @param {string} objectId
   * @param {{ moveTime?: number }} [opts]
   */
  async function beginHullCruise(objectId, opts = {}) {
    const id = String(objectId || '').trim()
    if (!id) throw new Error('舰体 ObjectId 为空')
    if (!cloudConnected) throw new Error('云渲染未连接')
    const moveTime = Number(opts.moveTime)
    const duration = Number.isFinite(moveTime) && moveTime > 0 ? moveTime : 1

    clearHullCruiseTimers()
    clearCruiseReinforceTimer()
    cruiseClosing = false

    const home = await resolveHullHome(id)

    if (home) {
      hullCruise = {
        objectId: id,
        mode: 'absolute',
        home: { ...home },
        step: 0,
        traveledX: 0,
        stepDx: HULL_CRUISE_DEFAULT_STEP_DX,
        moveTime: duration,
        timers: [],
      }
      log(
        `舰体巡航起点(绝对坐标) ObjectId=${id} home=(${home.x},${home.y},${home.z})`,
      )
    } else {
      // 读不到坐标：相对 +X；必须累计 traveledX
      hullCruise = {
        objectId: id,
        mode: 'offset',
        home: null,
        step: 0,
        traveledX: 0,
        stepDx: HULL_CRUISE_DEFAULT_STEP_DX,
        moveTime: duration,
        timers: [],
      }
      log(
        `舰体巡航起点(相对offset) ObjectId=${id}；未读到引擎坐标，已启用切片平滑`,
        'warn',
      )
    }
    cruiseSnapshot = {
      objectId: id,
      mode: hullCruise.mode,
      home: hullCruise.home ? { ...hullCruise.home } : null,
      traveledX: 0,
      moveTime: duration,
    }
    startCruiseCameraFollow(id)
    return {
      objectId: hullCruise.objectId,
      mode: hullCruise.mode,
      home: hullCruise.home,
      step: hullCruise.step,
    }
  }

  function resolveStepDx(speed) {
    const sp = Number(speed)
    if (Number.isFinite(sp) && sp > 0) return Math.max(80, Math.round(sp * 100))
    return hullCruise?.stepDx || HULL_CRUISE_DEFAULT_STEP_DX
  }

  function scheduleOffsetSlices(objectId, totalDx, durationSec) {
    clearHullCruiseTimers()
    const slices = HULL_CRUISE_SLICES
    const sliceDx = totalDx / slices
    const dt = (Math.max(0.2, durationSec) * 1000) / slices
    for (let i = 0; i < slices; i++) {
      const t = setTimeout(() => {
        if (cruiseClosing || !hullCruise) return
        emitNow('object.move', {
          target: objectId,
          offset: `${sliceDx},0,0`,
        })
      }, Math.round(i * dt))
      hullCruise?.timers.push(t)
    }
  }

  /**
   * 态势推送一步：沿 +X 在约 1s 内平滑移动。
   * @param {{ speed?: number }} [extra]
   */
  function advanceHullCruise(extra = {}) {
    if (!hullCruise || !cloudConnected || cruiseClosing) return false
    const stepDx = resolveStepDx(extra.speed)
    hullCruise.stepDx = stepDx
    hullCruise.step += 1
    hullCruise.traveledX = (Number(hullCruise.traveledX) || 0) + stepDx
    if (cruiseSnapshot) {
      cruiseSnapshot.traveledX = hullCruise.traveledX
      cruiseSnapshot.moveTime = hullCruise.moveTime
    }
    const { objectId, mode, home, traveledX, moveTime } = hullCruise

    if (mode === 'absolute' && home) {
      // 与结束回位同一通道：moveSync；必须 emitNow，避免超时队列拖死
      emitNow('object.moveSync', {
        target: objectId,
        engine: `${home.x + traveledX},${home.y},${home.z}`,
        time: String(moveTime),
        targetType: 'boat',
      })
    } else {
      scheduleOffsetSlices(objectId, stepDx, moveTime)
    }
    startCruiseCameraFollow(objectId)
    return true
  }

  /**
   * 强制舰回 home（绝对坐标幂等，可重复发以盖写未完成的巡航 moveSync）。
   * 相对模式只允许调用一次（offset 不可幂等）。
   */
  function forceHullHome(objectId, home, backX, { allowOffset = true } = {}) {
    if (home) {
      const engine = `${home.x},${home.y},${home.z}`
      // 用极短 time，与巡航同 API；time=0 在部分引擎上会被忽略
      emitNow('object.moveSync', {
        target: objectId,
        engine,
        time: '0.05',
        targetType: 'boat',
      })
      emitNow('object.move', { target: objectId, engine })
      return 'absolute'
    }
    if (allowOffset && backX) {
      emitNow('object.move', {
        target: objectId,
        offset: `${backX},0,0`,
      })
      return 'offset'
    }
    return null
  }

  function snapCameraToHull(objectId) {
    if (!objectId || !cloudConnected) return
    emitNow('camera.focus', { target: objectId })
    // 勿用 time=0（部分引擎会重置到默认视角，造成「镜头回原点、船还在外面」）
    emitNow('camera.fly', { target: objectId, time: '0.2' })
  }

  /**
   * 停止并回位。核心：先停 advance，立刻回位，再在上一拍 moveSync 时长后幂等盖写一次，
   * 防止「镜头已对到原点、未完成的巡航动画又把船拉走」。
   */
  async function endHullCruise() {
    const state = hullCruise || cruiseSnapshot
    if (!state?.objectId) return false
    if (cruiseClosing && !hullCruise) {
      // 已在收尾强化中，避免重入清掉 reinforce
      return true
    }

    const objectId = state.objectId
    const home = state.home ? { ...state.home } : null
    const traveledX = Number(state.traveledX) || 0
    const backX = -traveledX
    const moveTime = Number(state.moveTime) || 1

    cruiseClosing = true
    clearHullCruiseTimers()
    clearCruiseReinforceTimer()
    stopCruiseCameraFollow()
    hullCruise = null
    cruiseSnapshot = null

    if (!cloudConnected) {
      cruiseClosing = false
      return true
    }

    const how = forceHullHome(objectId, home, backX, { allowOffset: true })
    if (!how) {
      cruiseClosing = false
      log(`舰体复位失败：无有效 home/位移 ObjectId=${objectId}`, 'warn')
      return false
    }

    // 镜头跟着「回位后的舰」，不要先于船乱飞
    snapCameraToHull(objectId)

    // 盖写上一拍仍在插值的 moveSync（约 moveTime 秒）
    const reinforceMs = Math.round(Math.max(0.2, moveTime) * 1000 + 120)
    cruiseReinforceTimer = setTimeout(() => {
      cruiseReinforceTimer = null
      // 绝对坐标可重复；相对 offset 不可再发（会越过原点）
      forceHullHome(objectId, home, backX, { allowOffset: false })
      snapCameraToHull(objectId)
      cruiseClosing = false
      log(
        home
          ? `舰体回位盖写完成 ObjectId=${objectId} → (${home.x},${home.y},${home.z})`
          : `舰体回位完成 ObjectId=${objectId} mode=offset`,
        'debug',
      )
    }, reinforceMs)

    log(
      how === 'absolute' && home
        ? `舰体回位已发出 ObjectId=${objectId} → (${home.x},${home.y},${home.z})，将于 ${reinforceMs}ms 盖写`
        : `舰体回位已发出 ObjectId=${objectId} mode=${how} backX=${backX}`,
    )
    return true
  }

  function isHullCruiseActive() {
    // closing 期间对外仍视为「有巡航待收尾」，避免业务侧误判已空
    return !!hullCruise || !!cruiseSnapshot || cruiseClosing
  }

  function destroy() {
    clearHullCruiseTimers()
    clearCruiseReinforceTimer()
    stopCruiseCameraFollow()
    clearMouseReviveTimers()
    mouseGuardCleanup?.()
    mouseGuardCleanup = null
    for (const entry of faultVisuals.values()) stopFaultBlink(entry)
    faultVisuals.clear()
    faultTargets.clear()
    repairTargets.clear()
    hullCruise = null
    cruiseSnapshot = null
    cruiseClosing = false
    try {
      piclient?.__mouseReviveCleanup?.()
    } catch {
      /* ignore */
    }
    try {
      if (piclient?.cloudrender) piclient.cloudrender.destroy()
    } catch {
      /* ignore */
    }
    piclient = null
    cloudConnected = false
    emitScene()
  }

  return {
    connect,
    destroy,
    emit,
    enterPlayMode,
    reviveMouseInput,
    testWeather,
    probeObject,
    highlightFault,
    clearFaultVisuals,
    applyPhase,
    selectEquipmentTarget,
    selectActiveHull,
    flyToTag,
    flyToObjectId,
    listSceneObjects,
    refreshSceneObjects,
    beginHullCruise,
    advanceHullCruise,
    endHullCruise,
    isHullCruiseActive,
    getActiveHullId,
    getMode: () => mode,
    isCloudConnected: () => cloudConnected,
  }
}
