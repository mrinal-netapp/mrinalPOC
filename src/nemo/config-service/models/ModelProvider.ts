import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type ProviderConnectionStatus =
  | 'unknown'
  | 'connected'
  | 'degraded'
  | 'disconnected'
  | 'error';

/**
 * Per-project, per-provider runtime configuration row.
 *
 * Concurrency and bufferSize are written at model-registration time
 * (alongside the corresponding Bifrost provider PUT) and are never
 * refreshed from Bifrost: this table is the source of truth for them.
 *
 * connectionStatus and statusMessage are populated lazily by the
 * `POST /api/v1/projects/:projectId/providers/refresh` endpoint, which
 * the UI Refresh button calls. They are derived from live Bifrost state
 * and persisted back here so subsequent reads do not need a gateway hop.
 */
@Entity('model_providers')
@Index(['projectId', 'providerId'], { unique: true })
export class ModelProvider {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  projectId!: string;

  /** Bifrost-side provider name (e.g. `openai`, `azure`, `bedrock`, `gemini`, `ollama`). */
  @Column()
  providerId!: string;

  /** Operator-facing display name. */
  @Column()
  name!: string;

  @Column({ type: 'varchar', default: 'unknown' })
  connectionStatus!: ProviderConnectionStatus;

  /**
   * Matches the Bifrost fallback used by `bifrostProviderOps.ts`
   * (`{ concurrency: 1000, buffer_size: 5000 }`) so rows created
   * without an explicit override line up with what Bifrost would
   * apply on its own.
   */
  @Column({ type: 'int', default: 1000 })
  concurrency!: number;

  @Column({ type: 'int', default: 5000 })
  bufferSize!: number;

  @Column({ type: 'text', nullable: true })
  statusMessage?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
