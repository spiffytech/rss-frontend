<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuthStore } from '@/client/stores/auth'

const auth = useAuthStore()

onMounted(() => {
  auth.check()
})
</script>

<template>
  <div v-if="auth.checking" class="min-h-dvh flex items-center justify-center text-gray-500 text-sm">
    Loading…
  </div>
  <RouterView v-else />
</template>
