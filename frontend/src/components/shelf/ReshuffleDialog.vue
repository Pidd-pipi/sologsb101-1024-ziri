<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Switch } from '@element-plus/icons-vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { useTurningStore } from '@/stores/turningStore'
import { planReshuffle } from '@/utils/reshuffle'
import { TEMP_ZONES, type ShelfReshuffleMove, type TempZone } from '@/types/shelf'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const shelfStore = useShelfStore()
const milkStore = useMilkStore()
const turningStore = useTurningStore()

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const zone = ref<TempZone>('冷区')
const submitting = ref(false)

/** batchId → 目标窖位 id（默认原位，提交时过滤空操作） */
const targets = ref<Record<string, string>>({})

const zoneShelves = computed(() =>
  shelfStore.shelves
    .filter((shelf) => shelf.tempZone === zone.value)
    .slice()
    .sort((a, b) =>
      a.room === b.room
        ? a.rackNo === b.rackNo
          ? a.layerNo - b.layerNo
          : a.rackNo.localeCompare(b.rackNo)
        : a.room.localeCompare(b.room)
    )
)

/** 温区内可挪动的批次：仅「熟成中」且已上架到本温区窖位 */
const movableBatches = computed(() =>
  milkStore.batches.filter(
    (batch) =>
      batch.state === '熟成中' &&
      batch.shelfId !== null &&
      shelfStore.shelves.some(
        (shelf) => shelf.id === batch.shelfId && shelf.tempZone === zone.value
      )
  )
)

const pendingCountOf = (batchId: string): number =>
  turningStore.turnings.filter(
    (turning) => turning.batchId === batchId && turning.state === '待执行'
  ).length

function initTargets(): void {
  const next: Record<string, string> = {}
  movableBatches.value.forEach((batch) => {
    if (batch.shelfId) next[batch.id] = batch.shelfId
  })
  targets.value = next
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) initTargets()
  }
)
watch(zone, () => initTargets())

function shelfLabel(shelfId: string): string {
  return shelfStore.shelfLabel(shelfId)
}

const moves = computed<ShelfReshuffleMove[]>(() =>
  movableBatches.value
    .filter((batch) => targets.value[batch.id] && targets.value[batch.id] !== batch.shelfId)
    .map((batch) => ({ batchId: batch.id, targetShelfId: targets.value[batch.id] }))
)

const evaluation = computed(() => {
  if (movableBatches.value.length === 0) {
    return { kind: 'info' as const, text: `${zone.value}内当前没有「熟成中」且在架的批次，无需换架。` }
  }
  if (moves.value.length === 0) {
    return { kind: 'info' as const, text: '所有批次都保持原位。给需要挪动的批次选择新窖位后即可安排换架。' }
  }
  const result = planReshuffle(
    moves.value,
    milkStore.batches.map((batch) => ({ id: batch.id, shelfId: batch.shelfId })),
    shelfStore.shelves.map((shelf) => ({
      id: shelf.id,
      tempZone: shelf.tempZone,
      capacity: shelf.capacity
    })),
    Object.fromEntries(milkStore.batches.map((batch) => [batch.id, batch.state]))
  )
  if (!result.ok) {
    return { kind: 'error' as const, text: result.message }
  }
  const pendingTotal = result.effectiveMoves.reduce(
    (sum, move) => sum + pendingCountOf(move.batchId),
    0
  )
  const details: string[] = []
  details.push(`${result.effectiveMoves.length} 个批次挪位`)
  if (result.swappedPairs.length > 0) details.push(`${result.swappedPairs.length} 对窖位互换`)
  if (result.bufferShelfIds.length > 0) {
    details.push(`需借 ${result.bufferShelfIds.length} 个空位腾挪（${result.bufferShelfIds.map(shelfLabel).join('、')}）`)
  }
  details.push(`共 ${result.steps.length} 步物理挪位，中间不超载`)
  if (pendingTotal > 0) details.push(`${pendingTotal} 条未执行转架作业会跟到新窖位`)
  return {
    kind: 'success' as const,
    text: `排布可行：${details.join('，')}。已完成 / 已跳过的转架作业保留当时窖位。`
  }
})

const canSubmit = computed(() => moves.value.length > 0 && evaluation.value.kind === 'success')

function resetTargets(): void {
  initTargets()
}

async function submit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    const result = await shelfStore.reshuffleZone(moves.value)
    if (result.ok) {
      ElMessage.success(result.message)
      dialogVisible.value = false
    } else {
      ElMessage.warning(result.message)
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    title="整区换架"
    width="820px"
    destroy-on-close
  >
    <el-alert type="info" :closable="false" show-icon class="reshuffle-tip">
      一次换架只在同一温区内安排：把批次挪到其他窖位，两个窖位可直接对调；系统会逐步校验可放块数，
      整温区凑不出腾挪空位或任何一步会超载时直接拒绝。换架中途失败则窖位与批次位置全部恢复原样。
    </el-alert>

    <div class="reshuffle-zone-bar">
      <span class="filter-label">温区</span>
      <el-radio-group v-model="zone">
        <el-radio-button v-for="item in TEMP_ZONES" :key="item" :value="item">
          {{ item }}
        </el-radio-button>
      </el-radio-group>
      <el-button text :icon="Refresh" @click="resetTargets">全部还原原位</el-button>
    </div>

    <el-table :data="movableBatches" border stripe size="small" empty-text="该温区没有熟成中的在架批次">
      <el-table-column label="批次" min-width="200">
        <template #default="{ row }">
          {{ milkStore.milkNameOf(row.milkId) }} · {{ row.cheeseType }} {{ row.curdedAt }}
        </template>
      </el-table-column>
      <el-table-column label="当前窖位" min-width="190">
        <template #default="{ row }">{{ shelfLabel(row.shelfId) }}</template>
      </el-table-column>
      <el-table-column label="待执行作业" width="100" align="center">
        <template #default="{ row }">{{ pendingCountOf(row.id) }} 条</template>
      </el-table-column>
      <el-table-column :label="`换至窖位（${zoneShelves.length} 个）`" min-width="240">
        <template #default="{ row }">
          <el-select v-model="targets[row.id]" placeholder="选择新窖位" style="width: 100%">
            <el-option
              v-for="shelf in zoneShelves"
              :key="shelf.id"
              :label="`${shelfLabel(shelf.id)}（可放 ${shelf.capacity}）`"
              :value="shelf.id"
            />
          </el-select>
        </template>
      </el-table-column>
    </el-table>

    <el-alert
      :type="evaluation.kind"
      :closable="false"
      show-icon
      class="reshuffle-eval"
    >
      {{ evaluation.text }}
    </el-alert>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :icon="Switch"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submit"
      >
        确认换架
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.reshuffle-tip {
  margin-bottom: 12px;
}

.reshuffle-zone-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.filter-label {
  font-size: 13px;
  color: #6b6257;
}

.reshuffle-eval {
  margin-top: 12px;
}
</style>
