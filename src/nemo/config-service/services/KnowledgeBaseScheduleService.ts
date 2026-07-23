import 'reflect-metadata';
import axios, { AxiosInstance } from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { In, MoreThan } from 'typeorm';
import { AppDataSource } from '../db/postgres';
import { KnowledgeBase, KBSynchronizationConfig, KnowledgeBaseScheduleConfig } from '../models/KnowledgeBase';
import { DataSetManifest } from '../models/DataSetManifest';
import { DataSetManifestFile } from '../models/DataSetManifestFile';
import { cronFromKBSync } from '../utils/cronFromKBSync';
import { safeConsoleWarn, safeSegment, safeLog } from '../utils/safeStrings';

const WORKFLOW_ENGINE_URL =
  process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';

// workflow-engine routes are protected by AuthMiddleware when
// KEYCLOAK_INTERNAL_ISSUER is set. Use a service-account-authenticated axios
// client so schedule create/delete and fan-out trigger calls are not rejected
// with 401 in secured deployments. Falls back to unauthenticated axios when
// service account credentials are absent (dev / unsecured envs).
const workflowEngineServiceAccountClient: ServiceAccountClient | null =
  createServiceAccountClientFromEnv();
const workflowEngineClient: AxiosInstance = workflowEngineServiceAccountClient
  ? workflowEngineServiceAccountClient.createAuthenticatedClient(WORKFLOW_ENGINE_URL)
  : axios.create({
      baseURL: WORKFLOW_ENGINE_URL,
      headers: { 'Content-Type': 'application/json' },
    });

/**
 * Reconciles KnowledgeBase synchronization config -> Temporal schedule, plus
 * fan-out of KB reprocess workflows when the source dataset transitions to
 * `ready` (sync_mode='after_dataset_updates').
 *
 * Mirrors the dataset-side `DataSetService.applyRefreshConfig` pattern but is
 * driven by the user-facing `synchronizationConfig.sync_mode` enum:
 * - manual: no schedule, no auto-trigger.
 * - after_dataset_updates: no Temporal schedule; KB reprocess is enqueued
 *   when the source dataset transitions to ready (subject to the file-change
 *   threshold).
 * - scheduled: Temporal schedule is created (or replaced) targeting
 *   KnowledgeBaseCreationWorkflow.
 */
export class KnowledgeBaseScheduleService {
  /**
   * Reconcile `synchronizationConfig` -> Temporal schedule -> persisted
   * `scheduleConfig`. Returns the new `scheduleConfig` to persist on the KB
   * (or undefined to leave it unchanged).
   */
  static async applySynchronizationConfig(
    projectId: string,
    kbId: string,
    cfg: KBSynchronizationConfig | null | undefined,
    current: KnowledgeBaseScheduleConfig | undefined,
  ): Promise<KnowledgeBaseScheduleConfig | undefined> {
    if (!cfg) return current;

    const derived = cronFromKBSync(cfg);

    if (!derived) {
      // sync_mode is manual or after_dataset_updates: tear down any schedule.
      if (current?.temporalScheduleId) {
        try {
          await workflowEngineClient.delete(
            `/api/v1/projects/${safeSegment(projectId)}/knowledgebases/${safeSegment(kbId)}/schedule`,
            {
              data: { temporalScheduleId: current.temporalScheduleId },
              timeout: 5000,
            },
          );
        } catch (err: any) {
          console.warn(
            `[KnowledgeBaseScheduleService] Failed to delete Temporal schedule ${safeLog(current.temporalScheduleId)}: ${safeLog(err.message)}`,
          );
        }
      }
      return {
        cronExpression: current?.cronExpression || '',
        timezone: current?.timezone || cfg.timezone || 'UTC',
        temporalScheduleId: undefined,
        enabled: false,
      };
    }

    // sync_mode='scheduled': create-or-replace the Temporal schedule.
    try {
      const resp = await workflowEngineClient.post(
        `/api/v1/projects/${safeSegment(projectId)}/knowledgebases/${safeSegment(kbId)}/schedule`,
        {
          cronExpression: derived.cronExpression,
          timezone: derived.timezone,
          enabled: true,
          temporalScheduleId: current?.temporalScheduleId,
        },
        { timeout: 8000 },
      );
      const temporalScheduleId = resp.data?.temporalScheduleId as string | undefined;
      return {
        cronExpression: derived.cronExpression,
        timezone: derived.timezone,
        temporalScheduleId,
        enabled: true,
      };
    } catch (err: any) {
      console.warn(
        `[KnowledgeBaseScheduleService] Failed to create Temporal schedule for KB ${safeLog(kbId)} ` +
          `(cron=${safeLog(derived.cronExpression)} tz=${safeLog(derived.timezone)}): ${safeLog(err.message)}. ` +
          `Persisting cron in scheduleConfig anyway; reconcile manually.`,
      );
      return {
        cronExpression: derived.cronExpression,
        timezone: derived.timezone,
        temporalScheduleId: current?.temporalScheduleId,
        enabled: true,
      };
    }
  }

