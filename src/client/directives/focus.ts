// v-focus — focus an element when it is mounted. The rename editor is mounted
// conditionally via v-if/v-else, where the bare HTML `autofocus` attribute is
// unreliable in Vue (documented caveat); a mount-time directive is the correct
// way to land the cursor in the input when the editor opens.

import type { Directive } from 'vue'

export const vFocus: Directive<HTMLElement> = {
  mounted(el) {
    el.focus()
  },
}
