import defaults from '@/config/equipment-map.json'

/** v2：默认空设备表；舰体可编辑并落盘 */
const STORAGE_KEY = 'digital-twin.equipment-tag-map.v2'
const LEGACY_STORAGE_KEY = 'digital-twin.equipment-tag-map.v1'
/** 误加的 v3 key，启动时清掉避免两套缓存 */
const MISTAKEN_V3_KEY = 'digital-twin.equipment-tag-map.v3'

/** @type {Array<{equipmentId:string, equipmentName:string, objectId:string, tag:string, aliases?:string[]}>} */
let equipments = []
/** @type {Array<{id:string, label:string, objectId:string, tag:string, aliases?:string[]}>} */
let hulls = []
let activeHullId = null

/** 旧数据 / 默认名 → 引擎 ObjectId（须在 boot 之前定义，避免 TDZ） */
const LEGACY_HULL_OBJECT_IDS = {
  hull_051c: 'SceneMeshObject_0',
  little_green: 'SceneMeshObject_1',
  hull_051c_tag: 'SceneMeshObject_0',
}

function boot() {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    // 若刚在 v3 里存过，迁回 v2 再删 v3
    const v3raw = localStorage.getItem(MISTAKEN_V3_KEY)
    if (v3raw && !localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, v3raw)
    }
    localStorage.removeItem(MISTAKEN_V3_KEY)
  } catch {
    /* ignore */
  }
  const stored = readStorage()
  equipments = normalizeEquipments(stored?.equipments ?? defaults.equipments)
  hulls = normalizeHulls(stored?.hulls ?? defaults.hulls)
  const preferred = stored?.activeHullId || defaults.defaultHullId || hulls[0]?.id || null
  activeHullId = resolveHullId(preferred) || hulls[0]?.id || null
}

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function persist() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      equipments,
      hulls,
      activeHullId,
    }),
  )
}

function normalizeEquipments(rows) {
  return (rows || []).map((e) => {
    let objectId = String(e.objectId || '').trim()
    const tag = String(e.tag || '').trim()
    // 兼容旧缓存：若 Tag 本身是 SceneMeshObject_*，当作 ObjectId
    if (!objectId && /^SceneMeshObject_/i.test(tag)) objectId = tag
    return {
      equipmentId: String(e.equipmentId || '').trim(),
      equipmentName: String(e.equipmentName || '').trim(),
      objectId,
      tag: /^SceneMeshObject_/i.test(tag) ? '' : tag,
      aliases: Array.isArray(e.aliases) ? [...e.aliases] : [],
    }
  })
}

function normalizeHulls(rows) {
  return (rows || [])
    .map((h) => {
      const label = String(h.label || h.name || '').trim()
      const id = String(h.id || label || '').trim()
      let objectId = String(h.objectId || '').trim()
      if (!objectId && /^SceneMeshObject_/i.test(id)) objectId = id
      if (!objectId && LEGACY_HULL_OBJECT_IDS[id]) objectId = LEGACY_HULL_OBJECT_IDS[id]
      // 兼容曾把 Tag 写成 hull_051c 的缓存：仍映射到已知 ObjectId
      const tag = String(h.tag || '').trim()
      if (!objectId && tag === 'hull_051c') objectId = 'SceneMeshObject_0'
      if (!objectId && tag === 'little_green') objectId = 'SceneMeshObject_1'
      if (!id && !objectId && !label) return null
      return {
        id: id || objectId || label,
        label: label || id || objectId,
        objectId,
        tag,
        aliases: Array.isArray(h.aliases) ? [...h.aliases] : [],
      }
    })
    .filter(Boolean)
}

function cloneDefaultEquipments() {
  return normalizeEquipments(defaults.equipments || [])
}

function cloneDefaultHulls() {
  return normalizeHulls(defaults.hulls || [])
}

function resolveHullId(idOrTagOrLabel) {
  if (idOrTagOrLabel == null || idOrTagOrLabel === '') return null
  const n = String(idOrTagOrLabel).trim()
  const hit = hulls.find(
    (h) =>
      h.id === n ||
      h.objectId === n ||
      h.tag === n ||
      h.label === n ||
      h.aliases?.includes(n),
  )
  return hit?.id || null
}

