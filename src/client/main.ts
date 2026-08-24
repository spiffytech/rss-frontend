import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import '@/client/style.css'
import { vTrackTop } from '@/client/directives/track-top'
import { vIntersectLine } from '@/client/directives/intersect-line'
import { vIntersect } from '@/client/directives/intersect'
import { vFocus } from '@/client/directives/focus'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.directive('track-top', vTrackTop)
app.directive('intersect-line', vIntersectLine)
app.directive('intersect', vIntersect)
app.directive('focus', vFocus)

app.mount('#app')

// PWA: satisfies installability, does no caching (same sw.js as before).
navigator.serviceWorker?.register('/sw.js')
