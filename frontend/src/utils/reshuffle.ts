import type { Batch } from '@/types/batch'
import type { Shelf, TempZone } from '@/types/shelf'

/**
 * 温区换架规划器（纯函数，不触碰数据库）。
 *
 * 约束：
 * 1. 只有「熟成中」且当前就在该温区窖位上的批次可以挪动，目标窖位必须同温区；
 * 2. 执行过程中任何时刻，每个窖位的在架块数都不能超过可放块数（capacity）；
 * 3. 两个批次对调、双方窖位都已满时，需借用同温区内一个有余量的窖位做临时腾挪；
 * 4. 整个温区凑不出临时空位时判定容量不够，拒绝本次换架（不给出任何执行步骤）；
 * 5. 换架后占用数必须等于实际在架批次数。
 */

/** 换架指派：某批次要去的目标窖位 id（未改变的批次传当前窖位即可） */
export interface ReshuffleAssignment {
  batchId: string
  targetShelfId: string
}

export interface ReshuffleInput {
  tempZone: TempZone
  /** 全部窖位（规划器内部按温区过滤） */
  shelves: Shelf[]
  /** 全部批次（规划器内部按「熟成中 + 当前窖位在本温区」挑参与批次，其余视为占块的固定批次） */
  batches: Batch[]
  assignments: ReshuffleAssignment[]
}

/** 换架执行中的一步物理挪动 */
export interface ReshuffleStep {
  /** 直接挪架：一步到最终窖位；借位腾挪：先临时挪到同温区空余窖位；归位：借位批次挪入最终窖位 */
  kind: '直接挪架' | '借位腾挪' | '归位'
  batchId: string
  fromShelfId: string
  toShelfId: string
  /** 是否为临时借位（执行后该批次还会再挪一次） */
  temporary: boolean
}

export interface ReshufflePlan {
  tempZone: TempZone
  steps: ReshuffleStep[]
  /** 实际更换窖位的批次数 */
  movedBatchCount: number
  /** 互相占了对方窖位的对调组数 */
  swapPairCount: number
  /** 执行时借用到的临时窖位（去重，按首次借用顺序） */
  bufferShelfIds: string[]
  /** 换架前占用数：窖位 id → 实际在架批次数 */
  initialOccupancy: Record<string, number>
  /** 换架后占用数：窖位 id → 实际在架批次数 */
  finalOccupancy: Record<string, number>
}

export type ReshuffleResult =
  | ({ ok: true } & ReshufflePlan)
  | {
      ok: false
      code: 'INVALID' | 'OVER_CAPACITY' | 'NO_BUFFER'
      message: string
    }

interface MoveEdge {
  batchId: string
  from: string
  to: string
}

function shelfText(shelf: Shelf): string {
  return `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层`
}

/**
 * 规划一次温区换架，返回严格按顺序执行即可保证全程不超块的挪动步骤；
 * 不可行时返回 ok:false 与原因（调用方应整单拒绝、不执行任何步骤）。
 */
