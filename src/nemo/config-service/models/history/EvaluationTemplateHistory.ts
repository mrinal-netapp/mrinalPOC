import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EvaluationTemplate } from '../EvaluationTemplate';

@Entity('evaluation_template_history')
@Index(['entityId', 'version'], { unique: true })
export class EvaluationTemplateHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { length: 12 })
  entityId!: string;

  @ManyToOne(() => EvaluationTemplate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId', referencedColumnName: 'templateId' })
  entity!: EvaluationTemplate;

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
