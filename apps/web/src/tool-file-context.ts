import { createContext } from 'react'

export const OpenToolFile = createContext<((path: string, line?: number, searchRoot?: string) => void) | undefined>(undefined)
