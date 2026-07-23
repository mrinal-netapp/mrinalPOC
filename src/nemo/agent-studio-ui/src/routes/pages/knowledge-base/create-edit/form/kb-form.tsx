import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useNavigate, useBlocker } from 'react-router';
import { useForm } from '@tanstack/react-form';
import { useStore } from '@tanstack/react-store';
import { IconX } from '@tabler/icons-react';

import type { KBDetail } from '@/api/kb.types';
import {
  useCreateKnowledgeBaseMutation,
  useUpdateKnowledgeBaseMutation,
  useValidateKBNameMutation,
} from '@/api/kb-api.slice';
import { useAppSelector } from '@/store';
import { projectContextSelector } from '@/store/selectors/project-context.selector';
import { Form, runFormHandleSubmit } from '@/ui-lib/base-components/form';
import type { AnyReactFormApi } from '@/ui-lib/base-components/form/form.types';
import { Button } from '@/ui-lib/base-components/button/button';
import { Typography } from '@/ui-lib/base-components/typography/typography';
import { Card } from '@/ui-lib/base-components/card/card';
import { CardContent } from '@/ui-lib/base-components/card/card.content';
import { CardBlock } from '@/ui-lib/base-components/card/card.block';
import { ConfirmDialog } from '@/components/dialog/confirm-dialog/confirm-dialog';
import { toast } from '@/ui-lib/base-components/toast/toast';
import { showKBWorkflowOutcomeToast } from '@/components/knowledge-base/utils/kb-workflow-outcome.utils';

import { kbPaths } from '@/routes/pages/knowledge-base/knowledge-base.consts';

import { KB_NAME_PATTERN } from './kb-form.consts';
import { DEFAULT_LABEL_ITEMS } from '@/routes/pages/data-management/dataset/create-edit/form/dataset-form.consts';
import {
  buildKBCreatePayload,
  buildKBDefaultValues,
  buildKBEditDelta,
} from './kb-form.utils';
import { validateKBFormOnSubmit, validateKBNameAsync } from './kb-form.validation';
import { KBDetailsSection } from './kb-details-section';
import { KBDatasetConfigSection } from './kb-dataset-config-section';
import { KBSyncSettingsSection } from './kb-sync-settings-section';
import { KBDataChangeThresholdSection } from './kb-data-change-threshold-section';
import { KBEmbeddingChunkingSection } from './kb-embedding-chunking-section';
import { KBIndexingConfigSection } from './kb-indexing-config-section';
import { KBEstimateSummarySection } from './kb-estimate-summary-section';

import '../../../data-management/dataset/create-edit/form/dataset-form.scss';
import './kb-form.scss';

interface KBFormProps {
  isEdit?: boolean;
  initialData?: KBDetail;
}

const SHOW_KB_ESTIMATE_SUMMARY_PLACEHOLDER = false;

