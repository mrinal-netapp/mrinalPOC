import { In } from 'typeorm';
import { AppDataSource } from '../db/postgres';
import { Facet, FacetEntityType, FacetState } from '../models/Facet';

const facetRepo = () => AppDataSource.getRepository(Facet);

export interface UpdateFacetStateOptions {
  jobId?: string;
  errorMessage?: string;
  summary?: Record<string, any>;
  expectedJobId?: string; // For conditional PUT (Layer 3 guard)
}

export class FacetService {
  /**
   * List all facets for a given entity
   */
  static async listFacets(
    projectId: string,
    entityType: FacetEntityType,
    entityId: string
  ): Promise<Facet[]> {
    return facetRepo().find({
      where: { projectId, entityType, entityId },
      order: { facetType: 'ASC' },
    });
  }

  /**
   * Batch-load facets for multiple entities in a single query.
   * Returns a Map keyed by entityId.
   */
  static async listFacetsBatch(
    projectId: string,
    entityType: FacetEntityType,
    entityIds: string[]
  ): Promise<Map<string, Facet[]>> {
    if (entityIds.length === 0) return new Map();
    const facets = await facetRepo().find({
      where: { projectId, entityType, entityId: In(entityIds) },
      order: { facetType: 'ASC' },
    });
    const grouped = new Map<string, Facet[]>();
    for (const f of facets) {
      const list = grouped.get(f.entityId) ?? [];
      list.push(f);
      grouped.set(f.entityId, list);
    }
    return grouped;
  }

  /**
   * Get a single facet by entity and facet type
   */
  static async getFacet(
    projectId: string,
    entityType: FacetEntityType,
    entityId: string,
    facetType: string
  ): Promise<Facet | null> {
    return facetRepo().findOne({
      where: { projectId, entityType, entityId, facetType },
    });
  }

  /**
   * Upsert a facet row (create or update).
   * Uses INSERT ON CONFLICT DO NOTHING + SELECT for safe concurrent creation.
   */
  static async upsertFacet(
    projectId: string,
    entityType: FacetEntityType,
    entityId: string,
    facetType: string,
    data: { state: FacetState; jobId?: string; errorMessage?: string; summary?: Record<string, any> }
  ): Promise<Facet> {
    const repo = facetRepo();

    // Try insert, ignore conflict
    await repo
      .createQueryBuilder()
      .insert()
      .into(Facet)
      .values({
        projectId,
        entityType,
        entityId,
        facetType,
        state: data.state,
        jobId: data.jobId || undefined,
        errorMessage: data.errorMessage || undefined,
        summary: data.summary || undefined,
      })
      .orIgnore() // ON CONFLICT DO NOTHING
      .execute();

    // Now update if the row already existed (or was just created)
    const existing = await repo.findOne({
      where: { projectId, entityType, entityId, facetType },
    });

    if (!existing) {
      throw new Error('Failed to upsert facet: row not found after insert');
    }

    // Apply updates
    existing.state = data.state;
    existing.jobId = data.jobId || null as any;
    existing.errorMessage = data.errorMessage || null as any;
    if (data.summary !== undefined) {
      existing.summary = data.summary;
    }

    return repo.save(existing);
  }

