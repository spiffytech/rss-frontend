<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/client/stores/auth'

const auth = useAuthStore()
const router = useRouter()

const username = ref('')
const password = ref('')
const error = ref('')
const submitting = ref(false)

async function onSubmit() {
  error.value = ''
  submitting.value = true
  try {
    await auth.login(username.value, password.value)
    router.push({ name: 'reader' })
  } catch {
    error.value = 'Sign-in failed. Check your credentials.'
    password.value = ''
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="min-h-dvh bg-gray-50 text-gray-900 flex items-center justify-center p-4">
    <form
      class="login-card bg-white border border-gray-200 rounded-lg shadow-sm p-8 flex flex-col gap-6 w-full max-w-sm"
      @submit.prevent="onSubmit"
    >
      <div class="flex flex-col items-center gap-3 text-center">
        <svg aria-hidden="true" viewBox="0 0 32 32" class="w-14 h-14">
          <rect width="32" height="32" rx="6" fill="#0e7490" />
          <text x="16" y="22" font-size="18" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="white">M</text>
        </svg>
        <div class="flex flex-col gap-1.5">
          <h1 class="text-lg font-semibold leading-6">Sign in to Miniflux Reader</h1>
          <p class="text-sm text-gray-500 leading-5">
            Uses your Miniflux username and password. A session-only API key is created for this browser and revoked on logout.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-4">
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          <span>Miniflux username</span>
          <input
            v-model="username"
            name="username"
            required
            autocomplete="username"
            class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
          />
        </label>
        <label class="flex flex-col gap-1.5 text-sm font-medium">
          <span>Miniflux password</span>
          <input
            v-model="password"
            name="password"
            type="password"
            required
            autocomplete="current-password"
            class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
          />
        </label>
      </div>

      <button
        type="submit"
        :disabled="submitting"
        class="self-center min-w-40 w-full sm:w-auto bg-cyan-700 text-white rounded-full px-10 py-2.5 font-medium shadow-sm hover:bg-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 focus-visible:ring-offset-2 active:bg-cyan-900 active:translate-y-px disabled:opacity-60 disabled:translate-y-0"
      >
        <span class="inline-flex items-center gap-2 justify-center">Sign in</span>
      </button>

      <p v-if="error" id="err" role="alert" class="text-sm text-red-600">{{ error }}</p>
    </form>
  </main>
</template>

<style scoped>
/* One authored entrance: the card rises and fades from an already-visible
   default. Reduced-motion users get the static composited state. */
@media (prefers-reduced-motion: no-preference) {
  .login-card {
    animation: login-rise 420ms cubic-bezier(0.16, 1, 0.3, 1);
  }
}
@keyframes login-rise {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