export function planReshuffle(input: ReshuffleInput): ReshuffleResult {
  const zoneShelves = input.shelves.filter((shelf) => shelf.tempZone === input.tempZone)
  const zoneShelfIds = new Set(zoneShelves.map((shelf) => shelf.id))

  // 当前实际在该温区窖位上的所有批次（含已出库/报废等未释放的历史批次，它们照样占块且不参与挪动）
  const residents = input.batches.filter(
    (batch) => batch.shelfId && zoneShelfIds.has(batch.shelfId)
  )
  const residentMap = new Map(residents.map((batch) => [batch.id, batch]))

  // 1. 校验指派并构造挪动边
  const seenBatchIds = new Set<string>()
  const edges: MoveEdge[] = []
  for (const assignment of input.assignments) {
    if (seenBatchIds.has(assignment.batchId)) {
      return { ok: false, code: 'INVALID', message: '同一批次被重复指派，请刷新后重试' }
    }
    seenBatchIds.add(assignment.batchId)

    const batch = residentMap.get(assignment.batchId)
    if (!batch || batch.state !== '熟成中' || !batch.shelfId) {
      return { ok: false, code: 'INVALID', message: '存在不在该温区或非熟成中的批次，请刷新后重试' }
    }
    if (!zoneShelfIds.has(assignment.targetShelfId)) {
      return {
        ok: false,
        code: 'INVALID',
        message: `批次只能挪到${input.tempZone}内的窖位，不能跨温区挪架`
      }
    }
    if (assignment.targetShelfId !== batch.shelfId) {
      edges.push({ batchId: batch.id, from: batch.shelfId, to: assignment.targetShelfId })
    }
  }

  // 2. 以「实际在架批次数」为基准统计换架前占用数
  const capacityOf = new Map(zoneShelves.map((shelf) => [shelf.id, shelf.capacity]))
  const initialOccupancy: Record<string, number> = {}
  for (const shelf of zoneShelves) initialOccupancy[shelf.id] = 0
  for (const batch of residents) {
    initialOccupancy[batch.shelfId as string] += 1
  }

  // 3. 统计换架后占用数，终态超块直接拒绝
  const finalOccupancy: Record<string, number> = { ...initialOccupancy }
  for (const edge of edges) {
    finalOccupancy[edge.from] -= 1
    finalOccupancy[edge.to] += 1
  }
  const overfull = zoneShelves.filter(
    (shelf) => (finalOccupancy[shelf.id] ?? 0) > shelf.capacity
  )
  if (overfull.length > 0) {
    const detail = overfull
      .slice(0, 3)
      .map((shelf) => `${shelfText(shelf)}将放 ${finalOccupancy[shelf.id]} 块（上限 ${shelf.capacity} 块）`)
      .join('；')
    return {
      ok: false,
      code: 'OVER_CAPACITY',
      message: `换架后${detail}，超出可放块数，请重新分配窖位`
    }
  }

  const steps: ReshuffleStep[] = []
  const bufferShelfIds: string[] = []
  const counts: Record<string, number> = { ...initialOccupancy }
  const freeSlots = (shelfId: string): number =>
    (capacityOf.get(shelfId) ?? 0) - (counts[shelfId] ?? 0)

  const remaining = edges.slice()
  /** 按目标窖位索引的边，循环倒推时用 */
  const incoming = new Map<string, MoveEdge[]>()
  const indexEdge = (edge: MoveEdge): void => {
    const list = incoming.get(edge.to) ?? []
    list.push(edge)
    incoming.set(edge.to, list)
  }
  const dropEdge = (edge: MoveEdge): void => {
    const list = incoming.get(edge.to)
    if (list) {
      const at = list.indexOf(edge)
      if (at >= 0) list.splice(at, 1)
    }
    const at = remaining.indexOf(edge)
    if (at >= 0) remaining.splice(at, 1)
  }
  remaining.forEach(indexEdge)

  const applyMove = (edge: MoveEdge, kind: ReshuffleStep['kind'], toShelfId: string): void => {
    counts[edge.from] -= 1
    counts[toShelfId] += 1
    steps.push({
      kind,
      batchId: edge.batchId,
      fromShelfId: edge.from,
      toShelfId,
      temporary: kind === '借位腾挪'
    })
  }

  /** 在本温区选一个当前有余量的窖位做临时腾挪，余量多者优先（结果确定、可复现） */
  function pickBuffer(excludeShelfId: string): Shelf | null {
    return (
      zoneShelves
        .filter((shelf) => shelf.id !== excludeShelfId && freeSlots(shelf.id) > 0)
        .sort(
          (a, b) =>
            freeSlots(b.id) - freeSlots(a.id) ||
            a.room.localeCompare(b.room) ||
            a.rackNo.localeCompare(b.rackNo) ||
            a.layerNo - b.layerNo
        )[0] ?? null
    )
  }

  // 4. 先 greedily 走所有「目标窖位当前有空位」的一步挪动
  let progressed = true
  while (progressed) {
    progressed = false
    for (let i = 0; i < remaining.length; i += 1) {
      const edge = remaining[i]
      if (freeSlots(edge.to) > 0) {
        applyMove(edge, '直接挪架', edge.to)
        dropEdge(edge)
        progressed = true
        break
      }
    }
  }

  // 5. 剩下的边全部落在闭环里（如两批次对调且双方窖位都满），借临时空位逐环解开
  while (remaining.length > 0) {
    const first = remaining[remaining.length - 1]
    const buffer = pickBuffer(first.from)
    if (!buffer) {
      return {
        ok: false,
        code: 'NO_BUFFER',
        message: `${input.tempZone}已全部放满，整温区凑不出临时空位完成对调，容量不够，本次换架不予执行`
      }
    }
    if (!bufferShelfIds.includes(buffer.id)) bufferShelfIds.push(buffer.id)

    // 先把闭环起点批次临时挪到借用窖位
    dropEdge(first)
    counts[first.from] -= 1
    counts[buffer.id] += 1
    steps.push({
      kind: '借位腾挪',
      batchId: first.batchId,
      fromShelfId: first.from,
      toShelfId: buffer.id,
      temporary: true
    })

    // 沿闭环倒推：谁的目标窖位刚空出来，谁就直接挪入（都是一步到最终窖位）
    let freeVertex = first.from
    while (freeVertex !== first.to) {
      const list = incoming.get(freeVertex) ?? []
      const next = list.pop()
      if (!next) {
        return {
          ok: false,
          code: 'NO_BUFFER',
          message: `${input.tempZone}窖位占用关系无法排出安全的挪动顺序，本次换架不予执行`
        }
      }
      const at = remaining.indexOf(next)
      if (at >= 0) remaining.splice(at, 1)
      applyMove(next, '直接挪架', next.to)
      freeVertex = next.from
    }

    // 借用窖位上的批次归位到最终窖位
    counts[buffer.id] -= 1
    counts[first.to] += 1
    steps.push({
      kind: '归位',
      batchId: first.batchId,
      fromShelfId: buffer.id,
      toShelfId: first.to,
      temporary: false
    })

    // 解环可能连锁放出新空位，再走一轮直接挪动
    for (let i = 0; i < remaining.length; i += 1) {
      const edge = remaining[i]
      if (freeSlots(edge.to) > 0) {
        applyMove(edge, '直接挪架', edge.to)
        dropEdge(edge)
        i -= 1
      }
    }
  }

  // 6. 统计对调组数：两个窖位之间互相都有挪动边即记一组
  const pairKeys = new Set<string>()
  for (const edge of edges) {
    const hasReverse = edges.some((other) => other.from === edge.to && other.to === edge.from)
    if (hasReverse) {
      pairKeys.add([edge.from, edge.to].sort().join(' '))
    }
  }

  return {
    ok: true,
    tempZone: input.tempZone,
    steps,
    movedBatchCount: edges.length,
    swapPairCount: pairKeys.size,
    bufferShelfIds,
    initialOccupancy,
    finalOccupancy
  }
}
