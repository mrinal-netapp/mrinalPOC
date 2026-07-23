import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Catalog of source/target entity kinds participating in dependency tracking.
 * Adding a new kind means: add it here, declare a SourceDescriptor in
 * `referenceCatalog.ts`, and (if the source mutates) wire its routes
 * through `ReferenceEdgeService`.
 */
export type EntityKind =
  | 'agent'
  | 'agent_team'
  | 'model'
  | 'pipeline'
  | 'knowledge_base'
  | 'dataset'
  | 'data_source'
  | 'mcp_server'
  | 'credential'
  | 'evaluation';

/**
 * Why does a source reference a target? Free-form string in the schema so
 * future relations can be added without a migration; documented values
 * below cover today's catalog.
 */
export type EdgeRelation =
  | 'uses_model'
  | 'uses_kb'
  | 'uses_dataset'
  | 'uses_mcp'
  | 'uses_credential'
  | 'uses_data_source'
  | 'uses_team_model'
  | 'uses_manager_agent'
  | 'has_member'
  | 'shares_kb'
  | 'shares_dataset'
  | 'evaluates_agent'
  | 'uses_judge_model'
  | 'uses_embedding_model'
  | 'graph_ref';

/**
 * Materialized directed edge from a *source* row to a *target* row that it
 * references. Read-side primitive for "Used by" lists, the dependents
 * popover, and the delete-blocker payload.
 */
@Entity('reference_edges')
@Index('idx_refedges_target', ['projectId', 'targetType', 'targetId'])
@Index('idx_refedges_source', ['projectId', 'sourceType', 'sourceId'])
export class ReferenceEdge {
  @PrimaryColumn('text')
  projectId!: string;

  @PrimaryColumn('text')
  sourceType!: EntityKind;

  @PrimaryColumn('text')
  sourceId!: string;

  @PrimaryColumn('text')
  targetType!: EntityKind;

  @PrimaryColumn('text')
  targetId!: string;

  @PrimaryColumn('text')
  relation!: EdgeRelation;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
