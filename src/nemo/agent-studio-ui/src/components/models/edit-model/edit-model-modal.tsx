import { IconChevronDown, IconX } from "@tabler/icons-react";
import { useId, useMemo, useReducer, type ReactElement } from "react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useGetModelPricingDefaultsQuery } from "@/routes/pages/models/models.api";
import { Button } from "@/ui-lib/base-components/button/button";
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog";
import { Input } from "@/ui-lib/base-components/input/input";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import type {
  CollapseTriggerProps,
  EditModelConfig,
  EditModelFormState,
  EditModelModalModel,
  EditModelModalProps,
} from "./edit-model-modal.types";

import "./edit-model-modal.scss";

const USD_PER_1M = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Format a per-1M USD figure for display, or a dash when unavailable. */
function formatUsdPer1M(value: number | null): string {
  return value == null ? "—" : `$${USD_PER_1M.format(value)}`;
}

/** Convert a per-1M-token USD price into the form's selected pricing unit. */
function per1MToUnit(per1M: number, unit: string): string {
  const value = unit === "per-1k" ? per1M / 1000 : per1M;
  return String(Number(value.toFixed(6)));
}

function parseUsdAmount(raw: string): number {
  const n = Number.parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/*
 * Partial-update reducer: every field change is one `dispatch({ field: value })`
 * call. Cheaper than maintaining a `useState` pair per field and keeps the
 * whole form as a single snapshot we can reset / discard in one shot later.
 */
function editModelFormReducer(
  state: EditModelFormState,
  patch: Partial<EditModelFormState>,
): EditModelFormState {
  return { ...state, ...patch };
}

/*
 * Seed the form from a previously-saved config when one exists (so reopening
 * Modify shows the last edit), otherwise fall back to defaults keyed off the
 * model label. `customPricingEnabled` / `spendingLimitEnabled` map onto the
 * form's section-open flags so the collapsible panels reopen with their values.
 */
function buildInitialFormState(
  model: EditModelModalModel,
  initialConfig?: EditModelConfig | null,
): EditModelFormState {
  return {
    name: initialConfig?.name?.trim() ? initialConfig.name : model.label,
    throttlingTier: initialConfig?.throttlingTier || "default",
    maxRequestsPerMinute: initialConfig?.maxRequestsPerMinute ?? "",
    maxTokensPerMinute: initialConfig?.maxTokensPerMinute ?? "",
    customPricingOpen: initialConfig?.customPricingEnabled ?? false,
    inputCostUsd: initialConfig?.inputCostUsd ?? "",
    outputCostUsd: initialConfig?.outputCostUsd ?? "",
    pricingUnit: initialConfig?.pricingUnit || "per-1m",
    spendingLimitOpen: initialConfig?.spendingLimitEnabled ?? false,
    spendingLimitUsd: initialConfig?.spendingLimitUsd ?? "",
    spendingPeriod: initialConfig?.spendingPeriod || "per-month",
  };
}

function CollapseTrigger({ sectionId, expanded, title, onToggle }: CollapseTriggerProps): ReactElement {
  return (
    <button
      type="button"
      className="edit-model-modal__collapse-trigger"
      aria-expanded={expanded}
      aria-controls={sectionId}
      onClick={onToggle}
    >
      <Typography Component="span" fontSize="fs14" boldness="semibold" className="edit-model-modal__collapse-title">
        {title}
      </Typography>
      <IconChevronDown
        size={16}
        stroke={1.5}
        className={`edit-model-modal__toggle-chevron${expanded ? " edit-model-modal__toggle-chevron--open" : ""}`}
        aria-hidden
      />
    </button>
  );
}

function EditModelModalBody({
  model,
  provider,
  initialConfig,
  onClose,
  onSave,
}: {
  model: EditModelModalModel;
  provider?: string | null;
  initialConfig?: EditModelConfig | null;
  onClose: () => void;
  onSave?: (modelKey: string, config: EditModelConfig) => void;
}): ReactElement {
  const modelDetailsHeadingId = useId();
  const nameFieldId = useId();
  const throttlingTierId = useId();
  const maxRpmId = useId();
  const maxTpmId = useId();
  const inputCostId = useId();
  const inputUnitId = useId();
  const outputCostId = useId();
  const outputUnitId = useId();
  const spendingLimitId = useId();
  const spendingPeriodId = useId();
  const customPricingSectionId = useId();
  const spendingLimitSectionId = useId();

  const [form, updateForm] = useReducer(
    editModelFormReducer,
    null,
    () => buildInitialFormState(model, initialConfig),
  );

  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  // Catalog list price for this (provider, model), shown as a hint in the
  // Custom pricing section. Skipped until we have a project + provider + model.
  const { data: catalogPricing } = useGetModelPricingDefaultsQuery(
    { projectId: projectId ?? "", provider: provider ?? "", model: model.value },
    {
      skip: !projectId || !provider || !model.value,
      // Revalidate every time the modal (re)opens. The catalog price can change
      // as the live datasheet refreshes, and — more importantly — this evicts any
      // stale `null` cached from before the datasheet had loaded, so reopening
      // the modal always reflects the current catalog instead of a cached miss.
      refetchOnMountOrArgChange: true,
    },
  );
  const hasCatalogPricing =
    catalogPricing != null &&
    (catalogPricing.inputCostPer1M != null || catalogPricing.outputCostPer1M != null);

  function applyCatalogPricing(): void {
    if (!hasCatalogPricing || catalogPricing == null) return;
    const unit =
      typeof form.pricingUnit === "string" ? form.pricingUnit : "per-1m";
    updateForm({
      inputCostUsd:
        catalogPricing.inputCostPer1M != null
          ? per1MToUnit(catalogPricing.inputCostPer1M, unit)
          : form.inputCostUsd,
      outputCostUsd:
        catalogPricing.outputCostPer1M != null
          ? per1MToUnit(catalogPricing.outputCostPer1M, unit)
          : form.outputCostUsd,
    });
  }

  const throttlingItems = useMemo(
    () => [
      { key: "default", value: "default", label: "Default" },
      { key: "custom", value: "custom", label: "Custom" },
    ],
    [],
  );

  const pricingUnitItems = useMemo(
    () => [
      { key: "per-1m", value: "per-1m", label: "per 1M tokens" },
      { key: "per-1k", value: "per-1k", label: "per 1K tokens" },
    ],
    [],
  );

  const spendingPeriodItems = useMemo(
    () => [
      { key: "per-day", value: "per-day", label: "per day" },
      { key: "per-week", value: "per-week", label: "per week" },
      { key: "per-month", value: "per-month", label: "per month" },
    ],
    [],
  );

  const pricingUnitLabel = useMemo(() => {
    const v = pricingUnitItems.find((i) => i.value === form.pricingUnit);
    return v?.label ?? "per 1M tokens";
  }, [form.pricingUnit, pricingUnitItems]);

  const decimalUsd = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
      }),
    [],
  );

  const baseInputCost = parseUsdAmount(form.inputCostUsd);
  const baseOutputCost = parseUsdAmount(form.outputCostUsd);

  // Per-minute rate limits are only meaningful on the custom tier; the default
  // tier uses gateway defaults, so hide the inputs unless "Custom" is picked.
  const isCustomThrottling =
    (typeof form.throttlingTier === "string" ? form.throttlingTier : "") === "custom";

  function handleSave(): void {
    const asString = (v: typeof form.spendingPeriod): string =>
      typeof v === "string" ? v : "";
    onSave?.(model.key, {
      name: form.name.trim(),
      throttlingTier: asString(form.throttlingTier),
      maxRequestsPerMinute: form.maxRequestsPerMinute,
      maxTokensPerMinute: form.maxTokensPerMinute,
      customPricingEnabled: form.customPricingOpen,
      inputCostUsd: form.inputCostUsd,
      outputCostUsd: form.outputCostUsd,
      pricingUnit: asString(form.pricingUnit),
      spendingLimitEnabled: form.spendingLimitOpen,
      spendingLimitUsd: form.spendingLimitUsd,
      spendingPeriod: asString(form.spendingPeriod),
    });
    onClose();
  }

  return (
    <div className="edit-model-modal__shell">
      <header className="edit-model-modal__bar">
        <div className="edit-model-modal__bar-leader" aria-hidden />
        <Typography Component="h2" fontSize="fs20" boldness="regular" className="edit-model-modal__bar-title">
          Model
        </Typography>
        <div className="edit-model-modal__bar-actions">
          <Button
            variant="icon"
            size="medium"
            icon={<IconX size={20} stroke={1.5} />}
            onClick={onClose}
            aria-label="Close"
          />
        </div>
      </header>

      <div className="edit-model-modal__scroll">
        <div className="edit-model-modal__panel">
          <div className="edit-model-modal__stack">
            <section className="edit-model-modal__block" aria-labelledby={modelDetailsHeadingId}>
              <div className="edit-model-modal__block-title-row">
                <Typography
                  Component="h4"
                  fontSize="fs14"
                  boldness="semibold"
                  className="edit-model-modal__block-heading"
                  id={modelDetailsHeadingId}
                >
                  Model details
                </Typography>
              </div>
              <div className="edit-model-modal__fields">
                <div className="edit-model-modal__field">
                  <Input
                    id={nameFieldId}
                    label="Name"
                    required
                    value={form.name}
                    onChange={(e) => {
                      updateForm({ name: e.target.value });
                    }}
                  />
                </div>
                <div className="edit-model-modal__field">
                  <SelectDropdown
                    id={throttlingTierId}
                    label="Throttling tier"
                    placeholder="Select tier"
                    items={throttlingItems}
                    value={form.throttlingTier}
                    onValueChange={(v) => {
                      updateForm({ throttlingTier: v });
                    }}
                  />
                </div>
                {isCustomThrottling ? (
                  <>
                    <div className="edit-model-modal__field">
                      <Input
                        id={maxRpmId}
                        type="number"
                        label="Maximum requests per minute"
                        placeholder="Enter requests per minute"
                        value={form.maxRequestsPerMinute}
                        onChange={(e) => {
                          updateForm({ maxRequestsPerMinute: e.target.value });
                        }}
                      />
                    </div>
                    <div className="edit-model-modal__field">
                      <Input
                        id={maxTpmId}
                        type="number"
                        label="Maximum tokens per minute"
                        placeholder="Enter tokens per minute"
                        value={form.maxTokensPerMinute}
                        onChange={(e) => {
                          updateForm({ maxTokensPerMinute: e.target.value });
                        }}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </section>

            <section className="edit-model-modal__block edit-model-modal__block--collapse">
              <CollapseTrigger
                sectionId={customPricingSectionId}
                expanded={form.customPricingOpen}
                title="Custom pricing"
                onToggle={() => {
                  updateForm({ customPricingOpen: !form.customPricingOpen });
                }}
              />
              {form.customPricingOpen ? (
                <div className="edit-model-modal__collapse-panel" id={customPricingSectionId} role="region">
                  <div className="edit-model-modal__fields">
                    {hasCatalogPricing ? (
                      <div className="edit-model-modal__catalog-price" role="note">
                        <div className="edit-model-modal__catalog-price-text">
                          <Typography Component="span" fontSize="fs12" color="var(--text-secondary)">
                            Catalog list price (per 1M tokens): input{" "}
                            {formatUsdPer1M(catalogPricing?.inputCostPer1M ?? null)} · output{" "}
                            {formatUsdPer1M(catalogPricing?.outputCostPer1M ?? null)}
                          </Typography>
                          {catalogPricing?.approximate && catalogPricing.matchedModel ? (
                            <Typography Component="span" fontSize="fs12" color="var(--text-secondary)">
                              Approx. — closest catalog match: {catalogPricing.matchedModel}
                            </Typography>
                          ) : null}
                        </div>
                        <Button
                          type="button"
                          variant="flat"
                          size="small"
                          label="Use these"
                          onClick={applyCatalogPricing}
                        />
                      </div>
                    ) : null}
                    <div className="edit-model-modal__split-row">
                      <div className="edit-model-modal__split-row-input">
                        <Input
                          id={inputCostId}
                          type="number"
                          label="Input cost, USD"
                          placeholder="Enter input cost"
                          value={form.inputCostUsd}
                          onChange={(e) => {
                            updateForm({ inputCostUsd: e.target.value });
                          }}
                        />
                      </div>
                      <div className="edit-model-modal__split-row-dropdown">
                        <SelectDropdown
                          id={inputUnitId}
                          label="Unit"
                          placeholder="Unit"
                          items={pricingUnitItems}
                          value={form.pricingUnit}
                          onValueChange={(v) => {
                            updateForm({ pricingUnit: v });
                          }}
                        />
                      </div>
                    </div>
                    <div className="edit-model-modal__split-row">
                      <div className="edit-model-modal__split-row-input">
                        <Input
                          id={outputCostId}
                          type="number"
                          label="Output cost, USD"
                          placeholder="Enter output cost"
                          value={form.outputCostUsd}
                          onChange={(e) => {
                            updateForm({ outputCostUsd: e.target.value });
                          }}
                        />
                      </div>
                      <div className="edit-model-modal__split-row-dropdown">
                        <SelectDropdown
                          id={outputUnitId}
                          label="Unit"
                          placeholder="Unit"
                          items={pricingUnitItems}
                          value={form.pricingUnit}
                          onValueChange={(v) => {
                            updateForm({ pricingUnit: v });
                          }}
                        />
                      </div>
                    </div>
                    <div className="edit-model-modal__result-lines">
                      <Typography Component="p" fontSize="fs14" className="edit-model-modal__result-line">
                        Resulting input cost: {decimalUsd.format(baseInputCost)} USD/{pricingUnitLabel}
                      </Typography>
                      <Typography Component="p" fontSize="fs14" className="edit-model-modal__result-line">
                        Resulting output cost: {decimalUsd.format(baseOutputCost)} USD/{pricingUnitLabel}
                      </Typography>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="edit-model-modal__block edit-model-modal__block--collapse">
              <CollapseTrigger
                sectionId={spendingLimitSectionId}
                expanded={form.spendingLimitOpen}
                title="Spending limit"
                onToggle={() => {
                  updateForm({ spendingLimitOpen: !form.spendingLimitOpen });
                }}
              />
              {form.spendingLimitOpen ? (
                <div className="edit-model-modal__collapse-panel" id={spendingLimitSectionId} role="region">
                  <div className="edit-model-modal__split-row">
                    <div className="edit-model-modal__split-row-input">
                      <Input
                        id={spendingLimitId}
                        type="number"
                        label="Spending limit, USD"
                        placeholder="Enter spending limit"
                        value={form.spendingLimitUsd}
                        onChange={(e) => {
                          updateForm({ spendingLimitUsd: e.target.value });
                        }}
                      />
                    </div>
                    <div className="edit-model-modal__split-row-dropdown">
                      <SelectDropdown
                        id={spendingPeriodId}
                        label="Period"
                        placeholder="Period"
                        items={spendingPeriodItems}
                        value={form.spendingPeriod}
                        onValueChange={(v) => {
                          updateForm({ spendingPeriod: v });
                        }}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

          </div>
        </div>
      </div>

      <footer className="edit-model-modal__footer">
        <Button variant="solid" size="medium" label="Save" onClick={handleSave} />
        <Button variant="outline" size="medium" label="Cancel" onClick={onClose} />
      </footer>
    </div>
  );
}

function EditModelModal({ open, onOpenChange, model, provider, initialConfig, onSave }: EditModelModalProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogPopup showCloseButton={false} className="edit-model-modal__popup">
        {open && model != null ? (
          <EditModelModalBody
            key={model.key}
            model={model}
            provider={provider}
            initialConfig={initialConfig}
            onClose={() => onOpenChange(false)}
            onSave={onSave}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

export { EditModelModal };
