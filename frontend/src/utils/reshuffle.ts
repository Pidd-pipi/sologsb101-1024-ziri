/**
 * 整区换架规划：在同一温区内把若干「熟成中」批次一次性挪到其他窖位（含两个窖位互换）。
 *
 * 约束：
 * - 批次只能挪到同一温区的窖位，目标窖位可放块数始终不能超（中间步也不行）；
 * - 整区凑不出位置（参与调整的窖位一个空位都没有且存在真实挪动）视为容量不够，直接拒绝；
 * - 规划与执行解耦：planReshuffle 只在内存中校验并产出物理挪位步骤序列（含借位缓冲），
 *   任何一步放不下都返回失败；store 侧据此在单个 Dexie 事务内落库，失败即整体回滚。
 */

/** 换架规划所需的批次最小结构 */
export interface ReshuffleBatch {
  id: string
  /** 当前所在窖位（要挪的批次必须已上架） */
  shelfId: string | null
}

/** 换架规划所需的窖位最小结构 */
export interface ReshuffleShelf {
  id: string
  tempZone: string
  /** 可放块数 */
  capacity: number
}

/** 一条换架诉求：把 batchId 挪到 targetShelfId */
export interface ReshuffleMove {
  batchId: string
  targetShelfId: string
}

/** 物理挪位步骤：批次 fromShelfId → toShelfId（缓冲步的 toShelfId 非其最终目标） */
export interface ReshuffleStep {
  batchId: string
  fromShelfId: string
  toShelfId: string
  /** true 表示该步是为腾位做的借位缓冲，不是批次最终落点 */
  buffered: boolean
}

export type ReshuffleErrorCode =
  | 'EMPTY'
  | 'BATCH_NOT_FOUND'
  | 'BATCH_NOT_AGING'
  | 'BATCH_NOT_SHELVED'
  | 'DUPLICATE_BATCH'
  | 'ORIGIN_NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'CROSS_ZONE_MOVE'
  | 'ZONE_MISMATCH'
  | 'NO_SPACE_IN_ZONE'
  | 'TARGET_OVERFLOW'
  | 'UNREACHABLE'

export interface ReshuffleFailure {
  ok: false
  code: ReshuffleErrorCode
  message: string
}

export interface ReshufflePlan {
  ok: true
  /** 温区（所有诉求必须同温区） */
  zone: string
  /** 实际需要挪位的诉求（过滤掉目标与现状一致的空操作） */
  effectiveMoves: ReshuffleMove[]
  /** 物理执行步骤（含借位缓冲步），按顺序执行即可保证中间不超载 */
  steps: ReshuffleStep[]
  /** 最终每个参与窖位上的批次数 */
  finalCounts: Record<string, number>
  /** 初始（实际批次数口径）每个参与窖位上的批次数 */
  initialCounts: Record<string, number>
  /** 为腾位用到的缓冲窖位 id（可能为空：无需借位即可完成） */
  bufferShelfIds: string[]
  /** 互换窖位的批次对（batchA 与 batchB 所在窖位对调） */
  swappedPairs: Array<{ batchAId: string; batchBId: string; shelfAId: string; shelfBId: string }>
}

export type ReshuffleResult = ReshufflePlan | ReshuffleFailure

/** 可挪批次必须是「熟成中」状态 */
export function isMovableBatchState(state: string): boolean {
  return state === '熟成中'
}

/**
 * 计算整区换架计划。
 *
 * @param moves 页面上排好的换架诉求
 * @param batches 全量批次（至少含本温区在架批次，用于按实际在架数核算占用）
 * @param shelves 全量窖位
 * @param batchStates 批次 id → 状态；传入时会额外校验只有「熟成中」批次可挪
 */
