/**
 * 熟成窖位：库房 → 货架 → 层号三级定位的一个可放奶酪的位置。
 * 上架时校验余量（capacity - occupied）并实时更新占用数。
 */
export type TempZone = '冷区' | '中温区' | '常温区'

export interface Shelf {
  id: string
  /** 库房名称，如「一号熟成库」 */
  room: string
  /** 货架号 */
  rackNo: string
  /** 层号 */
  layerNo: number
  /** 温区：冷区 / 中温区 / 常温区 */
  tempZone: TempZone
  /** 可放块数 */
  capacity: number
  /** 已占块数 */
  occupied: number
  createdAt: number
  updatedAt: number
}

export const TEMP_ZONES: TempZone[] = ['冷区', '中温区', '常温区']

/** 窖位占用率派生值，供 <StatBadge> 与货架看板消费 */
export interface ShelfOccupancy {
  shelfId: string
  capacity: number
  occupied: number
  /** 剩余可放块数 */
  free: number
  /** 占用率百分比 0-100 */
  percent: number
  /** 是否已满 */
  full: boolean
  /** 是否接近满（占用率 ≥ 85%） */
  tight: boolean
}

/** 上架 / 下架操作结果 */
export interface ShelfAssignResult {
  ok: boolean
  message: string
}

/** 整区换架单中的一条诉求：把批次挪到同温区目标窖位 */
export interface ShelfReshuffleMove {
  batchId: string
  targetShelfId: string
}

/** 整区换架结果：成功时带回挪位统计，失败时带回拒绝原因 */
export interface ShelfReshuffleResult {
  ok: boolean
  message: string
  /** 实际挪动的批次数 */
  moved?: number
  /** 互换窖位的批次对数 */
  swappedPairs?: number
  /** 为腾位借过空位的窖位数 */
  bufferShelves?: number
  /** 占用数被纠正（原 occupied 与实际批次不一致）的窖位数 */
  reconciled?: number
  /** 跟随到新窖位的未执行转架作业条数 */
  pendingTurningsUpdated?: number
  /** 物理挪位步骤数（含借位缓冲步） */
  steps?: number
}

/** 窖位页筛选条件：关键字 + 库房多选 + 温区多选 */
export interface ShelfFilterState {
  keyword: string
  rooms: string[]
  tempZones: TempZone[]
}

export function createEmptyShelfFilter(): ShelfFilterState {
  return {
    keyword: '',
    rooms: [],
    tempZones: []
  }
}