export function listEquipments() {
  return equipments.map((e) => ({ ...e }))
}

/** 页面可编辑副本：改完后调用 saveEquipments */
export function getEditableEquipments() {
  return equipments.map((e) => ({ ...e }))
}

export function saveEquipments(rows) {
  equipments = normalizeEquipments(rows)
    .map((e) => ({
      ...e,
      equipmentId: e.equipmentId.trim(),
      equipmentName: e.equipmentName.trim(),
      objectId: String(e.objectId || '').trim(),
      tag: String(e.tag || '').trim(),
      aliases: e.aliases.map((a) => String(a).trim()).filter(Boolean),
    }))
    .filter((e) => e.equipmentName || e.equipmentId)
  persist()
  return listEquipments()
}

export function resetEquipmentsToDefaults() {
  equipments = cloneDefaultEquipments()
  persist()
  return listEquipments()
}

export function listHulls() {
  return hulls.map((h) => ({ ...h }))
}

export function getEditableHulls() {
  return hulls.map((h) => ({ ...h, locked: true }))
}

export function saveHulls(rows) {
  hulls = normalizeHulls(rows)
    .map((h) => ({
      ...h,
      id: String(h.id || h.objectId || h.label).trim(),
      label: String(h.label || h.id || h.objectId).trim(),
      objectId: String(h.objectId || '').trim(),
      tag: String(h.tag || '').trim(),
      aliases: (h.aliases || []).map((a) => String(a).trim()).filter(Boolean),
    }))
    .filter((h) => h.label || h.objectId || h.id)
  hulls = hulls.map((h) => ({
    ...h,
    id: h.id || h.objectId || h.label,
  }))
  if (!resolveHullId(activeHullId)) {
    activeHullId = hulls[0]?.id || null
  }
  persist()
  return listHulls()
}

export function resetHullsToDefaults() {
  hulls = cloneDefaultHulls()
  activeHullId = defaults.defaultHullId || hulls[0]?.id || null
  persist()
  return listHulls()
}

export function getActiveHullId() {
  return activeHullId
}

export function getActiveHull() {
  return listHulls().find((h) => h.id === activeHullId) || null
}

export function setActiveHullId(id) {
  const resolved = resolveHullId(id)
  if (!resolved) return activeHullId
  activeHullId = resolved
  persist()
  return activeHullId
}

function matchEquipment(nameOrId) {
  if (nameOrId == null || nameOrId === '') return null
  const n = String(nameOrId).trim()
  for (const eq of equipments) {
    if (eq.equipmentId && eq.equipmentId === n) return eq
    if (eq.equipmentName === n) return eq
    if (eq.aliases?.includes(n)) return eq
    if (eq.equipmentName && n.includes(eq.equipmentName.replace(/-$/, ''))) return eq
  }
  return null
}

/**
 * 解析仿真设备 → 孪生绑定
 * @returns {{ equipmentId:string, equipmentName:string, tag:string } | null}
 */
export function resolveBinding(nameOrId) {
  const eq = matchEquipment(nameOrId)
  if (!eq) return null
  return {
    equipmentId: eq.equipmentId,
    equipmentName: eq.equipmentName,
    objectId: eq.objectId || '',
    tag: eq.tag || '',
  }
}

/** @deprecated 兼容旧调用：优先 ObjectId，否则 tag，再回退 activeHull */
export function resolveTargetByEquipmentName(name) {
  const b = resolveBinding(name)
  if (!b) return null
  return b.objectId || b.tag || activeHullId
}

export function resolveTargetByEquipmentId(id) {
  return resolveTargetByEquipmentName(id)
}

export function phaseBanner(phaseId) {
  return defaults.phases?.[String(phaseId)]?.banner ?? null
}

export function phaseName(phaseId) {
  return defaults.phases?.[String(phaseId)]?.name ?? String(phaseId)
}

export function allSceneTargets() {
  return [
    ...hulls.map((h) => h.objectId || h.id),
    defaults.sceneRoot,
    defaults.hull,
    ...equipments.map((e) => e.objectId || e.tag).filter(Boolean),
    ...Object.values(defaults.cameras || {}),
    ...(defaults.waypoints || []),
    ...Object.values(defaults.phases || {}).map((p) => p.banner),
  ].filter(Boolean)
}

boot()

export default defaults
