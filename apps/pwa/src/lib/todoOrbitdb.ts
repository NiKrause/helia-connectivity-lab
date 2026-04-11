import {
  createOrbitDB,
  Documents,
  Identities,
  KeyStore,
  MemoryStorage,
} from '@orbitdb/core'
import type { HeliaLibp2p } from 'helia'
import type { Libp2p } from 'libp2p'

export const DEFAULT_TODO_DB_NAME = 'pwa-simple-todos'

export type TodoDoc = {
  id: string
  text: string
  done: boolean
  createdAt: string
  updatedAt: string
  mediaCid?: string
  mediaIds?: string[]
}

type TodoDatabaseLike = {
  address: { toString: () => string } | string
  put: (doc: TodoDoc) => Promise<string>
  del: (key: string) => Promise<string>
  all: () => Promise<Array<{ value?: TodoDoc } | TodoDoc>>
  close: () => Promise<void>
  events: {
    on: (name: 'update' | 'join', fn: () => void) => void
    off: (name: 'update' | 'join', fn: () => void) => void
  }
}

type OrbitDbLike = {
  open: (address: string, options?: Record<string, unknown>) => Promise<TodoDatabaseLike>
  stop: () => Promise<void>
}

function normalizeTodoDoc(value: TodoDoc): TodoDoc {
  return {
    id: value.id,
    text: value.text,
    done: Boolean(value.done),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.mediaCid ? { mediaCid: value.mediaCid } : {}),
    ...(Array.isArray(value.mediaIds) && value.mediaIds.length > 0 ? { mediaIds: value.mediaIds } : {}),
  }
}

export class BrowserTodoOrbitDb {
  private orbitdb: OrbitDbLike | null = null
  private db: TodoDatabaseLike | null = null
  private onDbUpdate: (() => void) | null = null
  private currentName = DEFAULT_TODO_DB_NAME

  async open(helia: HeliaLibp2p<Libp2p>, dbName = DEFAULT_TODO_DB_NAME): Promise<{ address: string; docs: TodoDoc[] }> {
    await this.close()
    this.currentName = dbName.trim() || DEFAULT_TODO_DB_NAME

    const keystore = await KeyStore({ storage: await MemoryStorage() })
    const identities = await Identities({
      ipfs: helia as never,
      keystore,
    })
    const orbitdb = (await createOrbitDB({
      ipfs: helia as never,
      identities,
      directory: './orbitdb-browser-memory',
    })) as OrbitDbLike
    const db = await orbitdb.open(this.currentName, {
      Database: Documents({ indexBy: 'id' }),
    })

    this.orbitdb = orbitdb
    this.db = db
    this.onDbUpdate = () => {
      // Callers pull fresh state explicitly; this hook keeps future live updates easy to wire.
    }
    db.events.on('update', this.onDbUpdate)
    db.events.on('join', this.onDbUpdate)

    return {
      address: this.getAddress() ?? '',
      docs: await this.list(),
    }
  }

  async list(): Promise<TodoDoc[]> {
    if (this.db == null) return []
    const rows = await this.db.all()
    return rows
      .map((row) => normalizeTodoDoc(('value' in row ? row.value : row) as TodoDoc))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getAddress(): string | null {
    if (this.db == null) return null
    return typeof this.db.address === 'string' ? this.db.address : this.db.address.toString()
  }

  getName(): string {
    return this.currentName
  }

  isOpen(): boolean {
    return this.db != null
  }

  async put(doc: TodoDoc): Promise<TodoDoc[]> {
    if (this.db == null) throw new Error('todo database not open')
    await this.db.put(normalizeTodoDoc(doc))
    return await this.list()
  }

  async remove(id: string): Promise<TodoDoc[]> {
    if (this.db == null) throw new Error('todo database not open')
    await this.db.del(id)
    return await this.list()
  }

  async close(): Promise<void> {
    if (this.db != null && this.onDbUpdate != null) {
      try {
        this.db.events.off('update', this.onDbUpdate)
        this.db.events.off('join', this.onDbUpdate)
      } catch {
        // ignore
      }
    }
    this.onDbUpdate = null

    if (this.db != null) {
      try {
        await this.db.close()
      } catch {
        // ignore
      }
      this.db = null
    }

    if (this.orbitdb != null) {
      try {
        await this.orbitdb.stop()
      } catch {
        // ignore
      }
      this.orbitdb = null
    }
  }
}
