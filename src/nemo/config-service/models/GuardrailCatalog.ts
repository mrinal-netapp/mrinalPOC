import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Phase of the agent run loop a guardrail applies to. The runtime keeps
 * separate input / output namespaces, so the same `key` may exist once per
 * stage with different defaults (see the unique index below).
 */
export type GuardrailStage = 'input' | 'output' | 'tool';

/**
 * Catalog of available guardrail definitions. One row per guardrail the UI
 * lists and an agent can add. config-service stores these definitions and
 * serves them by id; agent-service resolves an agent's referenced guardrails
 * against this catalog at agent-creation time.
 *
 * Definitions are populated through the CRUD API — config-service does not
 * seed them or validate `key` against the runtime guardrail registry.
 */
@Entity('guardrails_catalog')
@Index(['stage', 'key'], { unique: true })
export class GuardrailCatalog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Dispatch slug mapped to the runtime implementation (e.g. `pii_masker`). */
  @Column('text')
  key!: string;

  @Column('text')
  stage!: GuardrailStage;

  /** Display name surfaced in the UI. */
  @Column('text', { name: 'display_name' })
  displayName!: string;

  @Column('text')
  description!: string;

  /** Category, e.g. `privacy`, `security`, `safety`, `validation`, `content_policy`, `accuracy`. */
  @Column('text')
  type!: string;

  /** Actions this guardrail may produce, e.g. `['block','warn','modify']`. */
  @Column('text', { name: 'supported_actions', array: true })
  supportedActions!: string[];

  /**
   * Availability flag — when true the guardrail is published so the UI lists
   * it and a user may add it while configuring an agent. Not a per-agent
   * toggle.
   */
  @Column('boolean', { default: true })
  enabled!: boolean;

  /** Default ordering hint within a stage. */
  @Column('int', { default: 100 })
  priority!: number;

  /** Default action; one of `supportedActions`. */
  @Column('text', { name: 'default_action' })
  defaultAction!: string;

  /** Default trigger message. */
  @Column('text')
  message!: string;

  /** Per-guardrail settings body (varies by guardrail). */
  @Column('jsonb', { default: '{}' })
  config!: Record<string, unknown>;

  /** Optional JSON Schema validating `config`; drives validation + dynamic UI forms. */
  @Column('jsonb', { name: 'config_schema', nullable: true })
  configSchema?: Record<string, unknown>;

  /** Definition version, bumped on change (informational only). */
  @Column('int', { default: 1 })
  version!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
