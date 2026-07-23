import 'reflect-metadata';
import { Router, Request } from 'express';
import { WorkspaceService } from '../services/WorkspaceService';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';

const router = Router({ mergeParams: true });

interface WorkspaceRequest extends Request {
  params: {
    projectId: string;
    id?: string;
  };
}

/**
 * @swagger
 * /api/v1/projects/{projectId}/workspaces:
 *   get:
 *     summary: List workspaces
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [new, creating, running, stopping, stopped, error] }
 *     responses:
 *       '200':
 *         description: List of workspaces
 */
router.get('/', asyncHandler(async (req, res) => {
  const projectId = (req as WorkspaceRequest).params.projectId;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }
  const { status } = req.query;
  const workspaces = await WorkspaceService.listWorkspaces(
    projectId,
    status as any
  );
  sendSuccess(res, workspaces);
}));

/**
 * @swagger
 * /api/v1/projects/{projectId}/workspaces/{id}:
 *   get:
 *     summary: Get workspace by ID
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^[0-9a-z]{8,12}$', description: 'Workspace ID (Base36, 8-12 characters)' }
 *     responses:
 *       '200':
 *         description: Workspace details
 *       '404':
 *         description: Workspace not found
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const projectId = (req as WorkspaceRequest).params.projectId;
  const { id } = req.params;
  if (!projectId || !id) {
    return sendError(res, new Error('projectId and id are required'), 400);
  }
  const workspace = await WorkspaceService.getWorkspaceOrThrow(id, projectId);
  sendSuccess(res, workspace);
}));

/**
 * @swagger
 * /api/v1/projects/{projectId}/workspaces:
 *   post:
 *     summary: Create a new workspace
 *     tags: [Workspaces]
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
 *             required: [templateId, name]
 *             properties:
 *               templateId:
 *                 type: string
 *                 type: string
 *                 description: 'Template ID (UUID)'
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               bucketName:
 *                 type: string
 *     responses:
 *       '201':
 *         description: Workspace created successfully
 *       '400':
 *         description: Bad request
 *       '409':
 *         description: Workspace with this name already exists
 */
router.post('/', asyncHandler(async (req, res) => {
  const projectId = (req as WorkspaceRequest).params.projectId;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }
  const workspace = await WorkspaceService.createWorkspace(projectId, req.body);
  sendSuccess(res, workspace, 201);
}));

/**
 * @swagger
 * /api/v1/projects/{projectId}/workspaces/{id}:
 *   put:
 *     summary: Update workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^[0-9a-z]{8,12}$', description: 'Workspace ID (Base36, 8-12 characters)' }
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
 *     responses:
 *       '200':
 *         description: Workspace updated successfully
 *       '404':
 *         description: Workspace not found
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const projectId = (req as WorkspaceRequest).params.projectId;
  const { id } = req.params;
  if (!projectId || !id) {
    return sendError(res, new Error('projectId and id are required'), 400);
  }
  const workspace = await WorkspaceService.updateWorkspace(id, projectId, req.body);
  sendSuccess(res, workspace);
}));

/**
 * @swagger
 * /api/v1/projects/{projectId}/workspaces/{id}:
 *   delete:
 *     summary: Delete workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^[0-9a-z]{8,12}$', description: 'Workspace ID (Base36, 8-12 characters)' }
 *     responses:
 *       '200':
 *         description: Workspace deleted successfully
 *       '404':
 *         description: Workspace not found
 *       '400':
 *         description: Workspace is running
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const projectId = (req as WorkspaceRequest).params.projectId;
  const { id } = req.params;
  if (!projectId || !id) {
    return sendError(res, new Error('projectId and id are required'), 400);
  }
  await WorkspaceService.deleteWorkspace(id, projectId);
  sendSuccess(res, { deleted: true });
}));

/**
 * @swagger
 * /api/v1/projects/{projectId}/workspaces/{id}/launch:
 *   post:
 *     summary: Launch workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^[0-9a-z]{8,12}$', description: 'Workspace ID (Base36, 8-12 characters)' }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               endpoint:
 *                 type: string
 *               podName:
 *                 type: string
 *               deploymentId:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Workspace launched successfully
 *       '404':
 *         description: Workspace not found
 *       '400':
 *         description: Workspace is already running
 */
router.post('/:id/launch', asyncHandler(async (req, res) => {
  const projectId = (req as WorkspaceRequest).params.projectId;
  const { id } = req.params;
  if (!projectId || !id) {
    return sendError(res, new Error('projectId and id are required'), 400);
  }
  const workspace = await WorkspaceService.launchWorkspace(id, projectId);
  sendSuccess(res, workspace);
}));

/**
 * @swagger
 * /api/v1/projects/{projectId}/workspaces/{id}/stop:
 *   post:
 *     summary: Stop workspace
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^[0-9a-z]{8,12}$', description: 'Workspace ID (Base36, 8-12 characters)' }
 *     responses:
 *       '200':
 *         description: Workspace stop initiated
 *       '404':
 *         description: Workspace not found
 */
router.post('/:id/stop', asyncHandler(async (req, res) => {
  const projectId = (req as WorkspaceRequest).params.projectId;
  const { id } = req.params;
  if (!projectId || !id) {
    return sendError(res, new Error('projectId and id are required'), 400);
  }
  const workspace = await WorkspaceService.stopWorkspace(id, projectId);
  sendSuccess(res, workspace);
}));

/**
 * @swagger
 * /api/v1/projects/{projectId}/workspaces/{id}/token:
 *   put:
 *     summary: Update workspace token (internal)
 *     tags: [Workspaces]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, pattern: '^[0-9a-z]{8,12}$', description: 'Workspace ID (Base36, 8-12 characters)' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Token updated successfully
 *       '404':
 *         description: Workspace not found
 */
router.put('/:id/token', asyncHandler(async (req, res) => {
  const projectId = (req as WorkspaceRequest).params.projectId;
  const { id } = req.params;
  const { token } = req.body;
  
  if (!projectId || !id || !token) {
    return sendError(res, new Error('projectId, id, and token are required'), 400);
  }
  
  const workspace = await WorkspaceService.updateWorkspaceToken(id, projectId, token);
  sendSuccess(res, workspace);
}));


export default router;

