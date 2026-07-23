import { body, ValidationChain } from 'express-validator';
import { NodeType, PipelineGraph } from '../models/Pipeline';

// Custom validator for graph structure
const validateGraph = (value: any): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return false;
  }
  
  // Validate nodes
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!node.id || typeof node.id !== 'string') {
      return false;
    }
    if (!node.type || typeof node.type !== 'string') {
      return false;
    }
    if (nodeIds.has(node.id)) {
      return false; // Duplicate node id
    }
    nodeIds.add(node.id);
  }
  
  // Validate edges
  for (const edge of value.edges) {
    if (!edge.from || !edge.to || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      return false;
    }
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      return false; // Edge references non-existent node
    }
  }
  
  return true;
};

export const createPipelineValidator: ValidationChain[] = [
  body('name').isString().notEmpty().trim(),
  body('description').optional().isString(),
  body('type').optional().isIn(['Data', 'API']).withMessage('Type must be either "Data" or "API"'),
  body('graph')
    .custom(validateGraph)
    .withMessage('Graph must have valid nodes and edges structure'),
];

export const updatePipelineValidator: ValidationChain[] = [
  body('name').optional().isString().notEmpty().trim(),
  body('description').optional().isString(),
  body('type').optional().isIn(['Data', 'API']).withMessage('Type must be either "Data" or "API"'),
  body('graph')
    .optional()
    .custom(validateGraph)
    .withMessage('Graph must have valid nodes and edges structure'),
];

