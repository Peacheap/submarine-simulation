/**
 * TwinMaster (PiClient) bridge — cloud path aligned with 前端示例/pixel.html.
 * - preview: no CIMPro
 * - embed: pageReady() inside CIMPro webview
 * - cloud: UMD PiClientJS + lib-pixelstreamingfrontend (NOT ESM)
 */

import {
  getActiveHullId,
  phaseBanner,
  resolveTargetByEquipmentName,
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

export function createTwinBridge({ onLog, onSceneState } = {}) {
  let piclient = null
  let mode = 'preview'
  let cloudConnected = false
  /** displayName / 逻辑名 → 引擎 ObjectId */
  const objectIdCache = new Map()
  const faultTargets = new Set()
  const repairTargets = new Set()
  let currentPhase = null
  let selectedTarget = null

  const log = (msg, level = 'info') => onLog?.({ msg, level, at: Date.now() })

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

  function bindCommonListeners() {
    if (!piclient) return
    piclient.on('cloud.init', '', (res) => {
      log(`cloud.init ${JSON.stringify(res)}`)
    })
    piclient.on('object.onClick', '', (res) => {
      selectedTarget = res?.target || res?.params?.objects?.[0] || null
      if (selectedTarget) objectIdCache.set(String(selectedTarget), String(selectedTarget))
      log(`场景点击: ${selectedTarget} | ${JSON.stringify(res)}`)
      emitScene()
    })
    piclient.on('object.onSelect', '', (res) => {
      const id = pickObjectId(res)
      if (id) objectIdCache.set(String(id), String(id))
      log(`对象选择: ${JSON.stringify(res)}`)
    })
    piclient.on('object.getInfo', '', (res) => {
      log(`object.getInfo 回调: ${JSON.stringify(res)}`)
    })
    piclient.on('global', '', (res) => {
      log(`<全局> ${JSON.stringify(res)}`)
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

  async function flyToTarget(logicalOrId) {
    const objectId = await resolveObjectId(logicalOrId)
    if (!objectId) return null

    // 不等待客户端 Promise 结束；focus + fly 快速连发
    void emit('camera.focus', { target: objectId })
    void emit('camera.fly', { target: objectId, time: '2.0' })
    log(`相机对准 ${logicalOrId} (id=${objectId})`)
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
    log('已 enterPlayMode + 隐藏客户端 UI')
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

    // 官方 connect 成功后立刻 togglePlay
    await enterPlayMode()

    emitScene()
    return { mode, baseDb }
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => {
        setTimeout(() => {
          log(`${label || '操作'} 超时 ${ms}ms（已继续，不阻塞界面）`, 'warn')
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

  async function highlightFault(equipmentName, status) {
    // 设备映射到 @activeHull → 始终作用到当前选中舰
    const target = resolveTargetByEquipmentName(equipmentName) || getActiveHullId()
    if (!target) {
      log(`未映射设备: ${equipmentName}`, 'warn')
      return
    }
    const objectId = await resolveObjectId(target)
    if (status === 'FAULT_OCCUR' || status === 'FAULT') {
      faultTargets.add(target)
      repairTargets.delete(target)
      await emit('object.visible', { target: objectId, visible: 'show' })
      await flyToTarget(target)
    } else if (status === 'REPAIR_START') {
      repairTargets.add(target)
      await emit('object.visible', { target: objectId, visible: 'show' })
    } else if (status === 'REPAIR_END') {
      faultTargets.delete(target)
      repairTargets.delete(target)
    }
    log(`故障视觉 ${status} → ${target}/${objectId} (${equipmentName})`, 'fault')
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
    selectedTarget = id
    log(`切换当前舰体 → ${id}`)
    emitScene()
    if (fly) await flyToTarget(id)
    return id
  }

  async function selectEquipmentTarget(target) {
    // 设备映射为 @activeHull 时，一律飞到当前选中舰
    const resolved =
      !target || target === '@activeHull' ? getActiveHullId() : setActiveHullId(target) || target
    selectedTarget = resolved
    await flyToTarget(resolved)
    emitScene()
  }

  /** 手动探测大纲名 → ObjectId，结果写进联调日志 */
  async function probeObject(displayName) {
    const name = displayName || getActiveHullId() || 'Sub_Hull_051C'
    objectIdCache.delete(name)
    const id = await resolveObjectId(name)
    log(`探测 ${name} → ${id || '失败'}`)
    return id
  }

  /** 官方示例里的天气测试，用来确认 emit 通道真通了 */
  async function testWeather(weather = 1) {
    await emit('environment.setWeather', { weather })
    log(`测试 emit environment.setWeather=${weather}`)
  }

  function destroy() {
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
    testWeather,
    probeObject,
    highlightFault,
    applyPhase,
    selectEquipmentTarget,
    selectActiveHull,
    getActiveHullId,
    getMode: () => mode,
    isCloudConnected: () => cloudConnected,
  }
}
