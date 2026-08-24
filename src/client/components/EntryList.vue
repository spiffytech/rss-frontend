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
    <!-- Infinite-scroll sentinel: v-intersect fires the loadMore when it
         scrolls into view. The 100dvh bottom padding on the list container
         ensures the last item can scroll all the way to the top of the
         scroll container. -->
    <div
      id="entry-sentinel"
      class="h-1 w-full"
      v-show="reader.hasMore && !reader.loadingMore"
      v-intersect
    ></div>
  </div>
</template>
