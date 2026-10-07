import { planReshuffle } from '../src/utils/reshuffle.ts'
import type { ReshuffleBatch, ReshuffleShelf, ReshuffleMove } from '../src/utils/reshuffle.ts'

let passed = 0
let failed = 0

function assert(cond: boolean, message: string): void {
  if (cond) {
    passed += 1
  } else {
    failed += 1
    console.error(`✗ ${message}`)
  }
}

function shelvesOf(spec: Array<[string, number]>): ReshuffleShelf[] {
  return spec.map(([id, capacity]) => ({ id, tempZone: '冷区', capacity }))
}

function batchesOf(spec: Record<string, string | null>): ReshuffleBatch[] {
  return Object.entries(spec).map(([id, shelfId]) => ({ id, shelfId }))
}

/** 校验步骤序列逐步执行时任何窖位都不超载 */
function assertNoIntermediateOverflow(
  result: Extract<Awaited<ReturnType<typeof planReshuffle>>, { ok: true }>,
  startSpec: Record<string, string | null>,
  shelves: ReshuffleShelf[]
): void {
  const location = new Map<string, string>()
  Object.entries(startSpec).forEach(([batchId, shelfId]) => {
    if (shelfId) location.set(batchId, shelfId)
  })
  const counts = new Map<string, number>()
  location.forEach((shelfId) => counts.set(shelfId, (counts.get(shelfId) ?? 0) + 1))
  const cap = new Map(shelves.map((s) => [s.id, s.capacity]))
  for (const step of result.steps) {
    const from = location.get(step.batchId)
    assert(from === step.fromShelfId, `步骤起点一致：批次 ${step.batchId} 在 ${from}，步骤写 ${step.fromShelfId}`)
    counts.set(step.fromShelfId, (counts.get(step.fromShelfId) ?? 1) - 1)
    counts.set(step.toShelfId, (counts.get(step.toShelfId) ?? 0) + 1)
    const nowCount = counts.get(step.toShelfId) ?? 0
    assert(
      nowCount <= (cap.get(step.toShelfId) ?? 0),
      `中间步不超载：${step.toShelfId} 放 ${nowCount}/${cap.get(step.toShelfId)}`
    )
    location.set(step.batchId, step.toShelfId)
  }
}

// 1. 两个满窖位直接对调：参与窖位外有空位窖位可借 → 成功，识别为互换对
{
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 1],
    ['S3', 2]
  ])
  const start = { A: 'S1', B: 'S2' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例1：借空位对调应成功')
  if (result.ok) {
    assert(result.swappedPairs.length === 1, '用例1：识别出 1 个互换对')
    assert(result.finalCounts.S1 === 1 && result.finalCounts.S2 === 1, '用例1：终态各 1 块')
    assert(result.bufferShelfIds.includes('S3'), '用例1：借 S3 做缓冲')
    assertNoIntermediateOverflow(result, start, shelves)
  }
}

// 2. 整温区全部放满且纯对调 → 容量不够，拒绝
{
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 1]
  ])
  const start = { A: 'S1', B: 'S2' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(!result.ok && result.code === 'NO_SPACE_IN_ZONE', '用例2：整区占满应对调拒绝')
}

// 2b. 参与对调的两个窖位满，但同温区第三个窖位也满 → 仍拒绝
{
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 1],
    ['S3', 2]
  ])
  const start = { A: 'S1', B: 'S2', X: 'S3', Y: 'S3' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(!result.ok && result.code === 'NO_SPACE_IN_ZONE', '用例2b：整温区占满（含旁观窖位）应拒绝')
}

// 3. 对调的两个窖位本身各有 1 个空位（capacity 2，各放 1）→ 无需缓冲直接完成
{
  const shelves = shelvesOf([
    ['S1', 2],
    ['S2', 2]
  ])
  const start = { A: 'S1', B: 'S2' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例3：互有余量的对调应成功')
  if (result.ok) {
    assert(result.bufferShelfIds.length === 0, '用例3：无需缓冲位')
    assert(result.steps.every((s) => !s.buffered), '用例3：全部为直接到位步')
    assertNoIntermediateOverflow(result, start, shelves)
  }
}

// 4. 三窖位循环对调，只有一个空位 → 借位完成
{
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 1],
    ['S3', 2]
  ])
  const start = { A: 'S1', B: 'S2', C: 'S3' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S3' },
    { batchId: 'C', targetShelfId: 'S1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例4：三循环 + 一空位应成功')
  if (result.ok) {
    assert(result.finalCounts.S1 === 1 && result.finalCounts.S2 === 1 && result.finalCounts.S3 === 1, '用例4：终态计数正确')
    assertNoIntermediateOverflow(result, start, shelves)
    // 终态位置
    const end = new Map<string, string>()
    Object.entries(start).forEach(([b, s]) => end.set(b, s!))
    result.steps.forEach((step) => end.set(step.batchId, step.toShelfId))
    assert(end.get('A') === 'S2' && end.get('B') === 'S3' && end.get('C') === 'S1', '用例4：终态位置正确')
  }
}

