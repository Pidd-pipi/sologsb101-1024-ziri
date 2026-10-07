import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { db } from '../src/utils/db.ts'
import { useShelfStore } from '../src/stores/shelfStore.ts'
import type { Shelf } from '../src/types/shelf.ts'
import type { Batch } from '../src/types/batch.ts'
import type { Turning } from '../src/types/turning.ts'

let passed = 0
let failed = 0
function assert(cond: boolean, message: string): void {
  if (cond) passed += 1
  else {
    failed += 1
    console.error(`✗ ${message}`)
  }
}

const now = Date.UTC(2025, 2, 1, 8, 0, 0)

function shelf(id: string, zone: string, capacity: number, occupied: number): Shelf {
  return {
    id,
    room: '一号熟成库',
    rackNo: id,
    layerNo: 1,
    tempZone: zone as Shelf['tempZone'],
    capacity,
    occupied,
    createdAt: now,
    updatedAt: now
  }
}
function batch(id: string, shelfId: string | null, state: Batch['state'] = '熟成中'): Batch {
  return {
    id,
    milkId: 'milk_x',
    curdedAt: '2025-03-10',
    cheeseType: '硬质',
    targetDays: 90,
    weightKg: 5,
    state,
    shelfId,
    conclusion: '',
    createdAt: now,
    updatedAt: now
  }
}
function turning(
  id: string,
  batchId: string,
  shelfId: string,
  state: Turning['state']
): Turning {
  return {
    id,
    batchId,
    shelfId,
    doneAt: '2025-04-01',
    type: '转架',
    brinePct: 18,
    operator: '陈默',
    state,
    seq: 1,
    createdAt: now,
    updatedAt: now
  }
}

async function seed(): Promise<void> {
  await db.transaction(
    'rw',
    [db.milks, db.batches, db.shelves, db.turnings, db.environments, db.tastings],
    async () => {
      await db.milks.bulkPut([
        {
          id: 'milk_x',
          farm: '测试牧场',
          milkKind: '牛',
          collectedAt: '2025-03-01',
          fatPct: 4,
          proteinPct: 3.4,
          note: '',
          createdAt: now,
          updatedAt: now
        }
      ])
      // 冷区：S1/S2 各 capacity 1 且各放 1（要对调），S3 capacity 2 放 1（有空位可借）
      await db.shelves.bulkPut([
        shelf('S1', '冷区', 1, 1),
        shelf('S2', '冷区', 1, 1),
        shelf('S3', '冷区', 2, 1),
        shelf('M1', '中温区', 2, 0)
      ])
      await db.batches.bulkPut([
        batch('A', 'S1'),
        batch('B', 'S2'),
        batch('C', 'S3'),
        batch('D', null),
        batch('E', null, '已出库'),
        batch('F', 'M1', '已出库')
      ])
      // A 的待执行作业在 S1、已完成作业也在 S1；B 的待执行作业在 S2
      await db.turnings.bulkPut([
        turning('tA_pending', 'A', 'S1', '待执行'),
        turning('tA_done', 'A', 'S1', '已完成'),
        turning('tA_skip', 'A', 'S1', '已跳过'),
        turning('tB_pending', 'B', 'S2', '待执行')
      ])
    }
  )
}

async function snapshot() {
  const batches = Object.fromEntries((await db.batches.toArray()).map((b) => [b.id, b.shelfId]))
  const shelves = Object.fromEntries(
    (await db.shelves.toArray()).map((s) => [s.id, { occupied: s.occupied, capacity: s.capacity }])
  )
  const turnings = Object.fromEntries(
    (await db.turnings.toArray()).map((t) => [t.id, { shelfId: t.shelfId, state: t.state }])
  )
  return { batches, shelves, turnings }
}

setActivePinia(createPinia())
await db.open()
await seed()
const store = useShelfStore()
// 等 liveQuery 首屏
await new Promise((resolve) => setTimeout(resolve, 50))

// —— 场景 1：A、B 对调 ——
const result = await store.reshuffleZone([
  { batchId: 'A', targetShelfId: 'S2' },
  { batchId: 'B', targetShelfId: 'S1' }
])
assert(result.ok, `场景1：对调应成功：${result.ok ? '' : result.message}`)
assert(result.swappedPairs === 1, '场景1：1 对互换')
assert(result.moved === 2, '场景1：移动 2 个批次')

