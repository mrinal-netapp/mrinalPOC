import { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../db/postgres';
import { Project } from '../models/Project';

export async function validateProject(req: Request, res: Response, next: NextFunction) {
  const projectId = req.params.projectId;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }
  try {
    const projectRepo = AppDataSource.getRepository(Project);
    const project = await projectRepo.findOne({ where: { id: projectId } });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    next();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

