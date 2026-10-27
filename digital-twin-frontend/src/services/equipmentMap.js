import map from '@/config/equipment-map.json'

let activeHullId = map.defaultHullId || map.hulls?.[0]?.id || map.hull || null

export function listEquipments() {
  return map.equipments
}

export function listHulls() {
  return map.hulls || (map.hull ? [{ id: map.hull, label: map.hull, aliases: [map.hull] }] : [])
}

export function getActiveHullId() {
  return activeHullId
}

export function getActiveHull() {
  return listHulls().find((h) => h.id === activeHullId) || null
}

export function setActiveHullId(id) {
  const hull = listHulls().find((h) => h.id === id || h.aliases?.includes(id))
  if (!hull) return activeHullId
  activeHullId = hull.id
  return activeHullId
}

function resolveHullToken(token) {
  if (!token || token === '@activeHull') return activeHullId
  return token
}

export function resolveTargetByEquipmentName(name) {
  if (!name) return null
  const n = String(name).trim()
  for (const eq of map.equipments) {
    if (eq.equipmentName === n || eq.aliases?.includes(n) || n.includes(eq.equipmentName.replace(/-$/, ''))) {
      return resolveHullToken(eq.target)
    }
  }
  return null
}

export function resolveTargetByEquipmentId(id) {
  const eq = map.equipments.find((e) => e.equipmentId === String(id))
  return eq ? resolveHullToken(eq.target) : null
}

export function phaseBanner(phaseId) {
  return map.phases?.[String(phaseId)]?.banner ?? null
}

export function phaseName(phaseId) {
  return map.phases?.[String(phaseId)]?.name ?? String(phaseId)
}

export function allSceneTargets() {
  return [
    ...listHulls().map((h) => h.id),
    map.sceneRoot,
    map.hull,
    ...map.equipments.map((e) => resolveHullToken(e.target)),
    ...Object.values(map.cameras || {}),
    ...(map.waypoints || []),
    ...Object.values(map.phases || {}).map((p) => p.banner),
  ].filter(Boolean)
}

export default map