const after1 = await snapshot()
assert(after1.batches.A === 'S2', '场景1：A 已在 S2')
assert(after1.batches.B === 'S1', '场景1：B 已在 S1')
assert(after1.batches.C === 'S3', '场景1：C 未受影响')
assert(after1.batches.E === null, '场景1：未上架的已出库批次 E 不受影响')
assert(after1.shelves.S1.occupied === 1, '场景1：S1 占用 1（B）')
assert(after1.shelves.S2.occupied === 1, '场景1：S2 占用 1（A）')
assert(after1.shelves.S3.occupied === 1, '场景1：S3 占用 1（借位后恢复为 C）')
assert(after1.turnings.tA_pending.shelfId === 'S2', '场景1：A 待执行作业跟到 S2')
assert(after1.turnings.tA_done.shelfId === 'S1', '场景1：A 已完成作业保留当时窖位 S1')
assert(after1.turnings.tA_skip.shelfId === 'S1', '场景1：A 已跳过作业保留当时窖位 S1')
assert(after1.turnings.tB_pending.shelfId === 'S1', '场景1：B 待执行作业跟到 S1')

// —— 场景 2：拒绝跨温区（A 现在 S2，想挪去中温区 M1）——
const before2 = await snapshot()
const result2 = await store.reshuffleZone([{ batchId: 'A', targetShelfId: 'M1' }])
assert(!result2.ok, '场景2：跨温区应拒绝')
const after2 = await snapshot()
assert(JSON.stringify(before2) === JSON.stringify(after2), '场景2：拒绝后数据完全不变')

// —— 场景 3：拒绝非熟成中批次（F 已出库，虽挂在中温区 M1）——
const result3 = await store.reshuffleZone([
  { batchId: 'F', targetShelfId: 'M1' }
])
assert(!result3.ok, '场景3：已出库批次换架应拒绝')

// —— 场景 4：整温区占满 → 容量不够。把 S3 也放满：C 已在 S3，再把 D 上架到 S3 ——
await db.transaction('rw', [db.shelves, db.batches], async () => {
  await db.batches.update('D', { shelfId: 'S3' })
  await db.shelves.update('S3', { occupied: 2 })
})
await new Promise((resolve) => setTimeout(resolve, 30))
// 此时冷区：S1 容量1（B,E 两挂接脏数据），S2 容量1（A），S3 容量2（C,D）→ 实际挂接 5 > 总容量 4
const before4 = await snapshot()
const result4 = await store.reshuffleZone([
  { batchId: 'A', targetShelfId: 'S3' },
  { batchId: 'C', targetShelfId: 'S2' }
])
assert(!result4.ok && /容量|超过|超载/.test(result4.message), `场景4：放不下应拒绝：${result4.message}`)
const after4 = await snapshot()
assert(JSON.stringify(before4) === JSON.stringify(after4), '场景4：拒绝后数据完全不变')

// —— 场景 5：挪到自身窖位的空操作 + 一个真实挪动（腾出 S3 后 A→S3）——
await db.transaction('rw', [db.shelves, db.batches], async () => {
  await db.batches.update('D', { shelfId: null })
  await db.shelves.update('S3', { occupied: 1 })
})
await new Promise((resolve) => setTimeout(resolve, 30))
const result5 = await store.reshuffleZone([
  { batchId: 'A', targetShelfId: 'S3' },
  { batchId: 'B', targetShelfId: 'S1' }
])
assert(result5.ok, `场景5：真实单挪 + 空操作应成功：${result5.ok ? '' : result5.message}`)
assert(result5.moved === 1, '场景5：只算 1 个批次挪动')
const after5 = await snapshot()
assert(after5.batches.A === 'S3' && after5.batches.B === 'S1', '场景5：终态位置正确')
assert(after5.turnings.tA_pending.shelfId === 'S3', '场景5：A 待执行作业跟到 S3')
assert(after5.turnings.tA_done.shelfId === 'S1', '场景5：已完成作业仍保留 S1')
assert(after5.shelves.S2.occupied === 0, '场景5：S2 腾空后占用为 0')
assert(after5.shelves.S3.occupied === 2, '场景5：S3 占用为 2（A、C）')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
