<script setup lang="ts">
import { useFeedsStore } from '@/client/stores/feeds'

const props = defineProps<{ feedId: number; title: string }>()

const feeds = useFeedsStore()
</script>

<template>
  <span class="inline-flex items-center shrink-0 relative w-5 h-5" aria-hidden="true">
    <img
      v-show="!feeds.iconFailed[props.feedId]"
      :src="`/api/miniflux/feeds/${props.feedId}/icon`"
      alt=""
      class="w-5 h-5 rounded-sm"
      loading="lazy"
      @error="feeds.markIconFailed(props.feedId)"
    />
    <span
      v-if="feeds.iconFailed[props.feedId]"
      class="absolute inset-0 inline-flex items-center justify-center rounded-sm bg-gray-200 text-gray-600 text-xs font-semibold"
    >
      {{ (props.title.trim()[0] ?? '?').toUpperCase() }}
    </span>
  </span>
</template>
