import {
  EventSubscriber,
  EntitySubscriberInterface,
  EntityManager,
  UpdateEvent,
  RemoveEvent,
} from 'typeorm';
import { DataSource } from '../models/DataSource';
import { DataSet } from '../models/DataSet';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { MCPServer } from '../models/MCPServer';
import { Model } from '../models/Model';
import { Pipeline } from '../models/Pipeline';
import { Agent } from '../models/Agent';
import { AgentTeam } from '../models/AgentTeam';
import { EvaluationTemplate } from '../models/EvaluationTemplate';
import { DataSourceHistory } from '../models/history/DataSourceHistory';
import { DataSetHistory } from '../models/history/DataSetHistory';
import { KnowledgeBaseHistory } from '../models/history/KnowledgeBaseHistory';
import { MCPServerHistory } from '../models/history/MCPServerHistory';
import { ModelHistory } from '../models/history/ModelHistory';
import { PipelineHistory } from '../models/history/PipelineHistory';
import { AgentHistory } from '../models/history/AgentHistory';
import { AgentTeamHistory } from '../models/history/AgentTeamHistory';
import { EvaluationTemplateHistory } from '../models/history/EvaluationTemplateHistory';

/**
 * Save a history snapshot using the event's EntityManager so the write
 * participates in the same transaction as the triggering entity change.
 * This avoids acquiring a separate connection from the pool and ensures
 * transactional consistency (history is rolled back if the entity save fails).
 */
async function saveHistory(
  manager: EntityManager,
  entity: any,
  entityId: string,
  HistoryEntity: any,
  EntityClass: any,
  op: string
) {
  if (!entityId) return;

  let entityData = entity;
  if (!entityData) {
    entityData = await manager.getRepository(EntityClass).findOne({ where: { id: entityId } });
  }
  
  if (!entityData) return;

  const historyRepo = manager.getRepository(HistoryEntity);
  const lastHistory = await historyRepo.findOne({
    where: { entityId },
    order: { version: 'DESC' },
  });

  const version = lastHistory ? lastHistory.version + 1 : 1;

  const { id, createdAt, updatedAt, history, ...data } = entityData;

  await historyRepo.save({
    entityId,
    version,
    data,
    modifiedAt: new Date(),
    modifiedBy: undefined,
    op,
  });
}

@EventSubscriber()
export class DataSourceHistorySubscriber
  implements EntitySubscriberInterface<DataSource>
{
  listenTo() {
    return DataSource;
  }

  async afterUpdate(event: UpdateEvent<DataSource>) {
    const entityId = event.entity?.id || event.databaseEntity?.id;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, DataSourceHistory, DataSource, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<DataSource>) {
    const entityId = event.entity?.id || (event.databaseEntity?.id as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, DataSourceHistory, DataSource, 'delete');
    }
  }
}

@EventSubscriber()
export class DataSetHistorySubscriber
  implements EntitySubscriberInterface<DataSet>
{
  listenTo() {
    return DataSet;
  }

  async afterUpdate(event: UpdateEvent<DataSet>) {
    const entityId = event.entity?.id || event.databaseEntity?.id;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, DataSetHistory, DataSet, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<DataSet>) {
    const entityId = event.entity?.id || (event.databaseEntity?.id as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, DataSetHistory, DataSet, 'delete');
    }
  }
}

@EventSubscriber()
export class KnowledgeBaseHistorySubscriber
  implements EntitySubscriberInterface<KnowledgeBase>
{
  listenTo() {
    return KnowledgeBase;
  }

  async afterUpdate(event: UpdateEvent<KnowledgeBase>) {
    const entityId = event.entity?.id || event.databaseEntity?.id;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, KnowledgeBaseHistory, KnowledgeBase, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<KnowledgeBase>) {
    const entityId = event.entity?.id || (event.databaseEntity?.id as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, KnowledgeBaseHistory, KnowledgeBase, 'delete');
    }
  }
}

@EventSubscriber()
export class MCPServerHistorySubscriber
  implements EntitySubscriberInterface<MCPServer>
{
  listenTo() {
    return MCPServer;
  }

  async afterUpdate(event: UpdateEvent<MCPServer>) {
    const entityId = event.entity?.id || event.databaseEntity?.id;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, MCPServerHistory, MCPServer, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<MCPServer>) {
    const entityId = event.entity?.id || (event.databaseEntity?.id as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, MCPServerHistory, MCPServer, 'delete');
    }
  }
}

@EventSubscriber()
export class ModelHistorySubscriber implements EntitySubscriberInterface<Model> {
  listenTo() {
    return Model;
  }

  async afterUpdate(event: UpdateEvent<Model>) {
    const entityId = event.entity?.id || event.databaseEntity?.id;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, ModelHistory, Model, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<Model>) {
    const entityId = event.entity?.id || (event.databaseEntity?.id as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, ModelHistory, Model, 'delete');
    }
  }
}

@EventSubscriber()
export class PipelineHistorySubscriber
  implements EntitySubscriberInterface<Pipeline>
{
  listenTo() {
    return Pipeline;
  }

  async afterUpdate(event: UpdateEvent<Pipeline>) {
    const entityId = event.entity?.id || event.databaseEntity?.id;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, PipelineHistory, Pipeline, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<Pipeline>) {
    const entityId = event.entity?.id || (event.databaseEntity?.id as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, PipelineHistory, Pipeline, 'delete');
    }
  }
}

@EventSubscriber()
export class AgentHistorySubscriber
  implements EntitySubscriberInterface<Agent>
{
  listenTo() {
    return Agent;
  }

  async afterUpdate(event: UpdateEvent<Agent>) {
    const entityId = event.entity?.id || event.databaseEntity?.id;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, AgentHistory, Agent, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<Agent>) {
    const entityId = event.entity?.id || (event.databaseEntity?.id as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, AgentHistory, Agent, 'delete');
    }
  }
}

@EventSubscriber()
export class AgentTeamHistorySubscriber
  implements EntitySubscriberInterface<AgentTeam>
{
  listenTo() {
    return AgentTeam;
  }

  async afterUpdate(event: UpdateEvent<AgentTeam>) {
    const entityId = event.entity?.id || event.databaseEntity?.id;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, AgentTeamHistory, AgentTeam, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<AgentTeam>) {
    const entityId = event.entity?.id || (event.databaseEntity?.id as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, AgentTeamHistory, AgentTeam, 'delete');
    }
  }
}

@EventSubscriber()
export class EvaluationTemplateHistorySubscriber
  implements EntitySubscriberInterface<EvaluationTemplate>
{
  listenTo() {
    return EvaluationTemplate;
  }

  async afterUpdate(event: UpdateEvent<EvaluationTemplate>) {
    const entityId = event.entity?.templateId || event.databaseEntity?.templateId;
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, EvaluationTemplateHistory, EvaluationTemplate, 'update');
    }
  }

  async beforeRemove(event: RemoveEvent<EvaluationTemplate>) {
    const entityId = event.entity?.templateId || (event.databaseEntity?.templateId as string);
    if (entityId) {
      await saveHistory(event.manager, event.entity || event.databaseEntity, entityId, EvaluationTemplateHistory, EvaluationTemplate, 'delete');
    }
  }
}

