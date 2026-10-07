import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  createEmptyShelfFilter,
  TEMP_ZONES,
  type Shelf,
  type ShelfAssignResult,
  type ShelfFilterState,
  type ShelfOccupancy,
  type ShelfReshuffleMove,
  type ShelfReshuffleResult,
  type TempZone
} from '@/types/shelf'
import type { Batch } from '@/types/batch'
import { planReshuffle } from '@/utils/reshuffle'
import { useMilkStore } from '@/stores/milkStore'

export interface NewShelfInput {
  room: string
  rackNo: string
  layerNo: number
  tempZone: TempZone
  capacity: number
  occupied: number
}

/**
 * 熟成库窖位 store：维护货架列表、占用率派生值、当前选中库房与上架分配。
 * 上架时校验窖位余量并实时更新 occupied。
 */
export const useShelfStore = defineStore('shelf', () => {
  const shelvesTable = useIdbTable<Shelf>((database) => database.shelves, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()

  const prefs = readUiPrefs()
  const filter = ref<ShelfFilterState>(createEmptyShelfFilter())
  const currentRoom = ref<string>(prefs.lastRoom ?? '')
  const currentShelfId = ref<string | null>(null)

  const shelves = computed<Shelf[]>(() => shelvesTable.rows.value)
  const loading = computed(() => shelvesTable.loading.value)
  const ready = computed(() => shelvesTable.ready.value)
  const error = computed(() => shelvesTable.error.value)

  /** 库房选项（含「未指定」的空字符串过滤语义） */
  const roomOptions = computed<string[]>(() =>
    Array.from(new Set(shelves.value.map((shelf) => shelf.room))).sort()
  )

  /** 某窖位上的批次 */
  function batchesOfShelf(shelfId: string): Batch[] {
    return milkStore.batches.filter((batch) => batch.shelfId === shelfId)
  }

  /** 占用率：以「实际挂接的批次数」与 occupied 字段中的较大者为准，避免脏数据导致占用率偏低 */
  const occupancies = computed<ShelfOccupancy[]>(() =>
    shelves.value.map((shelf) => {
      const hosted = batchesOfShelf(shelf.id).length
      const occupied = Math.max(shelf.occupied, hosted)
      const free = Math.max(0, shelf.capacity - occupied)
      const percent = shelf.capacity === 0 ? 100 : Math.round((occupied / shelf.capacity) * 100)
      return {
        shelfId: shelf.id,
        capacity: shelf.capacity,
        occupied,
        free,
        percent,
        full: free === 0,
        tight: percent >= 85
      }
    })
  )

  const occupancyMap = computed<Record<string, ShelfOccupancy>>(() => {
    const map: Record<string, ShelfOccupancy> = {}
    occupancies.value.forEach((item) => {
      map[item.shelfId] = item
    })
    return map
  })

  /** 当前选中库房下的窖位 */
  const roomShelves = computed<Shelf[]>(() =>
    currentRoom.value ? shelves.value.filter((shelf) => shelf.room === currentRoom.value) : shelves.value
  )

  const filteredShelves = computed<Shelf[]>(() =>
    shelves.value.filter((shelf) => {
      if (currentRoom.value && shelf.room !== currentRoom.value) return false
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${shelf.room}${shelf.rackNo}${shelf.layerNo}${shelf.tempZone}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.rooms.length > 0 && !filter.value.rooms.includes(shelf.room)) return false
      if (filter.value.tempZones.length > 0 && !filter.value.tempZones.includes(shelf.tempZone)) {
        return false
      }
      return true
    })
  )

  const totalCapacity = computed(() =>
    filteredShelves.value.reduce((sum, shelf) => sum + shelf.capacity, 0)
  )
  const totalOccupied = computed(() =>
    filteredShelves.value.reduce(
      (sum, shelf) => sum + (occupancyMap.value[shelf.id]?.occupied ?? shelf.occupied),
      0
    )
  )
  const occupancyPercent = computed(() =>
    totalCapacity.value === 0 ? 0 : Math.round((totalOccupied.value / totalCapacity.value) * 100)
  )
  const fullShelfCount = computed(
    () => filteredShelves.value.filter((shelf) => occupancyMap.value[shelf.id]?.full).length
  )
  /** 未上架的批次（可分配窖位） */
  const unassignedBatches = computed<Batch[]>(() =>
    milkStore.batches.filter(
      (batch) => !batch.shelfId && batch.state !== '已出库' && batch.state !== '报废'
    )
  )

  function occupancyOf(shelfId: string | null): ShelfOccupancy | null {
    if (!shelfId) return null
    return occupancyMap.value[shelfId] ?? null
  }

  function shelfLabel(shelfId: string | null): string {
    if (!shelfId) return '未上架'
    const shelf = shelves.value.find((item) => item.id === shelfId)
    if (!shelf) return '窖位已删除'
    return `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层`
  }

  function setCurrentRoom(room: string): void {
    currentRoom.value = room
    writeUiPrefs({ ...readUiPrefs(), lastRoom: room || null })
  }

  function setCurrentShelf(id: string | null): void {
    currentShelfId.value = id
  }

  function patchFilter(patch: Partial<ShelfFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyShelfFilter()
  }

  async function createShelf(payload: NewShelfInput): Promise<Shelf> {
    return shelvesTable.create({ ...payload }, 'shelf')
  }

  async function updateShelf(id: string, patch: Partial<Shelf>): Promise<void> {
    await shelvesTable.update(id, patch)
  }

  /** 级联删除：窖位 → 解除批次挂接（批次本身保留） */
  async function removeShelf(id: string): Promise<void> {
    await db.transaction('rw', [db.shelves, db.batches], async () => {
      const hosted = await db.batches.where('shelfId').equals(id).toArray()
      for (const batch of hosted) {
        await db.batches.update(batch.id, { shelfId: null, updatedAt: Date.now() })
      }
      await db.shelves.delete(id)
    })
    if (currentShelfId.value === id) currentShelfId.value = null
  }

  /**
   * 上架：校验窖位余量 → 更新 occupied → 回写批次 shelfId。
   * 批次若已在别的窖位，会先从原窖位释放一块。
   */
  async function assignBatch(batchId: string, shelfId: string): Promise<ShelfAssignResult> {
    const shelf = shelves.value.find((item) => item.id === shelfId)
    if (!shelf) return { ok: false, message: '窖位不存在，请刷新后重试' }
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试' }
    if (batch.state === '已出库' || batch.state === '报废') {
      return { ok: false, message: `批次状态为「${batch.state}」，不能再上架` }
    }
    if (batch.shelfId === shelfId) return { ok: false, message: '该批次已在此窖位上' }

    // 余量校验以数据库中的最新占用数为准（并兜底取 store 中的较大值），避免快速连续上架时读到缓存值
    const [liveRow, hosted] = await Promise.all([
      db.shelves.get(shelfId),
      db.batches.where('shelfId').equals(shelfId).count()
    ])
    const live = liveRow ?? shelf
    const occupiedNow = Math.max(live.occupied, hosted, occupancyMap.value[shelfId]?.occupied ?? 0)
    if (occupiedNow >= live.capacity) {
      return {
        ok: false,
        message: `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层已满（${occupiedNow}/${live.capacity}），请先腾挪或改选窖位`
      }
    }

    const previousShelfId = batch.shelfId
    const now = Date.now()
    await db.transaction('rw', [db.shelves, db.batches], async () => {
      if (previousShelfId) {
        const previous = await db.shelves.get(previousShelfId)
        if (previous) {
          // 占用数按「移走后仍挂接在该窖位的批次数」重算，避免历史脏数据累积偏差
          const remaining = await db.batches
            .where('shelfId')
            .equals(previousShelfId)
            .and((item) => item.id !== batchId)
            .count()
          await db.shelves.update(previous.id, {
            occupied: Math.max(0, Math.min(previous.capacity, remaining)),
            updatedAt: now
          })
        }
      }
      await db.shelves.update(shelfId, {
        occupied: Math.min(live.capacity, occupiedNow + 1),
        updatedAt: now
      })
      await db.batches.update(batchId, {
        shelfId,
        state: batch.state === '凝乳' ? '熟成中' : batch.state,
        updatedAt: now
      })
    })

    return {
      ok: true,
      message: `已上架至 ${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层（${Math.min(
        live.capacity,
        occupiedNow + 1
      )}/${live.capacity}）`
    }
  }

  /** 下架：释放窖位占用并清空批次 shelfId */
  async function releaseBatch(batchId: string): Promise<ShelfAssignResult> {
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在，请刷新后重试' }
    if (!batch.shelfId) return { ok: false, message: '该批次尚未上架' }
    const shelfId = batch.shelfId
    const now = Date.now()
    await db.transaction('rw', [db.shelves, db.batches], async () => {
      const shelf = await db.shelves.get(shelfId)
      if (shelf) {
        const hosted = await db.batches.where('shelfId').equals(shelfId).count()
        const occupied = Math.max(0, Math.max(shelf.occupied, hosted) - 1)
        await db.shelves.update(shelfId, { occupied, updatedAt: now })
      }
      await db.batches.update(batchId, { shelfId: null, updatedAt: now })
    })
    return { ok: true, message: `已下架，${shelfLabel(shelfId)} 释放 1 块余量` }
  }

  /**
   * 整区换架：把同一温区内的若干「熟成中」批次一次性挪到新窖位（含两个窖位互换）。
   *
   * - 只允许同温区内存放；先在内存中按「实际在架批次数」规划物理挪位序列，
   *   任何中间步都会让窖位超出可放块数 / 整温区凑不出腾挪空位时直接拒绝，不写任何数据；
   * - 规划通过后在单个 rw 事务内落库：批次 shelfId、窖位 occupied（按实际挂接批次重算，
   *   顺带纠正脏占用数）、未执行（待执行）转架作业跟随到新窖位；
   * - 已完成 / 已跳过的转架作业保留当时窖位不动；事务失败由 Dexie 整体回滚，窖位与批次恢复原样。
   */
  async function reshuffleZone(moves: ShelfReshuffleMove[]): Promise<ShelfReshuffleResult> {
    if (moves.length === 0) {
      return { ok: false, message: '请先为至少一个批次选择新窖位' }
    }

    // 以数据库最新数据做规划，避免 store 缓存滞后
    const [liveBatches, liveShelves] = await Promise.all([
      db.batches.toArray(),
      db.shelves.toArray()
    ])
    const batchStates: Record<string, string> = {}
    liveBatches.forEach((batch) => {
      batchStates[batch.id] = batch.state
    })

    const plan = planReshuffle(moves, liveBatches, liveShelves, batchStates)
    if (!plan.ok) {
      return { ok: false, message: plan.message }
    }

    const movedBatchIds = plan.effectiveMoves.map((move) => move.batchId)
    const zoneShelfIds = new Set(
      liveShelves.filter((shelf) => shelf.tempZone === plan.zone).map((shelf) => shelf.id)
    )
    // 换架前各窖位实际在架批次数，用于识别需要纠正的脏占用数
    const hostedBefore = new Map<string, number>()
    zoneShelfIds.forEach((shelfId) => hostedBefore.set(shelfId, 0))
    liveBatches.forEach((batch) => {
      if (batch.shelfId && zoneShelfIds.has(batch.shelfId)) {
        hostedBefore.set(batch.shelfId, (hostedBefore.get(batch.shelfId) ?? 0) + 1)
      }
    })
    const reconciledShelfIds = new Set(
      [...zoneShelfIds].filter((shelfId) => {
        const shelf = liveShelves.find((item) => item.id === shelfId)
        return !!shelf && shelf.occupied !== Math.max(0, Math.min(shelf.capacity, hostedBefore.get(shelfId) ?? 0))
      })
    )
    const now = Date.now()

    try {
      let pendingTurningsUpdated = 0
      await db.transaction('rw', [db.shelves, db.batches, db.turnings], async () => {
        // 1. 批次落到新窖位（终态直接落，物理借位过程不落库——中间态由规划保证可行即可）
        for (const move of plan.effectiveMoves) {
          await db.batches.update(move.batchId, { shelfId: move.targetShelfId, updatedAt: now })
        }

        // 2. 未执行（待执行）转架作业跟随批次到新窖位；已完成 / 已跳过保留当时窖位
        const pendingTurnings = await db.turnings
          .where('batchId')
          .anyOf(movedBatchIds)
          .and((turning) => turning.state === '待执行')
          .toArray()
        const newShelfOf = new Map(plan.effectiveMoves.map((move) => [move.batchId, move.targetShelfId]))
        for (const turning of pendingTurnings) {
          const targetShelfId = newShelfOf.get(turning.batchId)
          if (targetShelfId && turning.shelfId !== targetShelfId) {
            await db.turnings.update(turning.id, { shelfId: targetShelfId, updatedAt: now })
            pendingTurningsUpdated += 1
          }
        }

        // 3. 全温区窖位占用数按「实际挂接批次数」重算，占用数与实际放着的批次严格对齐
        for (const shelfId of zoneShelfIds) {
          const shelf = await db.shelves.get(shelfId)
          if (!shelf) continue
          const hosted = await db.batches.where('shelfId').equals(shelfId).count()
          const occupied = Math.max(0, Math.min(shelf.capacity, hosted))
          if (shelf.occupied !== occupied) {
            await db.shelves.update(shelfId, { occupied, updatedAt: now })
          }
        }
      })

      const reconciled = reconciledShelfIds.size
      const swapText =
        plan.swappedPairs.length > 0 ? `，其中 ${plan.swappedPairs.length} 对窖位互换` : ''
      const bufferText =
        plan.bufferShelfIds.length > 0 ? `，借 ${plan.bufferShelfIds.length} 个空位腾挪` : ''
      const reconcileText = reconciled > 0 ? `；顺带纠正 ${reconciled} 个窖位的占用数` : ''
      const turningText =
        pendingTurningsUpdated > 0 ? `；${pendingTurningsUpdated} 条未执行转架作业已跟到新窖位` : ''
      return {
        ok: true,
        message: `${plan.zone}换架完成：${movedBatchIds.length} 个批次已就位${swapText}${bufferText}${turningText}${reconcileText}`,
        moved: movedBatchIds.length,
        swappedPairs: plan.swappedPairs.length,
        bufferShelves: plan.bufferShelfIds.length,
        reconciled,
        pendingTurningsUpdated,
        steps: plan.steps.length
      }
    } catch (err) {
      // 事务已整体回滚：批次 shelfId、窖位 occupied、转架作业均恢复原样
      return {
        ok: false,
        message: `换架写入失败，窖位与批次位置已恢复原样：${
          err instanceof Error ? err.message : '未知错误'
        }`
      }
    }
  }

  /** 按温区阈值给出窖位可用性说明，用于卡片提示 */
  function zoneOptions(): TempZone[] {
    return TEMP_ZONES
  }

  return {
    shelves,
    loading,
    ready,
    error,
    filter,
    currentRoom,
    currentShelfId,
    roomOptions,
    occupancies,
    occupancyMap,
    roomShelves,
    filteredShelves,
    totalCapacity,
    totalOccupied,
    occupancyPercent,
    fullShelfCount,
    unassignedBatches,
    occupancyOf,
    shelfLabel,
    batchesOfShelf,
    setCurrentRoom,
    setCurrentShelf,
    patchFilter,
    resetFilter,
    createShelf,
    updateShelf,
    removeShelf,
    assignBatch,
    releaseBatch,
    reshuffleZone,
    zoneOptions
  }
})

export type ShelfStore = ReturnType<typeof useShelfStore>
