import { create } from 'zustand'

export type Page = 'traffic' | 'stats' | 'breakpoints' | 'composer' | 'collections' | 'rules' | 'plugins' | 'settings' | 'toolbox'

interface UiState {
  page: Page
  setPage: (p: Page) => void
}

export const useUiStore = create<UiState>((set) => ({
  page: 'traffic',
  setPage: (page) => set({ page })
}))
