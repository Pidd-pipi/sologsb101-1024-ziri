import { planReshuffle } from '../src/utils/reshuffle.ts'

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

function makeShelf(id: string, capacity: number, tempZone = '冷区' as const) {
  return {
    id,
    room: '一号熟成库',
    rackNo: id,
    layerNo: 1,
    tempZone,
    capacity,
    occupied: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeBatch(id: string, shelfId: string | null, state = '熟成中' as const) {
  return {
    id,
    milkId: 'm1',
    curdedAt: '2025-03-10',
    cheeseType: '硬质' as const,
    targetDays: 90,
    weightKg: 5,
    state,
    shelfId,
    conclusion: '',
    createdAt: 0,
    updatedAt: 0
  }
}

/** 用规划器自己的终态占用与逐步模拟校验全程不超块 */
function simulate(plan: NonNullable<ReturnType<typeof planReshuffle> & { ok: true }>, initial: Record<string, number>, capacities: Record<string, number>) {
  const counts = { ...initial }
  for (const step of plan.steps) {
    counts[step.fromShelfId] -= 1
    counts[step.toShelfId] += 1
    assert(counts[step.fromShelfId] >= 0, `步骤后 from 窖位出现负数: ${step.batchId}`)
    for (const [shelfId, count] of Object.entries(counts)) {
      assert(count <= capacities[shelfId], `中途超块: ${shelfId} = ${count} / ${capacities[shelfId]} (步骤 ${step.kind} ${step.batchId})`)
    }
  }
  return counts
}

// 场景 1：两个满窖位对调，第三个窖位有 1 块余量 → 借位对调
{
  const shelves = [makeShelf('A', 1), makeShelf('B', 1), makeShelf('C', 2)]
  const batches = [makeBatch('b1', 'A'), makeBatch('b2', 'B'), makeBatch('b3', 'C')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' },
    { batchId: 'b2', targetShelfId: 'A' },
    { batchId: 'b3', targetShelfId: 'C' }
  ]})
  assert(r.ok, `场景1 应可行: ${r.ok ? '' : r.message}`)
  if (r.ok) {
    assert(r.movedBatchCount === 2, '场景1 挪动 2 个批次')
    assert(r.swapPairCount === 1, '场景1 识别 1 组对调')
    assert(r.bufferShelfIds.includes('C'), '场景1 借用 C')
    assert(r.steps[0].kind === '借位腾挪' && r.steps[0].toShelfId === 'C', '场景1 第一步借位到 C')
    assert(r.steps.some((s) => s.kind === '归位'), '场景1 含归位')
    const final = simulate(r, { A: 1, B: 1, C: 1 }, { A: 1, B: 1, C: 2 })
    assert(final.A === 1 && final.B === 1 && final.C === 1, '场景1 终态占用正确')
    assert(JSON.stringify(r.finalOccupancy) === JSON.stringify({ A: 1, B: 1, C: 1 }), '场景1 finalOccupancy')
  }
}

// 场景 2：整温区满，两个满窖位对调，无缓冲 → 拒绝 NO_BUFFER
{
  const shelves = [makeShelf('A', 1), makeShelf('B', 1)]
  const batches = [makeBatch('b1', 'A'), makeBatch('b2', 'B')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' },
    { batchId: 'b2', targetShelfId: 'A' }
  ]})
  assert(!r.ok && r.code === 'NO_BUFFER', `场景2 应因无空位拒绝，得到: ${r.ok ? 'ok' : r.code}`)
}

// 场景 3：3 个满窖位轮换（A→B, B→C, C→A），第四窖位有余量 → 借 1 个空位解环
{
  const shelves = [makeShelf('A', 1), makeShelf('B', 1), makeShelf('C', 1), makeShelf('D', 3)]
  const batches = [makeBatch('b1', 'A'), makeBatch('b2', 'B'), makeBatch('b3', 'C')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' },
    { batchId: 'b2', targetShelfId: 'C' },
    { batchId: 'b3', targetShelfId: 'A' }
  ]})
  assert(r.ok, `场景3 应可行: ${r.ok ? '' : r.message}`)
  if (r.ok) {
    assert(r.movedBatchCount === 3, '场景3 挪动 3 个批次')
    const final = simulate(r, { A: 1, B: 1, C: 1, D: 0 }, { A: 1, B: 1, C: 1, D: 3 })
    assert(final.A === 1 && final.B === 1 && final.C === 1, '场景3 终态占用正确')
    // 借位批次必须归位
    const temp = r.steps.filter((s) => s.temporary)
    assert(temp.length === 1, '场景3 仅一次借位')
  }
}

// 场景 4：链式挪动（A→已满的 B，B→有空位的 C）→ 必须先挪 b2 到 C 腾出 B，b1 再进入
{
  const shelves = [makeShelf('A', 2), makeShelf('B', 1), makeShelf('C', 2)]
  const batches = [makeBatch('b1', 'A'), makeBatch('b2', 'B')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' },
    { batchId: 'b2', targetShelfId: 'C' }
  ]})
  assert(r.ok, `场景4 应可行: ${r.ok ? '' : r.message}`)
  if (r.ok) {
    assert(r.bufferShelfIds.length === 0, '场景4 不需要借位')
    assert(r.steps.every((s) => s.kind === '直接挪架'), '场景4 全部直接挪架')
    assert(r.steps[0].batchId === 'b2' && r.steps[0].toShelfId === 'C', '场景4 先挪 b2 到 C 放出 B 空位')
    assert(r.steps[1].batchId === 'b1' && r.steps[1].toShelfId === 'B', '场景4 再挪 b1 到 B')
    simulate(r, { A: 1, B: 1, C: 0 }, { A: 2, B: 1, C: 2 })
  }
}