export function planReshuffle(
  moves: ReshuffleMove[],
  batches: ReshuffleBatch[],
  shelves: ReshuffleShelf[],
  batchStates?: Record<string, string>
): ReshuffleResult {
  if (moves.length === 0) {
    return { ok: false, code: 'EMPTY', message: '请先为至少一个批次选择新窖位' }
  }

  const shelfById = new Map(shelves.map((shelf) => [shelf.id, shelf]))
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))

  // —— 诉求基本校验：批次存在 / 已上架 / 熟成中 / 起止窖位存在且同温区 ——
  const seenBatchIds = new Set<string>()
  let zone = ''
  for (const move of moves) {
    if (seenBatchIds.has(move.batchId)) {
      return { ok: false, code: 'DUPLICATE_BATCH', message: '同一个批次在换架单中出现了两次' }
    }
    seenBatchIds.add(move.batchId)

    const batch = batchById.get(move.batchId)
    if (!batch) {
      return { ok: false, code: 'BATCH_NOT_FOUND', message: `批次 ${move.batchId} 不存在，请刷新后重试` }
    }
    if (batchStates && !isMovableBatchState(batchStates[move.batchId] ?? '')) {
      return {
        ok: false,
        code: 'BATCH_NOT_AGING',
        message: '只有「熟成中」的批次可以换架，已出库或报废的批次请保持原位'
      }
    }
    if (!batch.shelfId) {
      return { ok: false, code: 'BATCH_NOT_SHELVED', message: '存在尚未上架的批次，请先在货架页完成上架' }
    }
    const fromShelf = shelfById.get(batch.shelfId)
    if (!fromShelf) {
      return { ok: false, code: 'ORIGIN_NOT_FOUND', message: '批次当前窖位已不存在，请刷新后重试' }
    }
    const targetShelf = shelfById.get(move.targetShelfId)
    if (!targetShelf) {
      return { ok: false, code: 'TARGET_NOT_FOUND', message: '目标窖位不存在，请刷新后重试' }
    }
    if (!zone) zone = fromShelf.tempZone
    if (fromShelf.tempZone !== zone) {
      return {
        ok: false,
        code: 'CROSS_ZONE_MOVE',
        message: '一次换架只能在同一个温区内安排，不能把批次挪到别的温区'
      }
    }
    if (targetShelf.tempZone !== zone) {
      return {
        ok: false,
        code: 'ZONE_MISMATCH',
        message: `批次只能挪到同温区（${zone}）的窖位，不能跨温区存放`
      }
    }
  }

  // —— 过滤空操作：目标窖位与现状一致视为不动 ——
  const effectiveMoves = moves.filter((move) => {
    const batch = batchById.get(move.batchId)!
    return batch.shelfId !== move.targetShelfId
  })
  if (effectiveMoves.length === 0) {
    return { ok: false, code: 'EMPTY', message: '所有批次的新窖位都与现状一致，没有需要挪动的批次' }
  }

  // —— 温区范围：同温区的所有窖位（跨库房也算同温区），空位都可用于腾挪借位 ——
  const zoneShelfIds = new Set<string>(
    shelves.filter((shelf) => shelf.tempZone === zone).map((shelf) => shelf.id)
  )
  if (zoneShelfIds.size === 0) {
    return { ok: false, code: 'ORIGIN_NOT_FOUND', message: `${zone}内没有可用窖位，请刷新后重试` }
  }

  // —— 参与窖位：诉求中出现的起点 + 终点（终态计数只需这些） ——
  const involvedShelfIds = new Set<string>()
  for (const move of effectiveMoves) {
    involvedShelfIds.add(batchById.get(move.batchId)!.shelfId!)
    involvedShelfIds.add(move.targetShelfId)
  }

  // 初始分布：全温区在架批次都纳入跟踪（借位可能落到未参与调整的窖位）。
  // 以批次实际挂接为准（occupied 脏数据由 store 落库时一并纠正）。
  const originOf = new Map<string, string>()
  const location = new Map<string, string>()
  const initialCounts = new Map<string, number>()
  zoneShelfIds.forEach((shelfId) => initialCounts.set(shelfId, 0))
  for (const batch of batches) {
    if (batch.shelfId && zoneShelfIds.has(batch.shelfId)) {
      originOf.set(batch.id, batch.shelfId)
      location.set(batch.id, batch.shelfId)
      initialCounts.set(batch.shelfId, (initialCounts.get(batch.shelfId) ?? 0) + 1)
    }
  }

  // —— 终态分布：诉求中的批次去新窖位，其余在架批次保持原位 ——
  const finalOf = new Map(location)
  for (const move of effectiveMoves) {
    finalOf.set(move.batchId, move.targetShelfId)
  }

  const finalCountsMap = new Map<string, number>()
  zoneShelfIds.forEach((shelfId) => finalCountsMap.set(shelfId, 0))
  finalOf.forEach((shelfId) => {
    finalCountsMap.set(shelfId, (finalCountsMap.get(shelfId) ?? 0) + 1)
  })

  // —— 终态超载直接拒绝 ——
  for (const shelfId of involvedShelfIds) {
    const count = finalCountsMap.get(shelfId) ?? 0
    const shelf = shelfById.get(shelfId)!
    if (count > shelf.capacity) {
      return {
        ok: false,
        code: 'TARGET_OVERFLOW',
        message: `换架后窖位 ${shelfId} 要放 ${count} 块，超过可放块数 ${shelf.capacity}，请重新安排`
      }
    }
  }

  // —— 整区凑不出位置：同一温区所有窖位全部放满时，纯对调 / 循环对调无位可借 ——
  const totalCapacity = [...zoneShelfIds].reduce(
    (sum, shelfId) => sum + shelfById.get(shelfId)!.capacity,
    0
  )
  const totalInitial = [...zoneShelfIds].reduce(
    (sum, shelfId) => sum + (initialCounts.get(shelfId) ?? 0),
    0
  )
  if (totalInitial >= totalCapacity) {
    return {
      ok: false,
      code: 'NO_SPACE_IN_ZONE',
      message: `${zone}所有窖位已全部放满（${totalInitial}/${totalCapacity} 块），整区凑不出腾挪位置，容量不够，已拒绝本次换架`
    }
  }

  // —— 逐步模拟物理挪位：每步要求目标窖位当时有空位；卡住则先把占位批次借位到空位 ——
  const countsNow = new Map(initialCounts)
  const freeOn = (shelfId: string): number =>
    shelfById.get(shelfId)!.capacity - (countsNow.get(shelfId) ?? 0)
  const steps: ReshuffleStep[] = []
  const movePhysically = (batchId: string, toShelfId: string, buffered: boolean): void => {
    const fromShelfId = location.get(batchId)!
    countsNow.set(fromShelfId, (countsNow.get(fromShelfId) ?? 1) - 1)
    countsNow.set(toShelfId, (countsNow.get(toShelfId) ?? 0) + 1)
    location.set(batchId, toShelfId)
    steps.push({ batchId, fromShelfId, toShelfId, buffered })
  }

  const remaining = new Set(effectiveMoves.map((move) => move.batchId))
  const bufferShelfIds = new Set<string>()
  // 每次借位后必然能让一个批次到位，故借位步数 ≤ 到位步数，总步数 ≤ 2 × 挪批次数
  const maxSteps = effectiveMoves.length * 2

  while (remaining.size > 0) {
    if (steps.length > maxSteps) {
      return {
        ok: false,
        code: 'UNREACHABLE',
        message: '换架排布无法在不超载的前提下完成（出现循环腾挪），已拒绝，请重新安排窖位'
      }
    }

    // 第一步：目标窖位当前有空位的批次直接到位
    let progressed = false
    for (const batchId of remaining) {
      const targetShelfId = finalOf.get(batchId)!
      if (freeOn(targetShelfId) > 0) {
        movePhysically(batchId, targetShelfId, false)
        remaining.delete(batchId)
        progressed = true
        break
      }
    }
    if (progressed) continue

    // 第二步：目标都被占住时，找一个「当前压在别人目标窖位、终态又不在该窖位」的批次先借位。
    // 搜索范围是全温区在架批次（含被缓冲过、或本来不动但挡住目标的批次），不能只看 remaining。
    let blocked: { batchId: string; targetShelfId: string } | null = null
    let blockerId: string | null = null
    for (const batchId of remaining) {
      const targetShelfId = finalOf.get(batchId)!
      const blocker = [...location.keys()].find(
        (otherId) =>
          location.get(otherId) === targetShelfId &&
          finalOf.get(otherId) !== targetShelfId
      )
      if (blocker) {
        blocked = { batchId, targetShelfId }
        blockerId = blocker
        break
      }
    }

    if (!blocked || !blockerId) {
      // 压位的是不参与调整的在架批次（终态超载已在前面拦截，这里仅作兜底）
      return {
        ok: false,
        code: 'UNREACHABLE',
        message: '目标窖位被不参与换架的批次占满，无法在不超载的前提下完成挪位，已拒绝'
      }
    }

    // 借位空位：同一温区内任意一个当前有空位、且不是压位窖位本身的窖位
    const bufferShelfId = [...zoneShelfIds].find(
      (shelfId) => shelfId !== blocked.targetShelfId && freeOn(shelfId) > 0
    )
    if (!bufferShelfId) {
      return {
        ok: false,
        code: 'UNREACHABLE',
        message: '腾挪到一半找不到可用的缓冲空位，已拒绝本次换架'
      }
    }
    movePhysically(blockerId, bufferShelfId, true)
    bufferShelfIds.add(bufferShelfId)
  }

  // —— 一致性兜底：全温区终态位置 / 计数必须与预期一致 ——
  for (const shelfId of zoneShelfIds) {
    const actual = [...location].filter(([, sid]) => sid === shelfId).length
    if (actual !== finalCountsMap.get(shelfId)) {
      return { ok: false, code: 'UNREACHABLE', message: '换架终态核算不一致，已拒绝本次换架' }
    }
  }

  // —— 互换对识别：A、B 两批次互换所在窖位 ——
  const swappedPairs: ReshufflePlan['swappedPairs'] = []
  const paired = new Set<string>()
  for (const move of effectiveMoves) {
    const a = move.batchId
    if (paired.has(a)) continue
    const reverse = effectiveMoves.find(
      (other) =>
        other.batchId !== a &&
        other.targetShelfId === originOf.get(a) &&
        move.targetShelfId === originOf.get(other.batchId)
    )
    if (reverse) {
      swappedPairs.push({
        batchAId: a,
        batchBId: reverse.batchId,
        shelfAId: originOf.get(a)!,
        shelfBId: originOf.get(reverse.batchId)!
      })
      paired.add(a)
      paired.add(reverse.batchId)
    }
  }

  const finalCounts: Record<string, number> = {}
  const initialCountsRecord: Record<string, number> = {}
  zoneShelfIds.forEach((shelfId) => {
    finalCounts[shelfId] = finalCountsMap.get(shelfId) ?? 0
    initialCountsRecord[shelfId] = initialCounts.get(shelfId) ?? 0
  })

  return {
    ok: true,
    zone,
    effectiveMoves,
    steps,
    finalCounts,
    initialCounts: initialCountsRecord,
    bufferShelfIds: [...bufferShelfIds],
    swappedPairs
  }
}
