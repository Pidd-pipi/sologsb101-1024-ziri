import 'fake-indexeddb/auto'
import { setActivePinia, createPinia } from 'pinia'
import { db, seedDatabase, createId } from '../src/utils/db.ts'
import { useShelfStore } from '../src/stores/shelfStore.ts'

let passed = 0
let failed = 0
function assert(cond: boolean, message: string): void {
  if (cond) passed += 1
  else {
    failed += 1
    console.error(`✗ ${message}`)
  }
}

const now = Date.now()
function shelf(id: string, zone: string, capacity: number, occupied = 0) {
  return { id, room: '一号熟成库', rackNo: id, layerNo: 1, tempZone: zone, capacity, occupied, createdAt: now, updatedAt: now }
}
function batch(id: string, shelfId: string | null, state = '熟成中') {
  return { id, milkId: 'm1', curdedAt: '2025-03-10', cheeseType: '硬质', targetDays: 90, weightKg: 5, state, shelfId, conclusion: '', createdAt: now, updatedAt: now }
}
function turning(id: string, batchId: string, shelfId: string, state: string) {
  return { id, batchId, shelfId, doneAt: '2025-04-01', type: '转架', brinePct: 10, operator: 'x', state, seq: 1, createdAt: now, updatedAt: now }
}

async function reset() {
  await db.open()
  await db.milks.clear()
  await db.batches.clear()
  await db.shelves.clear()
  await db.turnings.clear()
  await db.environments.clear()
  await db.tastings.clear()
}

setActivePinia(createPinia())
const store = useShelfStore()
await new Promise((resolve) => setTimeout(resolve, 300)) // 等 liveQuery 首载

// 端到端 1：冷区两满窖位对调 + 有余量窖位做缓冲；待执行作业跟随、已完成保留
await reset()
await db.milks.add({
  id: 'm1', farm: '牧场', milkKind: '牛', collectedAt: '2025-03-01', fatPct: 4, proteinPct: 3, note: '', createdAt: now, updatedAt: now
} as any)
await db.shelves.bulkPut([shelf('A', '冷区', 1, 1), shelf('B', '冷区', 1, 1), shelf('C', '冷区', 2, 0)])
await db.batches.bulkPut([batch('b1', 'A'), batch('b2', 'B')])
await db.turnings.bulkPut([
  turning('t1', 'b1', 'A', '待执行'),
  turning('t2', 'b1', 'A', '已完成'),
  turning('t3', 'b2', 'B', '已跳过')
])

const r1 = await store.reshuffleZone('冷区', [
  { batchId: 'b1', targetShelfId: 'B' },
  { batchId: 'b2', targetShelfId: 'A' }
])
assert(r1.ok, `E2E1 成功: ${r1.ok ? '' : r1.message}`)
assert(r1.plan?.swapPairCount === 1, 'E2E1 识别对调')
assert((await db.batches.get('b1'))?.shelfId === 'B', 'E2E1 b1 到 B')
assert((await db.batches.get('b2'))?.shelfId === 'A', 'E2E1 b2 到 A')
assert((await db.shelves.get('A'))?.occupied === 1, 'E2E1 A occupied=1')
assert((await db.shelves.get('B'))?.occupied === 1, 'E2E1 B occupied=1')
assert((await db.shelves.get('C'))?.occupied === 0, 'E2E1 缓冲窖位 C 最终为空')
assert((await db.turnings.get('t1'))?.shelfId === 'B', 'E2E1 待执行作业跟到新窖位 B')
assert((await db.turnings.get('t2'))?.shelfId === 'A', 'E2E1 已完成作业保留当时窖位 A')
assert((await db.turnings.get('t3'))?.shelfId === 'B', 'E2E1 已跳过作业保留当时窖位 B')

// 端到端 2：整温区满、无缓冲 → 拒绝，且数据原样
await reset()
await db.shelves.bulkPut([shelf('A', '冷区', 1, 1), shelf('B', '冷区', 1, 1)])
await db.batches.bulkPut([batch('b1', 'A'), batch('b2', 'B')])
const r2 = await store.reshuffleZone('冷区', [
  { batchId: 'b1', targetShelfId: 'B' },
  { batchId: 'b2', targetShelfId: 'A' }
])
assert(!r2.ok && /容量不够/.test(r2.message), `E2E2 容量不够被拒绝: ${r2.ok ? 'ok' : r2.message}`)
assert((await db.batches.get('b1'))?.shelfId === 'A', 'E2E2 b1 仍在 A')
assert((await db.batches.get('b2'))?.shelfId === 'B', 'E2E2 b2 仍在 B')
assert((await db.shelves.get('A'))?.occupied === 1 && (await db.shelves.get('B'))?.occupied === 1, 'E2E2 占用数未变')

// 端到端 3：规划通过但事务执行前数据被并发改动 → 事务中止、恢复原样
await reset()
await db.shelves.bulkPut([shelf('A', '冷区', 1, 1), shelf('B', '冷区', 2, 1), shelf('C', '冷区', 2, 0)])
await db.batches.bulkPut([batch('b1', 'A'), batch('b2', 'B')])
// 让 store 用最新 live 数据规划成功；通过把 b1 并发置为已出库，触发事务内复核失败
const originalToarray = db.batches.toArray.bind(db.batches)
let firstCall = true
;(db.batches as any).toArray = async () => {
  const rows = await originalToarray()
  if (firstCall) {
    firstCall = false
    // 规划读取之后、事务之前并发改动
    await db.batches.update('b1', { state: '已出库' })
  }
  return rows
}
const r3 = await store.reshuffleZone('冷区', [
  { batchId: 'b1', targetShelfId: 'B' },
  { batchId: 'b2', targetShelfId: 'C' }
])
;(db.batches as any).toArray = originalToarray
assert(!r3.ok, `E2E3 被复核拒绝: ${r3.ok ? 'ok' : r3.message}`)
// b1 状态为已出库（并发改动保留），shelfId 不应被换架动作改动
assert((await db.batches.get('b1'))?.shelfId === 'A', 'E2E3 b1 窖位未被中途改写')
assert((await db.batches.get('b2'))?.shelfId === 'B', 'E2E3 b2 窖位未被中途改写')
assert((await db.shelves.get('A'))?.occupied === 1, 'E2E3 A occupied 未变')
assert((await db.shelves.get('B'))?.occupied === 1, 'E2E3 B occupied 未变')
assert((await db.shelves.get('C'))?.occupied === 0, 'E2E3 C occupied 未变')

// 端到端 4：占用数字段脏（与实际不符）→ 换架后重算与实际一致
await reset()
await db.shelves.bulkPut([shelf('A', '冷区', 4, 3), shelf('B', '冷区', 4, 0)]) // A 实际 1 块却记 3
await db.batches.bulkPut([batch('b1', 'A')])
const r4 = await store.reshuffleZone('冷区', [{ batchId: 'b1', targetShelfId: 'B' }])
assert(r4.ok, `E2E4 成功: ${r4.ok ? '' : r4.message}`)
assert((await db.shelves.get('A'))?.occupied === 0, 'E2E4 A 重算为 0')
assert((await db.shelves.get('B'))?.occupied === 1, 'E2E4 B 重算为 1')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
void seedDatabase
