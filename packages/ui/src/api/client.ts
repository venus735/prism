import type { IpcChannel, IpcContract } from '@proxy/shared'

interface Bridge {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
  on: (channel: string, listener: (payload: unknown) => void) => () => void
}

const bridge: Bridge = (globalThis as { api?: Bridge }).api ?? {
  invoke: async () => {
    throw new Error('no bridge')
  },
  on: () => () => {}
}

export async function call<K extends IpcChannel & keyof IpcContract>(
  channel: K,
  ...args: IpcContract[K]['req'] extends void ? [] : [IpcContract[K]['req']]
): Promise<IpcContract[K]['res']> {
  return bridge.invoke(channel, args[0]) as Promise<IpcContract[K]['res']>
}

export function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  return bridge.on(channel, (payload) => listener(payload as T))
}
