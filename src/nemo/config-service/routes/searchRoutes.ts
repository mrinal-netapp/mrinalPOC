import 'reflect-metadata';
import { Router } from 'express';
import { AppDataSource } from '../db/postgres';
import { DataSource } from '../models/DataSource';
import { DataSet } from '../models/DataSet';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Search
 *   description: API endpoint for searching entities
 * /api/search:
 *   post:
 *     summary: Top-level search for any entity
 *     tags: [Search]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               entityType:
 *                 type: string
 *                 enum: [connectors, datasets]
 *               fields:
 *                 type: object
 *               nameRegex:
 *                 type: string
 *               limit:
 *                 type: integer
 *               skip:
 *                 type: integer
 *     responses:
 *       '200':
 *         description: List of matching entities
 * 
 */
router.post('/', async (req, res) => {
  try {
    const { entityType, fields = {}, nameRegex, limit = 20, skip = 0 } = req.body || {};
    if (!entityType || typeof entityType !== 'string') {
      return res.status(400).json({ error: 'entityType is required' });
    }
    const allowed = ['connectors', 'datasources', 'datasets'];
    if (!allowed.includes(entityType)) {
      return res.status(400).json({ error: 'Invalid entityType' });
    }

    let items: any[] = [];
    
    if (entityType === 'connectors' || entityType === 'datasources') {
      const repo = AppDataSource.getRepository(DataSource);
      const queryBuilder = repo.createQueryBuilder('ds');
      
      // Apply field filters
      Object.keys(fields).forEach((key) => {
        if (key === 'projectId') {
          queryBuilder.andWhere(`ds.projectId = :projectId`, { projectId: fields[key] });
        } else {
          queryBuilder.andWhere(`ds.${key} = :${key}`, { [key]: fields[key] });
        }
      });

      // For backward compat: 'connectors' search only returns type=connector
      if (entityType === 'connectors') {
        queryBuilder.andWhere('ds.type = :type', { type: 'connector' });
      }
      
      if (nameRegex) {
        queryBuilder.andWhere('ds.name ILIKE :name', { name: `%${nameRegex}%` });
      }
      
      items = await queryBuilder
        .skip(Number(skip))
        .take(Number(limit))
        .getMany();
    } else if (entityType === 'datasets') {
      const repo = AppDataSource.getRepository(DataSet);
      const queryBuilder = repo.createQueryBuilder('ds');
      
      // Apply field filters
      Object.keys(fields).forEach((key) => {
        queryBuilder.andWhere(`ds.${key} = :${key}`, { [key]: fields[key] });
      });
      
      if (nameRegex) {
        queryBuilder.andWhere('ds.name ILIKE :name', { name: `%${nameRegex}%` });
      }
      
      items = await queryBuilder
        .skip(Number(skip))
        .take(Number(limit))
        .getMany();
    }

    res.json(items);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
