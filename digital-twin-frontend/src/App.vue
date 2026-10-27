<script setup>
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="app-shell">
    <nav class="nav">
      <RouterLink to="/sim-verify">仿真验证</RouterLink>
      <span class="muted">导入说明：DigitalTwin/assets/IMPORT_TO_CIMPRO.md</span>
    </nav>
    <RouterView />
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0;
  min-height: 100%;
}
.app-shell {
  min-height: 100vh;
}
.nav {
  display: flex;
  gap: 16px;
  padding: 10px 24px;
  background: #0a101a;
  border-bottom: 1px solid #1e2a3c;
}
.nav a {
  color: #9ec5e8;
  text-decoration: none;
  font-size: 13px;
}
.nav a.router-link-active {
  color: #fff;
  font-weight: 600;
}
.nav .muted {
  color: #66788c;
  margin-left: auto;
}
</style>
