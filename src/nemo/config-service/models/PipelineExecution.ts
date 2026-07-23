import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Pipeline } from './Pipeline';

@Entity('pipeline_executions')
@Index(['projectId', 'pipelineId', 'executionId'], { unique: true })
@Index(['pipelineId', 'status'])
@Index(['workflowId'])
export class PipelineExecution {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  pipelineId!: string;

  @ManyToOne(() => Pipeline, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pipelineId' })
  pipeline!: Pipeline;

  @Column()
  projectId!: string;

  @Column({ unique: true })
  executionId!: string;

  @Column({ unique: true })
  workflowId!: string;

  @Column({ nullable: true })
  runId?: string;

  @Column({
    type: 'enum',
    enum: ['running', 'completed', 'failed', 'cancelled', 'waiting_for_approval'],
    default: 'running',
  })
  status!: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_for_approval';

  @CreateDateColumn()
  startedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  endedAt?: Date;

  @Column('jsonb', { nullable: true })
  results?: Record<string, any>;

  @Column('jsonb', { nullable: true })
  stepResults?: Array<{
    nodeId: string;
    status: string;
    results?: Record<string, any>;
    error?: string;
  }>;

  @Column('text', { nullable: true })
  error?: string;

  @Column('jsonb', { nullable: true })
  clusterAssignments?: Record<string, string>; // nodeId -> clusterId mapping

  @Column('jsonb', { nullable: true })
  finalOutput?: Record<string, any>;

  @Column('jsonb', { nullable: true })
  parameters?: Record<string, any>;

  @Column({ nullable: true })
  userId?: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}

