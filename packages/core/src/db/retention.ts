import { statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '@proxy/shared'
import type { Db } from './database'
import type { FlowsRepo } from './flows-repo'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** 磁盘超限时的删除批次：每次删最旧的一批再重新测量 */
const DISK_BATCH = 500

export interface RetentionStats {
  deletedByAge: number
  deletedByCount: number
  deletedByDisk: number
  freedBytes: number
  vacuumed: boolean
}

export class RetentionManager {
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false

  constructor(
    private repo: FlowsRepo,
    private db: Db,
    private dbPath: string,
    private bodiesDir: string,
    private getSettings: () => AppSettings,
    private onStats?: (stats: RetentionStats) => void
  ) {}

  start(): void {
    this.stop()
    void this.run()
    this.timer = setInterval(() => void this.run(), HOUR_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async run(): Promise<RetentionStats> {
    if (this.busy) return { deletedByAge: 0, deletedByCount: 0, deletedByDisk: 0, freedBytes: 0, vacuumed: false }
    this.busy = true
    try {
      const stats = this.execute()
      if (stats.deletedByAge + stats.deletedByCount + stats.deletedByDisk > 0) this.onStats?.(stats)
      return stats
    } finally {
      this.busy = false
    }
  }

  private execute(): RetentionStats {
    const { retention } = this.getSettings()
    const stats: RetentionStats = {
      deletedByAge: 0,
      deletedByCount: 0,
      deletedByDisk: 0,
      freedBytes: 0,
      vacuumed: false
    }
    if (retention.days > 0) {
      const cutoff = Date.now() - retention.days * DAY_MS
      const r = this.repo.deleteFlowsWhere('created_at < ?', [cutoff])
      stats.deletedByAge = r.count
      stats.freedBytes += r.freedBytes
    }
    if (retention.maxFlows > 0) {
      const threshold = this.repo.seqAtOffset(retention.maxFlows)
      if (threshold !== null) {
        const r = this.repo.deleteFlowsWhere('seq <= ?', [threshold])
        stats.deletedByCount = r.count
        stats.freedBytes += r.freedBytes
      }
    }
    if (retention.maxDiskGB > 0) {
      const limitBytes = retention.maxDiskGB * 1024 * 1024 * 1024
      let guard = 0
      while (this.diskUsageBytes() > limitBytes && guard++ < 200) {
        const batch = Math.min(DISK_BATCH, this.repo.countFlows())
        if (batch === 0) break
        const threshold = this.repo.seqAtOffset(batch - 1)
        if (threshold === null) break
        const r = this.repo.deleteFlowsWhere('seq <= ?', [threshold])
        if (r.count === 0) break
        stats.deletedByDisk += r.count
        stats.freedBytes += r.freedBytes
      }
      if (stats.deletedByDisk > 0 && this.dbUsageBytes() > limitBytes) {
        try {
          this.db.exec('VACUUM')
          stats.vacuumed = true
        } catch {
          /* ignore */
        }
      }
    }
    return stats
  }

  private dbUsageBytes(): number {
    let total = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += statSync(this.dbPath + suffix).size
      } catch {
        /* file may not exist */
      }
    }
    return total
  }

  private diskUsageBytes(): number {
    let total = this.dbUsageBytes()
    try {
      for (const name of readdirSync(this.bodiesDir)) {
        try {
          total += statSync(join(this.bodiesDir, name)).size
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* bodies dir may not exist */
    }
    return total
  }
}