// 5. 终态超载拒绝：把两个批次都挪到 capacity 1 的窖位
{
  const shelves = shelvesOf([
    ['S1', 2],
    ['S2', 1],
    ['S3', 2]
  ])
  const start = { A: 'S1', B: 'S2', X: 'S1' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S1' }
  ]
  // S2 终态：A 进去，B 走了，还有没有别的？没有 → 1 块，合法。构造真正超载：
  const moves2: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'X', targetShelfId: 'S2' }
  ]
  const result = planReshuffle(moves2, batchesOf(start), shelves)
  assert(!result.ok && result.code === 'TARGET_OVERFLOW', '用例5：终态超载应拒绝')
  void moves
}

// 6. 跨温区拒绝
{
  const shelves: ReshuffleShelf[] = [
    { id: 'S1', tempZone: '冷区', capacity: 2 },
    { id: 'S2', tempZone: '中温区', capacity: 2 }
  ]
  const start = { A: 'S1' }
  const moves: ReshuffleMove[] = [{ batchId: 'A', targetShelfId: 'S2' }]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(!result.ok && result.code === 'ZONE_MISMATCH', '用例6：跨温区应拒绝')
}

// 7. 非熟成中批次拒绝
{
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 2]
  ])
  const start = { A: 'S1' }
  const moves: ReshuffleMove[] = [{ batchId: 'A', targetShelfId: 'S2' }]
  const result = planReshuffle(moves, batchesOf(start), shelves, { A: '已出库' })
  assert(!result.ok && result.code === 'BATCH_NOT_AGING', '用例7：已出库批次不能换架')
}

// 8. 空诉求 / 全部空操作
{
  const shelves = shelvesOf([['S1', 2]])
  const start = { A: 'S1' }
  const result = planReshuffle([], batchesOf(start), shelves)
  assert(!result.ok && result.code === 'EMPTY', '用例8a：空换架单拒绝')
  const result2 = planReshuffle([{ batchId: 'A', targetShelfId: 'S1' }], batchesOf(start), shelves)
  assert(!result2.ok && result2.code === 'EMPTY', '用例8b：全是空操作拒绝')
}

// 9. 不参与调整的在架批次占着目标窖位：A→S2，S2 上的 X 不动，且 S2 满 → 终态超载拒绝
{
  const shelves = shelvesOf([
    ['S1', 2],
    ['S2', 1],
    ['S3', 2]
  ])
  const start = { A: 'S1', X: 'S2' }
  const moves: ReshuffleMove[] = [{ batchId: 'A', targetShelfId: 'S2' }]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(!result.ok && result.code === 'TARGET_OVERFLOW', '用例9：占压不挪导致终态超载应拒绝')
}

// 10. 综合：A、B 对调（两窖位满），C 从 S1 挪到有空位的 S4；参与窖位 S1/S2/S4 含空位
{
  const shelves = shelvesOf([
    ['S1', 2],
    ['S2', 1],
    ['S4', 4]
  ])
  const start = { A: 'S1', B: 'S2', C: 'S1' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S1' },
    { batchId: 'C', targetShelfId: 'S4' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例10：对调 + 单挪混合应成功')
  if (result.ok) {
    assert(result.swappedPairs.length === 1, '用例10：仍识别出 A/B 互换对')
    assert(result.finalCounts.S1 === 1 && result.finalCounts.S2 === 1 && result.finalCounts.S4 === 1, '用例10：终态计数')
    assertNoIntermediateOverflow(result, start, shelves)
  }
}

// 11. 缓冲窖位恰好是后续批次的最终目标（链式腾挪）
{
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 1],
    ['S3', 1],
    ['S4', 2]
  ])
  const start = { A: 'S1', B: 'S2', C: 'S3' }
  // A→S2, B→S3, C→S1；S4 有空位。S1/S2/S3 全满
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S3' },
    { batchId: 'C', targetShelfId: 'S1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例11：链式腾挪应成功')
  if (result.ok) assertNoIntermediateOverflow(result, start, shelves)
}

