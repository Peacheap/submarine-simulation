<script setup>
import { RouterView } from 'vue-router'
</script>

<template>
  <div class="app-shell">
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
</style>
