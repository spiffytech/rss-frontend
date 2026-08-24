// Auth store: session state + login/logout. The SPA shows LoginView when
// unauthenticated and ReaderView otherwise.

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { createMinifluxReaderApi } from '@/client/api/reader'

const api = createMinifluxReaderApi()

export const useAuthStore = defineStore('auth', () => {
  const authenticated = ref(false)
  const username = ref<string | null>(null)
  const checking = ref(true)

  async function check() {
      const session = await api.session()
      authenticated.value = session.authenticated
      username.value = session.username ?? null
      checking.value = false
  }

  async function login(user: string, password: string) {
    await api.login(user, password)
    authenticated.value = true
    username.value = user
  }

  async function logout() {
    await api.logout()
    authenticated.value = false
    username.value = null
  }

  return { authenticated, username, checking, check, login, logout }
})
