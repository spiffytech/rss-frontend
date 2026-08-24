import { createRouter, createWebHistory } from 'vue-router'

import ReaderView from '@/client/views/ReaderView.vue'
import LoginView from '@/client/views/LoginView.vue'
import { useAuthStore } from '@/client/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'reader', component: ReaderView },
    { path: '/login', name: 'login', component: LoginView },
    // Dead feed 404 handled in ReaderView (feed id in query that doesn't exist).
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

// Auth gate: the reader requires a session; the login page is public.
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (auth.checking) {
    await auth.check()
  }
  if (to.name === 'login' && auth.authenticated) {
    return { name: 'reader' }
  }
  if (to.name === 'reader' && !auth.authenticated) {
    return { name: 'login' }
  }
  return true
})

export default router
