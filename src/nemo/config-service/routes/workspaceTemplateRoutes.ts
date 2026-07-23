import 'reflect-metadata';
import { Router, Request } from 'express';
import { WorkspaceTemplateService } from '../services/WorkspaceTemplateService';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';

const router = Router({ mergeParams: true });

interface TemplateRequest extends Request {
  params: {
    projectId: string;
    id?: string;
  };
}

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/workspace-templates:
 *   get:
 *     summary: List workspace templates
 *     tags: [WorkspaceTemplates]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: activeOnly
 *         schema: { type: boolean, default: true }
 *     responses:
 *       '200':
 *         description: List of workspace templates
 */
router.get('/', asyncHandler(async (req, res) => {
  const projectId = (req as TemplateRequest).params.projectId;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }
  const { activeOnly = 'true' } = req.query;
  const templates = await WorkspaceTemplateService.listTemplates(
    projectId,
    activeOnly === 'true'
  );
  sendSuccess(res, templates);
}));

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/workspace-templates/{id}:
 *   get:
 *     summary: Get workspace template by ID
 *     tags: [WorkspaceTemplates]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: Workspace template details
 *       '404':
 *         description: Template not found
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return sendError(res, new Error('Template ID is required'), 400);
  }
  const template = await WorkspaceTemplateService.getTemplate(id);
  if (!template) {
    return sendError(res, new Error('Workspace template not found'), 404);
  }
  sendSuccess(res, template);
}));

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/workspace-templates:
 *   post:
 *     summary: Create a new workspace template
 *     tags: [WorkspaceTemplates]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, description, type, environment]
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [jupyterlab, vscode, custom]
 *               environment:
 *                 type: object
 *               jupyterConfig:
 *                 type: object
 *               resources:
 *                 type: object
 *               startupScript:
 *                 type: string
 *     responses:
 *       '201':
 *         description: Template created successfully
 *       '400':
 *         description: Bad request
 *       '409':
 *         description: Template with this name already exists
 */
router.post('/', asyncHandler(async (req, res) => {
  const projectId = (req as TemplateRequest).params.projectId;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }
  const template = await WorkspaceTemplateService.createTemplate(projectId, req.body);
  sendSuccess(res, template, 201);
}));

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/workspace-templates/{id}:
 *   put:
 *     summary: Update workspace template
 *     tags: [WorkspaceTemplates]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               environment:
 *                 type: object
 *               isActive:
 *                 type: boolean
 *     responses:
 *       '200':
 *         description: Template updated successfully
 *       '404':
 *         description: Template not found
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const projectId = (req as TemplateRequest).params.projectId;
  const { id } = req.params;
  if (!projectId || !id) {
    return sendError(res, new Error('projectId and id are required'), 400);
  }
  const template = await WorkspaceTemplateService.updateTemplate(id, projectId, req.body);
  sendSuccess(res, template);
}));

/**
 * @swagger
 * /api/v1/namespaces/{projectId}/workspace-templates/{id}:
 *   delete:
 *     summary: Delete workspace template (soft delete)
 *     tags: [WorkspaceTemplates]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: Template deleted successfully
 *       '404':
 *         description: Template not found
 *       '400':
 *         description: Template is in use
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const projectId = (req as TemplateRequest).params.projectId;
  const { id } = req.params;
  if (!projectId || !id) {
    return sendError(res, new Error('projectId and id are required'), 400);
  }
  await WorkspaceTemplateService.deleteTemplate(id, projectId);
  sendSuccess(res, { deleted: true });
}));

export default router;