// 12. 缺失批次 / 缺失窖位
{
  const shelves = shelvesOf([
    ['S1', 2],
    ['S2', 2]
  ])
  const r1 = planReshuffle([{ batchId: 'Z', targetShelfId: 'S2' }], batchesOf({ A: 'S1' }), shelves)
  assert(!r1.ok && r1.code === 'BATCH_NOT_FOUND', '用例12a：批次不存在')
  const r2 = planReshuffle([{ batchId: 'A', targetShelfId: 'SX' }], batchesOf({ A: 'S1' }), shelves)
  assert(!r2.ok && r2.code === 'TARGET_NOT_FOUND', '用例12b：目标窖位不存在')
}

// 13. 未上架批次
{
  const shelves = shelvesOf([['S1', 2]])
  const r = planReshuffle([{ batchId: 'A', targetShelfId: 'S1' }], batchesOf({ A: null }), shelves)
  assert(!r.ok && r.code === 'BATCH_NOT_SHELVED', '用例13：未上架批次拒绝')
}

// 14. 同温区旁观窖位上的批次不受影响，借位后其窖位恢复原占用
{
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 1],
    ['S3', 2]
  ])
  const start = { A: 'S1', B: 'S2', Q: 'S3' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例14：旁观窖位 S3 有空位时对调应成功')
  if (result.ok) {
    assert(result.finalCounts.S3 === 1, '用例14：借位后 S3 终态恢复为 1 块（Q 不动）')
    assertNoIntermediateOverflow(result, start, shelves)
  }
}

// 15. 同温区跨库房窖位可作为目标与缓冲
{
  const shelves: ReshuffleShelf[] = [
    { id: 'S1', tempZone: '冷区', capacity: 1 },
    { id: 'S2', tempZone: '冷区', capacity: 1 },
    { id: 'O1', tempZone: '冷区', capacity: 2 }
  ]
  const start = { A: 'S1', B: 'S2' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'O1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例15：跨库房同温区可换架')
  if (result.ok) assertNoIntermediateOverflow(result, start, shelves)
}

// 16. 诉求起点不在同一温区（一次换夹带两个温区的批次）拒绝
{
  const shelves: ReshuffleShelf[] = [
    { id: 'C1', tempZone: '冷区', capacity: 2 },
    { id: 'C2', tempZone: '冷区', capacity: 2 },
    { id: 'M1', tempZone: '中温区', capacity: 2 },
    { id: 'M2', tempZone: '中温区', capacity: 2 }
  ]
  const start = { A: 'C1', B: 'M1' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'C2' },
    { batchId: 'B', targetShelfId: 'M2' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(!result.ok && result.code === 'CROSS_ZONE_MOVE', '用例16：一次换架夹带多个温区应拒绝')
}

// 17. 挡路批次已不在待挪集合（先前被缓冲），仍能被找到并继续腾挪
{
  // S1/S2 满，S3 有 1 空位；A→S2、B→S3；C 是旁观者恰好压位的极端构造：
  // C 在 S3（终态不动），B 的目标 S3 有空位（cap 2）；A 目标 S2 被 B 压着，B 先到位 S3，
  // 随后 A 直接去 S2 —— 无需缓冲。
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 1],
    ['S3', 2]
  ])
  const start = { A: 'S1', B: 'S2', C: 'S3' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S3' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例17：旁观者压位但终态仍合法时应成功')
  if (result.ok) {
    assert(result.finalCounts.S1 === 0 && result.finalCounts.S2 === 1 && result.finalCounts.S3 === 2, '用例17：终态计数')
    assertNoIntermediateOverflow(result, start, shelves)
  }
}

// 18. 连续两次缓冲：缓冲批次被挤到另一窖位后继续链式腾挪
{
  // S1..S4 容量均 1 且全满，S5 容量 2 放 1；4 批次循环 + 1 空位
  const shelves = shelvesOf([
    ['S1', 1],
    ['S2', 1],
    ['S3', 1],
    ['S4', 1],
    ['S5', 2]
  ])
  const start = { A: 'S1', B: 'S2', C: 'S3', D: 'S4', Q: 'S5' }
  const moves: ReshuffleMove[] = [
    { batchId: 'A', targetShelfId: 'S2' },
    { batchId: 'B', targetShelfId: 'S3' },
    { batchId: 'C', targetShelfId: 'S4' },
    { batchId: 'D', targetShelfId: 'S1' }
  ]
  const result = planReshuffle(moves, batchesOf(start), shelves)
  assert(result.ok, '用例18：4 批次循环 + 1 空位链式腾挪应成功')
  if (result.ok) {
    assert(result.finalCounts.S5 === 1, '用例18：缓冲窖位 S5 最终恢复 1 块')
    assertNoIntermediateOverflow(result, start, shelves)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
