import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchProjectMigration, migrateProjectVisibility } from './workspace-api.js'
import { useWorkspaceStore } from './workspace-store.js'

export function ProjectVisibilityMigration() {
  const hidden = useWorkspaceStore((state) => state.legacyHiddenProjectCwds)
  const clear = useWorkspaceStore((state) => state.clearLegacyProjectVisibility)
  const client = useQueryClient()
  const paths = Object.keys(hidden)
  const migration = useQuery({
    queryKey: ['project-visibility-migration', paths],
    enabled: paths.length > 0,
    queryFn: async () => {
      const { pending } = await fetchProjectMigration()
      if (pending) await migrateProjectVisibility(paths)
      return true
    },
    retry: true,
    retryDelay: 30_000,
  })
  useEffect(() => {
    if (!migration.isSuccess || !paths.length) return
    clear()
    void client.invalidateQueries({ queryKey: ['projects'] })
  }, [migration.isSuccess, paths.length, clear, client])
  return null
}