  /**
   * Tear down the Temporal schedule for a KB without re-deriving anything
   * (used on KB delete and similar cleanup paths).
   */
  static async tearDownSchedule(
    projectId: string,
    kbId: string,
    current: KnowledgeBaseScheduleConfig | undefined,
  ): Promise<void> {
    if (!current?.temporalScheduleId) return;
    try {
      await workflowEngineClient.delete(
        `/api/v1/projects/${safeSegment(projectId)}/knowledgebases/${safeSegment(kbId)}/schedule`,
        {
          data: { temporalScheduleId: current.temporalScheduleId },
          timeout: 5000,
        },
      );
    } catch (err: any) {
      console.warn(
        `[KnowledgeBaseScheduleService] Failed to delete Temporal schedule ${safeLog(current.temporalScheduleId)} on KB delete: ${safeLog(err.message)}`,
      );
    }
  }

  /**
   * Fan out KB reprocess workflows for every KB whose `sync_mode` is
   * `after_dataset_updates` and whose `sourceDataset` is the dataset that
   * just became ready. Subject to the optional file-change threshold.
   *
   * Best-effort: errors per KB are logged and skipped so a single bad KB
   * cannot block the rest.
   */
  static async fanOutAfterDatasetReady(projectId: string, datasetId: string): Promise<void> {
    const kbRepo = AppDataSource.getRepository(KnowledgeBase);
    let candidates: KnowledgeBase[] = [];
    try {
      candidates = await kbRepo
        .createQueryBuilder('kb')
        .where('kb.projectId = :projectId', { projectId })
        .andWhere('kb.sourceDataset = :datasetId', { datasetId })
        .andWhere("kb.synchronizationConfig->>'sync_mode' = :mode", {
          mode: 'after_dataset_updates',
        })
        .getMany();
    } catch (err: any) {
      console.warn(
        `[KnowledgeBaseScheduleService] Failed to query after_dataset_updates KBs for dataset ${safeLog(datasetId)}: ${safeLog(err.message)}`,
      );
      return;
    }

    if (candidates.length === 0) return;

    for (const kb of candidates) {
      try {
        if (kb.status === 'in_progress') {
          console.log(
            `[KnowledgeBaseScheduleService] Skipping KB ${safeLog(kb.id)} fan-out: already in_progress`,
          );
          continue;
        }

        const cfg = kb.synchronizationConfig;
        if (cfg?.data_change_threshold_enabled) {
          const minChanges = Number(cfg.data_change_threshold_value ?? 0);
          if (Number.isFinite(minChanges) && minChanges > 0) {
            const changedCount = await this.countDatasetFileChangesSince(
              datasetId,
              kb.lastSyncedAt,
            );
            if (changedCount < minChanges) {
              console.log(
                `[KnowledgeBaseScheduleService] KB ${safeLog(kb.id)} fan-out skipped: ${changedCount}/${minChanges} file changes since ${safeLog(kb.lastSyncedAt ?? 'epoch')}`,
              );
              continue;
            }
          }
        }

        await this.triggerKBCreationWorkflow(projectId, kb);
      } catch (err: any) {
        console.warn(
          `[KnowledgeBaseScheduleService] Failed to fan out KB reprocess for KB ${safeLog(kb.id)}: ${safeLog(err.message)}`,
        );
      }
    }
  }

  /**
   * Count dataset manifest files whose createdAt is strictly after `since`.
   * When `since` is null/undefined, returns the total committed file count
   * (so a KB that has never synced sees every existing file as a "change").
   */
  private static async countDatasetFileChangesSince(
    datasetId: string,
    since: string | undefined,
  ): Promise<number> {
    const manifestRepo = AppDataSource.getRepository(DataSetManifest);
    const fileRepo = AppDataSource.getRepository(DataSetManifestFile);

    const manifests = await manifestRepo.find({
      where: { dataSetId: datasetId, status: 'committed' as const },
      select: ['id'],
    });
    if (manifests.length === 0) return 0;

    const manifestIds = manifests.map((m) => m.id);
    const where = since
      ? { manifestId: In(manifestIds), createdAt: MoreThan(new Date(since)) }
      : { manifestId: In(manifestIds) };
    return fileRepo.count({ where });
  }

  private static async triggerKBCreationWorkflow(
    projectId: string,
    kb: KnowledgeBase,
  ): Promise<void> {
    const { KnowledgeBaseWorkflowService } = await import('./KnowledgeBaseWorkflowService');
    const result = await KnowledgeBaseWorkflowService.triggerCreationWorkflow(projectId, kb);
    if (!result.ok) {
      safeConsoleWarn(
        '[KnowledgeBaseScheduleService] KB',
        kb.id,
        'workflow not started (',
        result.reason,
        '):',
        result.message,
      );
    }
  }
}
