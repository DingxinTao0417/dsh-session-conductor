/**
 * Type-level view of the artifact vocabulary.
 *
 * Kept apart from the storage schema so the artifact service can be read and
 * tested without loading the domain declaration, and so the kind and state lists
 * have exactly one definition — the storage schema derives its enum from these.
 *
 * @module dsh-session-conductor/service/artifact-types
 */

export type { ArtifactRecord } from '../store/schema.ts'

/** Kinds of artifact the specification lists (PRD §二.9.1). */
export type ArtifactKind =
  | 'file'
  | 'directory'
  | 'link'
  | 'patch'
  | 'commit'
  | 'test_report'
  | 'service'
