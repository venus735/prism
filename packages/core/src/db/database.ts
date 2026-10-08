import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at REAL NOT NULL,
  client_ip TEXT,
  client_port INTEGER,
  tls INTEGER NOT NULL DEFAULT 0,
  mitm INTEGER NOT NULL DEFAULT 0,
  sni TEXT,
  host TEXT,
  port INTEGER,
  method TEXT,
  path TEXT,
  url TEXT,
  http_version TEXT,
  resp_http_version TEXT,
  resp_trailers TEXT,
  status INTEGER,
  status_text TEXT,
  duration_ms REAL,
  req_headers TEXT,
  resp_headers TEXT,
  req_header_size INTEGER NOT NULL DEFAULT 0,
  req_body_size INTEGER NOT NULL DEFAULT 0,
  resp_header_size INTEGER NOT NULL DEFAULT 0,
  resp_body_size INTEGER NOT NULL DEFAULT 0,
  req_content_type TEXT,
  resp_content_type TEXT,
  t_request_sent REAL,
  t_dns REAL,
  t_connect REAL,
  t_tls REAL,
  t_first_byte REAL,
  t_end REAL,
  error TEXT,
  flags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_flows_seq ON flows(seq DESC);
CREATE INDEX IF NOT EXISTS idx_flows_host ON flows(host);
CREATE INDEX IF NOT EXISTS idx_flows_status ON flows(status);
CREATE INDEX IF NOT EXISTS idx_flows_created ON flows(created_at DESC);

CREATE TABLE IF NOT EXISTS bodies (
  flow_id TEXT NOT NULL,
  part TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  inline BLOB,
  file_path TEXT,
  encoding TEXT,
  content_type TEXT,
  is_text INTEGER,
  preview TEXT,
  PRIMARY KEY (flow_id, part)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  match TEXT NOT NULL,
  actions TEXT NOT NULL,
  created_at REAL,
  updated_at REAL
);

CREATE TABLE IF NOT EXISTS ws_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  dir TEXT NOT NULL,
  opcode INTEGER NOT NULL,
  size INTEGER NOT NULL,
  text TEXT,
  at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_flow ON ws_messages(flow_id, seq);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_collections_created ON collections(created_at DESC);

CREATE TABLE IF NOT EXISTS wb_nodes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  filter TEXT,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wb_nodes_parent ON wb_nodes(scope, parent_id);
`

export class Db {
  private db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(join(dbPath, '..'), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** 轻量迁移：旧库补列（重复列报错忽略），保证 flows 响应侧 http_version / trailers / 用户标签备注可持久化 */
  private migrate(): void {
    for (const col of [
      'resp_http_version TEXT',
      'resp_trailers TEXT',
      'client_app TEXT',
      'label TEXT',
      'note TEXT',
      'trace_id TEXT'
    ]) {
      const name = col.split(' ')[0]
      try {
        this.db.exec(`ALTER TABLE flows ADD COLUMN ${col}`)
      } catch (err) {
        if (!(err instanceof Error && err.message.includes('duplicate column'))) {
          const existing = this.db
            .prepare("SELECT name FROM pragma_table_info('flows') WHERE name = ?")
            .get(name)
          if (!existing) throw err
        }
      }
    }
    for (const [table, col] of [
      ['collections', 'folder_id TEXT']
    ] as const) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`)
      } catch {
        /* 列已存在 */
      }
    }
  }

  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.db.prepare(sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  close(): void {
    this.db.close()
  }
}