function KBForm({ isEdit = false, initialData }: KBFormProps): ReactElement {
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);

  const [createKnowledgeBase, { isLoading: isCreating }] = useCreateKnowledgeBaseMutation();
  const [updateKnowledgeBase, { isLoading: isUpdating }] = useUpdateKnowledgeBaseMutation();
  const [validateName] = useValidateKBNameMutation();

  const isSubmitting = isCreating || isUpdating;
  const pageTitle = isEdit ? 'Edit knowledge base' : 'Add new knowledge base';
  const submitLabel = isEdit ? 'Save' : 'Add';

  const defaultValues = useMemo(() => buildKBDefaultValues(initialData), [initialData]);

  const [labelItems, setLabelItems] = useState(() => {
    const items = [...DEFAULT_LABEL_ITEMS];
    if (initialData?.labels) {
      for (const label of initialData.labels) {
        if (!items.some((item) => item.value === label)) {
          items.push({ key: label, value: label, label });
        }
      }
    }
    return items;
  });

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: validateKBFormOnSubmit(isEdit),
    },
    onSubmit: async ({ value }) => {
      try {
        if (isEdit && initialData) {
          const delta = buildKBEditDelta(value, initialData);
          if (Object.keys(delta).length === 0) {
            toast.info('No changes to save.');
            return;
          }
          const result = await updateKnowledgeBase({
            projectId,
            kbId: initialData.kb_id,
            body: delta,
          }).unwrap();
          showKBWorkflowOutcomeToast('update', result);
          navigate(kbPaths.detail(initialData.kb_id));
        } else {
          const result = await createKnowledgeBase({ projectId, body: buildKBCreatePayload(value) }).unwrap();
          showKBWorkflowOutcomeToast('create', result);
          navigate(kbPaths.root);
        }
      } catch (err: unknown) {
        const status = (err as { status?: number } | null)?.status;
        const data = (err as { data?: { error?: string } } | null)?.data;
        if (status === 409 && typeof data?.error === 'string') {
          toast.error(data.error);
        } else {
          toast.error(isEdit ? 'Failed to update knowledge base.' : 'Failed to create knowledge base.');
        }
      }
    },
  }) as unknown as AnyReactFormApi;

  const handleAddLabel = useCallback((value: string) => {
    const trimmed = value.trim().toLowerCase();
    /* v8 ignore if -- @preserve: SelectDropdown never calls onAddNew with blank text */
    if (!trimmed) return;
    setLabelItems((prev) => {
      /* v8 ignore if -- @preserve: SelectDropdown disables "Add" for existing items */
      if (prev.some((item) => item.value === trimmed)) return prev;
      return [...prev, { key: trimmed, value: trimmed, label: trimmed }];
    });
    const current = (form.state.values.labels as string[]) ?? [];
    if (!current.includes(trimmed)) {
      form.setFieldValue('labels', [...current, trimmed]);
    }
  }, [form]);

  const isDirty = useStore(form.store, (s) => s.isDirty);
  const blocker = useBlocker(isDirty && !isSubmitting);
  const isBlocked = blocker.state === 'blocked';

  const navigateBack = useCallback(() => {
    if (isEdit && initialData) {
      navigate(kbPaths.detail(initialData.kb_id));
    } else {
      navigate(kbPaths.root);
    }
  }, [isEdit, initialData, navigate]);

  const nameValidatorSync = useCallback(
    ({ value }: { value: string }): string | undefined => {
      if (isEdit) return undefined;
      const trimmed = value.trim();
      if (!trimmed) return 'Name is required';
      if (trimmed.length < 3) return 'Name must be at least 3 characters';
      if (!KB_NAME_PATTERN.test(trimmed)) {
        return 'Name may only contain letters, numbers, spaces, hyphens, and underscores';
      }
      return undefined;
    },
    [isEdit],
  );

  const nameValidatorAsync = useCallback(
    async ({ value }: { value: string }): Promise<string | undefined> => {
      if (isEdit) return undefined;
      const trimmed = value.trim();
      /* v8 ignore start -- short-circuits async call for invalid names; pattern tested in validation unit tests */
      if (!KB_NAME_PATTERN.test(trimmed) || trimmed.length < 3) return undefined;
      /* v8 ignore stop */
      return validateKBNameAsync(trimmed, validateName);
    },
    [isEdit, validateName],
  );

  return (
    <div className="dset-form-page">
      <div className="dset-form-page__top-bar">
        <Typography Component="h1" fontSize="fs16" boldness="semibold" className="dset-form-page__top-bar-title">
          {pageTitle}
        </Typography>
        <Button variant="icon" icon={<IconX size={20} />} onClick={navigateBack} aria-label="Close" />
      </div>

      <div className="dset-form-page__body">
        <div className="dset-form-page__body-inner">
          <div className="dset-form-page__header">
            <Typography Component="h2" fontSize="fs20" boldness="semibold">
              Knowledge base
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
              A knowledge base is a collection of documents within a dataset. Documents in this collection are
              used to provide accurate, grounded answers and support.
            </Typography>
          </div>

          <Card className="dset-form-page__form-card">
            <CardContent>
              <Form form={form}>
                <CardBlock type="description" hasSeparator>
                  <KBDetailsSection
                    form={form}
                    isEdit={isEdit}
                    labelItems={labelItems}
                    onAddLabel={handleAddLabel}
                    nameValidatorSync={nameValidatorSync}
                    nameValidatorAsync={nameValidatorAsync}
                  />
                </CardBlock>

                <CardBlock type="description" hasSeparator>
                  <KBDatasetConfigSection form={form} isEdit={isEdit} initialData={initialData} />
                </CardBlock>

                <CardBlock type="description">
                  <KBSyncSettingsSection form={form} />
                </CardBlock>

                <CardBlock type="description" hasSeparator>
                  <KBDataChangeThresholdSection form={form} />
                </CardBlock>

                <CardBlock type="description" hasSeparator>
                  <KBEmbeddingChunkingSection form={form} />
                </CardBlock>

                <CardBlock type="description" hasSeparator>
                  <KBIndexingConfigSection form={form} />
                </CardBlock>

                {SHOW_KB_ESTIMATE_SUMMARY_PLACEHOLDER && (
                  <CardBlock type="description">
                    <KBEstimateSummarySection />
                  </CardBlock>
                )}
              </Form>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="dset-form-page__footer">
        <Button
          type="button"
          variant="solid"
          label={submitLabel}
          loading={isSubmitting}
          onClick={async () => {
            await runFormHandleSubmit(form);
          }}
        />
        <Button type="button" variant="outline" label="Cancel" onClick={navigateBack} isDisabled={isSubmitting} />
      </div>

      <ConfirmDialog
        open={isBlocked}
        title="Discard changes?"
        description="You have unsaved changes. Are you sure you want to leave?"
        confirmLabel="Discard"
        cancelLabel="Stay"
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </div>
  );
}

export { KBForm };
export type { KBFormProps };