// 场景 5：终态超块 → OVER_CAPACITY
{
  const shelves = [makeShelf('A', 2), makeShelf('B', 1)]
  const batches = [makeBatch('b1', 'A'), makeBatch('b2', 'A')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' },
    { batchId: 'b2', targetShelfId: 'B' }
  ]})
  assert(!r.ok && r.code === 'OVER_CAPACITY', `场景5 应判超块，得到: ${r.ok ? 'ok' : r.code}`)
}

// 场景 6：跨温区指派 → INVALID
{
  const shelves = [makeShelf('A', 2), makeShelf('B', 2, '中温区' as const)]
  const batches = [makeBatch('b1', 'A')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' }
  ]})
  assert(!r.ok && r.code === 'INVALID', `场景6 应拒绝跨温区，得到: ${r.ok ? 'ok' : r.code}`)
}

// 场景 7：非熟成中批次不参与（已出库占块但不在指派里 → 照常计数）；把熟成中批次挪走不影响它
{
  const shelves = [makeShelf('A', 2), makeShelf('B', 2)]
  const batches = [makeBatch('b1', 'A', '熟成中'), makeBatch('bX', 'A', '已出库')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' }
  ]})
  assert(r.ok, `场景7 应可行: ${r.ok ? '' : r.message}`)
  if (r.ok) {
    assert(r.initialOccupancy.A === 2, '场景7 换架前 A 占 2（含已出库未释放）')
    assert(r.finalOccupancy.A === 1 && r.finalOccupancy.B === 1, '场景7 换架后 A=1 B=1')
  }
}

// 场景 8：没有任何挪动 → 0 步可行
{
  const shelves = [makeShelf('A', 2)]
  const batches = [makeBatch('b1', 'A')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'A' }
  ]})
  assert(r.ok && r.steps.length === 0 && r.movedBatchCount === 0, '场景8 无挪动')
}

// 场景 9：多块窖位上的两批次对调 + 窖位内各还有 1 块 → 直接互换（双方各有空位）
{
  const shelves = [makeShelf('A', 3), makeShelf('B', 3)]
  const batches = [makeBatch('a1', 'A'), makeBatch('a2', 'A'), makeBatch('b1', 'B'), makeBatch('b2', 'B')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'a1', targetShelfId: 'B' },
    { batchId: 'b1', targetShelfId: 'A' },
    { batchId: 'a2', targetShelfId: 'A' },
    { batchId: 'b2', targetShelfId: 'B' }
  ]})
  assert(r.ok, `场景9 应可行: ${r.ok ? '' : r.message}`)
  if (r.ok) {
    assert(r.swapPairCount === 1, '场景9 一组对调')
    assert(r.bufferShelfIds.length === 0, '场景9 窖位各自有余量，无需借位')
    simulate(r, { A: 2, B: 2 }, { A: 3, B: 3 })
  }
}

// 场景 10：双闭环（4 个满窖位两两对调），1 个缓冲窖位 → 同一个缓冲依次解两环
{
  const shelves = [makeShelf('A', 1), makeShelf('B', 1), makeShelf('C', 1), makeShelf('D', 1), makeShelf('E', 2)]
  const batches = [makeBatch('b1', 'A'), makeBatch('b2', 'B'), makeBatch('b3', 'C'), makeBatch('b4', 'D')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' },
    { batchId: 'b2', targetShelfId: 'A' },
    { batchId: 'b3', targetShelfId: 'D' },
    { batchId: 'b4', targetShelfId: 'C' }
  ]})
  assert(r.ok, `场景10 应可行: ${r.ok ? '' : r.message}`)
  if (r.ok) {
    assert(r.swapPairCount === 2, '场景10 两组对调')
    assert(r.bufferShelfIds.length === 1, '场景10 复用同一缓冲窖位')
    const final = simulate(r, { A: 1, B: 1, C: 1, D: 1, E: 0 }, { A: 1, B: 1, C: 1, D: 1, E: 2 })
    assert(final.E === 0, '场景10 缓冲窖位最终归还')
    assert(final.A === 1 && final.B === 1 && final.C === 1 && final.D === 1, '场景10 终态')
  }
}

// 场景 11：每步前后临时借位批次的物理位置与步骤记录一致（借位批次的临时一步不写库，仅校验规划自洽）
{
  const shelves = [makeShelf('A', 1), makeShelf('B', 1), makeShelf('C', 2)]
  const batches = [makeBatch('b1', 'A'), makeBatch('b2', 'B')]
  const r = planReshuffle({ tempZone: '冷区', shelves, batches, assignments: [
    { batchId: 'b1', targetShelfId: 'B' },
    { batchId: 'b2', targetShelfId: 'A' }
  ]})
  if (r.ok) {
    // 每个批次的最后一步落点必须是其最终目标窖位
    const lastOf = new Map<string, string>()
    r.steps.forEach((s) => lastOf.set(s.batchId, s.toShelfId))
    assert(lastOf.get('b1') === 'B' && lastOf.get('b2') === 'A', '场景11 最终落点正确')
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
