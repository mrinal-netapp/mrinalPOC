import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import 'reflect-metadata';
import { Router } from 'express';
import axios from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { AppDataSource } from '../db/postgres';
import { Pipeline } from '../models/Pipeline';
import { PipelineExecution } from '../models/PipelineExecution';
import { PipelineHistory } from '../models/history/PipelineHistory';
import { createPipelineValidator, updatePipelineValidator } from '../validators/pipelineValidator';
import { validationResult } from 'express-validator';
import { Not } from 'typeorm';
import { validateProject } from '../middleware/projectValidator';
import {
  applyForEntity,
  removeForSource,
  summaryForTargets,
  listDependents,
} from '../services/ReferenceEdgeService';

const router = Router({ mergeParams: true });

const workflowEngineUrl = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
const workflowEngineServiceAccountClient: ServiceAccountClient | null = createServiceAccountClientFromEnv();
const workflowEngineClient = workflowEngineServiceAccountClient
  ? workflowEngineServiceAccountClient.createAuthenticatedClient(workflowEngineUrl)
  : axios.create({
      baseURL: workflowEngineUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

if (workflowEngineServiceAccountClient) {
  logger.info(`[PipelineRoutes] Workflow-engine client initialized with service account authentication: ${workflowEngineUrl}`);
} else {
  logger.warn(`[PipelineRoutes] Workflow-engine client initialized without service account authentication: ${workflowEngineUrl}`);
}

/**
 * @swagger
 * components:
 *   schemas:
 *     Pipeline:
 *       type: object
 *       required: [name, graph]
 *       properties:
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         type:
 *           type: string
 *           enum: [Data, API]
 *           default: Data
 *         graph:
 *           type: object
 *           properties:
 *             nodes:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   type:
 *                     type: string
 *                     enum: [dataset, agent, knowledgebase, decision, code]
 *                   config:
 *                     type: object
 *                   metadata:
 *                     type: object
 *             edges:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   from:
 *                     type: string
 *                   to:
 *                     type: string
 *                   config:
 *                     type: object
 * tags:
 *   name: Pipelines
 *   description: API endpoints for managing Pipelines
 * /api/pipelines:
 *   get:
 *     summary: List pipelines
 *     tags: [Pipelines]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: skip
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: field
 *         schema: { type: string }
 *       - in: query
 *         name: value
 *         schema: { type: string }
 *       - in: query
 *         name: nameRegex
 *         schema: { type: string }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [Data, API] }
 *         description: Filter pipelines by type
 *     responses:
 *       '200':
 *         description: List of pipelines
 *   post:
 *     summary: Create a pipeline
 *     tags: [Pipelines]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Pipeline'
 *     responses:
 *       '201':
 *         description: Created
 * /api/pipelines/{id}:
 *   get:
 *     summary: Get pipeline by ID
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: Pipeline
 *       '404':
 *         description: Not found
 *   put:
 *     summary: Update pipeline by ID
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Pipeline'
 *     responses:
 *       '200':
 *         description: Updated
 *       '404':
 *         description: Not found
 *   delete:
 *     summary: Delete pipeline by ID
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: Deleted
 *       '404':
 *         description: Not found
 */

router.post('/', validateProject, createPipelineValidator, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Pipeline);
    const exists = await repo.findOne({ where: { projectId, name: req.body.name.trim() } });
    if (exists) {
      return res.status(409).json({ error: 'Pipeline with this name already exists in this project' });
    }

    const saved = await AppDataSource.transaction(async (manager) => {
      const pipeline = manager.getRepository(Pipeline).create({ ...req.body, projectId });
      const result = await manager.getRepository(Pipeline).save(pipeline);
      // Non-array overload result; TypeORM widens to T | T[]. The wrapper
      // ignores arrays and rows missing `id`, so this is safe.
      await applyForEntity(manager, 'pipeline', projectId, result as unknown);
      return result;
    });
    res.status(201).json(saved);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// List with pagination and filtering
router.get('/', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const { limit = 20, skip = 0, field, value, nameRegex, type } = req.query;
    const repo = AppDataSource.getRepository(Pipeline);
    const queryBuilder = repo.createQueryBuilder('pipeline');
    queryBuilder.where('pipeline.projectId = :projectId', { projectId });

    if (field && value) {
      queryBuilder.andWhere(`pipeline.${field as string} = :value`, { value });
    }
    if (nameRegex) {
      queryBuilder.andWhere('pipeline.name ILIKE :name', { name: `%${nameRegex}%` });
    }
    if (type && (type === 'Data' || type === 'API')) {
      queryBuilder.andWhere('pipeline.type = :type', { type });
    }

    const items = await queryBuilder
      .skip(Number(skip))
      .take(Number(limit))
      .getMany();

    const includeSummary =
      (req.query.include as string | undefined) !== 'dependentsSummary=false';
    if (!includeSummary || items.length === 0) {
      return res.json(items);
    }
    const summary = await summaryForTargets('pipeline', projectId, items.map((p) => p.id));
    const enriched = items.map((p) => ({
      ...p,
      dependentsSummary: summary.get(p.id) ?? { total: 0, byKind: {} },
    }));
    res.json(enriched);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/dependents', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Pipeline);
    const exists = await repo.findOne({
      where: { id: req.params.id, projectId },
      select: { id: true } as any,
    });
    if (!exists) return res.status(404).json({ error: 'Pipeline not found' });

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const kind = (req.query.kind as string | undefined) || undefined;
    const page = await listDependents('pipeline', projectId, req.params.id, {
      limit,
      cursor,
      kind,
    });
    res.json(page);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Pipeline);
    const item = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!item) return res.status(404).json({ error: 'Pipeline not found' });
    res.json(item);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', validateProject, updatePipelineValidator, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Pipeline);
    const currentPipeline = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!currentPipeline) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    
    // Only check for duplicate name if name is being updated and is not empty
    if (req.body.name !== undefined && req.body.name !== null && req.body.name.trim() !== '') {
      // Only check for duplicates if the name is actually changing
      if (currentPipeline.name !== req.body.name.trim()) {
        const exists = await repo.findOne({
          where: { projectId, name: req.body.name.trim(), id: Not(req.params.id) },
        });
        if (exists) {
          return res.status(409).json({ error: 'Pipeline with this name already exists in this project' });
        }
      }
    }
    
    // Filter out undefined values to avoid overwriting fields with undefined
    const updateData: any = {};
    Object.keys(req.body).forEach(key => {
      if (req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    });
    
    const updated = await AppDataSource.transaction(async (manager) => {
      const txRepo = manager.getRepository(Pipeline);
      if (Object.keys(updateData).length > 0) {
        await txRepo.update({ id: req.params.id, projectId }, { ...updateData, projectId });
      }
      const fresh = await txRepo.findOne({ where: { id: req.params.id, projectId } });
      if (fresh) {
        await applyForEntity(manager, 'pipeline', projectId, fresh);
      }
      return fresh;
    });
    if (!updated) return res.status(404).json({ error: 'Pipeline not found' });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(Pipeline);
    const item = await repo.findOne({ where: { id: req.params.id, projectId } });
    if (!item) return res.status(404).json({ error: 'Pipeline not found' });

    // Terminate running pipeline execution workflows before deletion
    try {
      await workflowEngineClient.post(
        `/api/v1/projects/${projectId}/pipelines/${req.params.id}/terminate`
      );
    } catch (terminateErr: any) {
      logger.warn(`Failed to terminate workflows for pipeline ${req.params.id}: ${terminateErr.message}`);
    }

    const deleted = await AppDataSource.transaction(async (manager) => {
      const result = await manager.getRepository(Pipeline).delete({ id: req.params.id, projectId });
      // Drop pipeline's outgoing graph_ref edges. (Incoming edges, e.g. a
      // workflow block in another pipeline pointing at this one, remain
      // until that source pipeline is rewritten — the reconciler also
      // catches stale targets.)
      await removeForSource(manager, 'pipeline', projectId, req.params.id);
      return result;
    });
    if (deleted.affected === 0) return res.status(404).json({ error: 'Pipeline not found' });
    res.json({ deleted: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// List all history versions for a Pipeline
/**
 * @swagger
 * /api/pipelines/{id}/history:
 *   get:
 *     summary: List all history versions for a Pipeline
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pipeline ID
 *     responses:
 *       200:
 *         description: List of history versions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       404:
 *         description: Not found
 */
router.get('/:id/history', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const pipelineRepo = AppDataSource.getRepository(Pipeline);
    const pipeline = await pipelineRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!pipeline) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    const repo = AppDataSource.getRepository(PipelineHistory);
    const history = await repo.find({
      where: { entityId: req.params.id },
      order: { version: 'DESC' },
    });
    if (!history || history.length === 0) return res.status(404).json({ error: 'No history found for this Pipeline' });
    res.json(history);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /api/pipelines/{id}/restore-version:
 *   post:
 *     summary: Restore a Pipeline to a previous version
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Pipeline ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               version:
 *                 type: number
 *                 description: Version number to restore
 *     responses:
 *       200:
 *         description: Pipeline restored to previous version
 *       404:
 *         description: Not found
 */
router.post('/:id/restore-version', validateProject, async (req, res) => {
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return res.status(400).json({ error: 'version (number) is required in body' });
  }
  try {
    const projectId = req.params.projectId;
    const historyRepo = AppDataSource.getRepository(PipelineHistory);
    const pipelineRepo = AppDataSource.getRepository(Pipeline);
    const pipeline = await pipelineRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!pipeline) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    const history = await historyRepo.findOne({
      where: { entityId: req.params.id, version },
    });
    if (!history) return res.status(404).json({ error: 'Version not found in history' });
    
    const { data } = history;
    const { id, createdAt, updatedAt, ...restoreData } = data;

    const updated = await AppDataSource.transaction(async (manager) => {
      await manager.getRepository(Pipeline).update(
        { id: req.params.id, projectId },
        { ...restoreData, projectId },
      );
      const fresh = await manager.getRepository(Pipeline).findOne({
        where: { id: req.params.id, projectId },
      });
      if (fresh) {
        await applyForEntity(manager, 'pipeline', projectId, fresh);
      }
      return fresh;
    });
    if (!updated) return res.status(404).json({ error: 'Pipeline not found' });
    res.json({ restored: true, data: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Pipeline Execution API endpoints
/**
 * @swagger
 * /api/pipelines/{id}/execute:
 *   post:
 *     summary: Execute a pipeline
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               parameters:
 *                 type: object
 *     responses:
 *       201:
 *         description: Execution started
 *       404:
 *         description: Pipeline not found
 */
router.post('/:id/execute', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const pipelineId = req.params.id;
    const { parameters } = req.body || {};

    const repo = AppDataSource.getRepository(Pipeline);
    const pipeline = await repo.findOne({ where: { id: pipelineId, projectId } });
    if (!pipeline) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }

    // Call workflow-engine service to start execution
    try {
      const response = await workflowEngineClient.post(
        `/api/v1/projects/${projectId}/pipelines/${pipelineId}/executions`,
        { parameters },
        { headers: { 'Content-Type': 'application/json' } }
      );
      res.status(201).json(response.data);
    } catch (error: any) {
      const status = error.response?.status || 500;
      const errorMessage = error.response?.data?.error || error.message;
      return res.status(status).json({ error: errorMessage });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /api/pipelines/{id}/executions:
 *   get:
 *     summary: List pipeline executions
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of executions
 */
router.get('/:id/executions', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const pipelineId = req.params.id;

    const pipelineRepo = AppDataSource.getRepository(Pipeline);
    const pipeline = await pipelineRepo.findOne({ where: { id: pipelineId, projectId } });
    if (!pipeline) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }

    const executionRepo = AppDataSource.getRepository(PipelineExecution);
    const executions = await executionRepo.find({
      where: { pipelineId, projectId },
      order: { startedAt: 'DESC' },
    });

    res.json(executions);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /api/pipelines/{id}/executions/{executionId}:
 *   get:
 *     summary: Get pipeline execution
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: executionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Execution details
 *       404:
 *         description: Execution not found
 */
router.get('/:id/executions/:executionId', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const pipelineId = req.params.id;
    const executionId = req.params.executionId;

    const executionRepo = AppDataSource.getRepository(PipelineExecution);
    const execution = await executionRepo.findOne({
      where: { pipelineId, projectId, executionId },
    });

    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    res.json(execution);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /api/pipelines/{id}/executions/{executionId}/cancel:
 *   post:
 *     summary: Cancel pipeline execution
 *     tags: [Pipelines]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: executionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Execution cancelled
 *       404:
 *         description: Execution not found
 */
// Update pipeline execution (used by workflow-engine to persist step results and status)
router.put('/:id/executions/:executionId', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const pipelineId = req.params.id;
    const executionId = req.params.executionId;

    const executionRepo = AppDataSource.getRepository(PipelineExecution);
    const execution = await executionRepo.findOne({
      where: { pipelineId, projectId, executionId },
    });

    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    const { status, stepResults, finalOutput, error: errorMsg, endedAt } = req.body;

    if (status) execution.status = status;
    if (stepResults) execution.stepResults = stepResults;
    if (finalOutput) execution.finalOutput = finalOutput;
    if (errorMsg) execution.error = errorMsg;
    if (endedAt) execution.endedAt = new Date(endedAt);
    if (status === 'completed' || status === 'failed') {
      execution.endedAt = execution.endedAt || new Date();
    }

    await executionRepo.save(execution);
    res.json(execution);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Update a single step result within an execution
router.put('/:id/executions/:executionId/steps', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const pipelineId = req.params.id;
    const executionId = req.params.executionId;

    const executionRepo = AppDataSource.getRepository(PipelineExecution);
    const execution = await executionRepo.findOne({
      where: { pipelineId, projectId, executionId },
    });

    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    const { nodeId, stepResult } = req.body;
    if (!nodeId || !stepResult) {
      return res.status(400).json({ error: 'nodeId and stepResult are required' });
    }

    const steps = execution.stepResults || [];
    const existingIdx = steps.findIndex((s: any) => s.nodeId === nodeId);
    if (existingIdx >= 0) {
      steps[existingIdx] = stepResult;
    } else {
      steps.push(stepResult);
    }
    execution.stepResults = steps;

    await executionRepo.save(execution);
    res.json(execution);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Resume a paused HIL execution (proxies to workflow-engine)
router.post('/:id/executions/:executionId/resume', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const pipelineId = req.params.id;
    const executionId = req.params.executionId;

    try {
      const response = await workflowEngineClient.post(
        `/api/v1/projects/${projectId}/pipelines/${pipelineId}/executions/${executionId}/resume`,
        req.body,
        { headers: { 'Content-Type': 'application/json' } }
      );
      res.json(response.data);
    } catch (error: any) {
      const status = error.response?.status || 500;
      const errorMessage = error.response?.data?.error || error.message;
      return res.status(status).json({ error: errorMessage });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/executions/:executionId/cancel', validateProject, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const pipelineId = req.params.id;
    const executionId = req.params.executionId;

    // Call workflow-engine service to cancel execution
    try {
      const response = await workflowEngineClient.post(
        `/api/v1/projects/${projectId}/pipelines/${pipelineId}/executions/${executionId}/cancel`,
        {},
        { headers: { 'Content-Type': 'application/json' } }
      );
      res.json(response.data);
    } catch (error: any) {
      const status = error.response?.status || 500;
      const errorMessage = error.response?.data?.error || error.message;
      return res.status(status).json({ error: errorMessage });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

