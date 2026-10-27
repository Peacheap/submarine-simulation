import { createRouter, createWebHistory } from 'vue-router'
import SimVerifyView from '@/views/SimVerifyView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/sim-verify' },
    { path: '/sim-verify', name: 'sim-verify', component: SimVerifyView },
  ],
})

export default router
