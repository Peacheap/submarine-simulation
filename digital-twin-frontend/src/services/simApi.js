const API_BASE = import.meta.env.VITE_SIM_API_BASE || ''

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || (json.code != null && json.code !== 200)) {
    throw new Error(json.msg || json.message || `HTTP ${res.status} ${path}`)
  }
  return json.data !== undefined ? json.data : json
}

export const simApi = {
  getConfig: () => request('/mw/sim/config'),
  getPlans: () => request('/mw/sim/plans'),
  getPlan: (simuId) => request(`/mw/sim/plans/${simuId}`),
  getModelGroups: (modesId) => request(`/mw/sim/model-groups?id=${encodeURIComponent(modesId)}`),
  getEquipDetail: (treeId) => request(`/mw/sim/equip-detail/${treeId}`),
  getStatus: () => request('/mw/sim/status'),
  getSentinel: () => request('/mw/sim/sentinel'),
  startSentinel: () => request('/mw/sim/sentinel/on', { method: 'POST' }),
  startSim: (body) => request('/mw/sim/start', { method: 'POST', body: JSON.stringify(body) }),
  stopSim: (body) => request('/mw/sim/stop', { method: 'POST', body: JSON.stringify(body) }),
  mockStart: () => request('/mock/start', { method: 'POST' }),
  mockStop: () => request('/mock/stop', { method: 'POST' }),
  mockStatus: () => request('/mock/status'),
  mockConfig: (body) => request('/mock/config', { method: 'POST', body: JSON.stringify(body) }),
}

export function wsUrl(path) {
  if (import.meta.env.VITE_SIM_WS_BASE) {
    return `${import.meta.env.VITE_SIM_WS_BASE}${path}`
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // Dev: Vite proxy — connect to same host
  return `${proto}//${location.host}${path}`
}
