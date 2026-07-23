import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { KnowledgeBase } from '../KnowledgeBase';

@Entity('knowledge_base_history')
@Index(['entityId', 'version'], { unique: true })
export class KnowledgeBaseHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  entityId!: string;

  @ManyToOne(() => KnowledgeBase, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId' })
  entity!: KnowledgeBase;

  @Column('int')
  version!: number;

  @Column('jsonb')
  data!: any;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  modifiedAt!: Date;

  @Column('text', { nullable: true })
  modifiedBy?: string;

  @Column('text', { nullable: true })
  op?: string;
}
