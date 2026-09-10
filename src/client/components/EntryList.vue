<script setup lang="ts">
import { useReaderStore } from '@/client/stores/reader'
import EntryItem from '@/client/components/EntryItem.vue'

const reader = useReaderStore()
</script>

<template>
  <div data-testid="entry-list" class="flex flex-col gap-y-1 pb-[100dvh]">
    <p v-if="reader.entries.length === 0" class="text-gray-500 text-sm px-2 py-4">
      No entries.
    </p>
    <EntryItem
      v-for="entry in reader.entries"
      :key="entry.id"
      :entry="entry"
    />
    <!-- End-of-list sentinel: v-intersect fires loadEnd when it scrolls into
         view — the next page while pagination remains, otherwise a tail
         recheck that auto-injects items that arrived since we last paginated.
         The 100dvh bottom padding on the list container ensures the last item
         can scroll all the way to the top of the scroll container. -->
    <div
      id="entry-sentinel"
      class="h-1 w-full"
      v-show="!reader.loadingMore"
      v-intersect
    ></div>
  </div>
</template>
