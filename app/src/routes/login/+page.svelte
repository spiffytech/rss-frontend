<script lang="ts">
  // LoginView — ported from the old LoginView.vue (structure and classes
  // verbatim). One truthful deviation: the copy no longer claims a session-only
  // Miniflux API key — sessions here are HMAC-signed cookies on this server.
  import { goto } from '$app/navigation'

  import { api } from '../../client/api.js'

  let username = $state('')
  let password = $state('')
  let error = $state('')
  let submitting = $state(false)

  async function onSubmit(e: Event) {
    e.preventDefault()
    error = ''
    submitting = true
    try {
      await api.login(username, password)
      await goto('/')
    } catch {
      error = 'Sign-in failed. Check your credentials.'
      password = ''
    } finally {
      submitting = false
    }
  }
</script>

<main class="min-h-dvh bg-gray-50 text-gray-900 flex items-center justify-center p-4">
  <form
    class="login-card bg-white border border-gray-200 rounded-lg shadow-sm p-8 flex flex-col gap-6 w-full max-w-sm"
    onsubmit={onSubmit}
  >
    <div class="flex flex-col items-center gap-3 text-center">
      <svg aria-hidden="true" viewBox="0 0 32 32" class="w-14 h-14">
        <rect width="32" height="32" rx="6" fill="#0e7490" />
        <text x="16" y="22" font-size="18" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="white">M</text>
      </svg>
      <div class="flex flex-col gap-1.5">
        <h1 class="text-lg font-semibold leading-6">Sign in to Miniflux Reader</h1>
        <p class="text-sm text-gray-500 leading-5">
          Uses your reader username and password. Sessions are cookie-based and expire after 30 days; signing out clears this browser's session.
        </p>
      </div>
    </div>

    <div class="flex flex-col gap-4">
      <label class="flex flex-col gap-1.5 text-sm font-medium">
        <span>Username</span>
        <input
          name="username"
          required
          autocomplete="username"
          class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
          bind:value={username}
        />
      </label>
      <label class="flex flex-col gap-1.5 text-sm font-medium">
        <span>Password</span>
        <input
          name="password"
          type="password"
          required
          autocomplete="current-password"
          class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
          bind:value={password}
        />
      </label>
    </div>

    {#if error}<p id="err" role="alert" class="text-sm text-red-600">{error}</p>{/if}

    <button
      type="submit"
      disabled={submitting}
      class="self-center min-w-40 w-full sm:w-auto bg-cyan-700 text-white rounded-full px-10 py-2.5 font-medium shadow-sm hover:bg-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 focus-visible:ring-offset-2 active:bg-cyan-900 active:translate-y-px disabled:opacity-60 disabled:translate-y-0"
    >
      Sign in
    </button>
  </form>
</main>

<style>
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
  }
</style>