  /**
   * Update facet state with conditional jobId validation (Layer 3 guard).
   *
   * Rules:
   * - If facet is in_progress with non-null jobId: incoming expectedJobId must match.
   * - If facet is ready/errored or has no jobId: PUT succeeds unconditionally.
   * - Summary is accepted when state === 'ready'.
   * - On ready/errored: jobId is cleared.
   */
  static async updateFacetState(
    projectId: string,
    entityType: FacetEntityType,
    entityId: string,
    facetType: string,
    state: FacetState,
    opts: UpdateFacetStateOptions = {}
  ): Promise<Facet> {
    const repo = facetRepo();
    let facet = await repo.findOne({
      where: { projectId, entityType, entityId, facetType },
    });

    // If facet doesn't exist, create it
    if (!facet) {
      facet = repo.create({
        projectId,
        entityType,
        entityId,
        facetType,
        state,
        jobId: state === 'in_progress' ? opts.jobId : undefined,
        errorMessage: state === 'errored' ? opts.errorMessage : undefined,
        summary: state === 'ready' ? opts.summary : undefined,
      });
      return repo.save(facet);
    }

    // Layer 3: Conditional jobId validation
    if (facet.state === 'in_progress' && facet.jobId && opts.expectedJobId) {
      if (facet.jobId !== opts.expectedJobId) {
        throw new ConflictError(
          `Facet jobId mismatch: expected '${opts.expectedJobId}', current '${facet.jobId}'`
        );
      }
    }

    // Apply state transition
    facet.state = state;

    if (state === 'in_progress') {
      facet.jobId = opts.jobId || null as any;
      facet.errorMessage = null as any;
    } else if (state === 'ready') {
      facet.jobId = null as any;
      facet.errorMessage = null as any;
      if (opts.summary !== undefined) {
        facet.summary = opts.summary;
      }
    } else if (state === 'errored') {
      facet.jobId = null as any;
      if (opts.errorMessage) {
        facet.errorMessage = opts.errorMessage;
      }
      // Preserve existing summary from prior successful run
    }

    return repo.save(facet);
  }

  /**
   * Atomically start a facet job (Layer 1 guard).
   * Returns { started: true, facet } if the facet was transitioned to in_progress.
   * Returns { started: false, facet } if it was already in_progress (idempotent).
   */
  static async startFacetJob(
    projectId: string,
    entityType: FacetEntityType,
    entityId: string,
    facetType: string,
    jobId: string
  ): Promise<{ started: boolean; facet: Facet }> {
    const repo = facetRepo();

    // Try atomic update: only transition if NOT currently in_progress
    const result = await repo
      .createQueryBuilder()
      .update(Facet)
      .set({ state: 'in_progress', jobId, errorMessage: undefined })
      .where(
        'projectId = :projectId AND "entityType" = :entityType AND "entityId" = :entityId AND "facetType" = :facetType AND state != :inProgress',
        { projectId, entityType, entityId, facetType, inProgress: 'in_progress' }
      )
      .execute();

    if (result.affected && result.affected > 0) {
      const facet = await repo.findOneOrFail({
        where: { projectId, entityType, entityId, facetType },
      });
      return { started: true, facet };
    }

    // Check if row exists at all
    let facet = await repo.findOne({
      where: { projectId, entityType, entityId, facetType },
    });

    if (facet) {
      // Already in_progress — idempotent
      return { started: false, facet };
    }

    // No row exists: create one in in_progress state
    facet = repo.create({
      projectId,
      entityType,
      entityId,
      facetType,
      state: 'in_progress',
      jobId,
    });
    facet = await repo.save(facet);
    return { started: true, facet };
  }

  /**
   * Lazy backfill: create a facet in 'ready' state if it doesn't exist.
   * Uses INSERT ON CONFLICT DO NOTHING to handle concurrent backfills safely.
   */
  static async lazyBackfill(
    projectId: string,
    entityType: FacetEntityType,
    entityId: string,
    facetType: string,
    summary: Record<string, any>
  ): Promise<Facet | null> {
    const repo = facetRepo();

    await repo
      .createQueryBuilder()
      .insert()
      .into(Facet)
      .values({
        projectId,
        entityType,
        entityId,
        facetType,
        state: 'ready',
        summary,
      })
      .orIgnore()
      .execute();

    return repo.findOne({
      where: { projectId, entityType, entityId, facetType },
    });
  }

  /**
   * Delete all facets scoped to a project.
   * Used during project deletion to clean up orphaned facet rows.
   */
  static async deleteForProject(projectId: string): Promise<number> {
    const result = await facetRepo().delete({ projectId });
    return result.affected ?? 0;
  }
}

/**
 * Thrown when a facet update conflicts (e.g. jobId mismatch)
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
