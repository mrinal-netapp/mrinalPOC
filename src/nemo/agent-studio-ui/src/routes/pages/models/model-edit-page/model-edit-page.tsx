import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router";
import { IconChevronDown, IconX } from "@tabler/icons-react";

import {
  useGetModelForEditQuery,
  useGetModelPricingDefaultsQuery,
  useUpdateModelMutation,
} from "@/routes/pages/models/models.api";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { Button } from "@/ui-lib/base-components/button/button";
import { Input } from "@/ui-lib/base-components/input/input";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ROUTES } from "@/routes/routes.consts";
import "./model-edit-page.scss";

type EditModelFormState = {
  name: string;
  throttlingTier: "default" | "custom";
  maxRequestsPerMinute: string;
  maxTokensPerMinute: string;
  customPricingOpen: boolean;
  inputCostPer1M: string;
  outputCostPer1M: string;
  pricingUnit: "per-1m" | "per-1k";
  spendingLimitOpen: boolean;
  spendingLimit: string;
  spendingLimitPeriod: "day" | "week" | "month";
};

function parseNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

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

function ModelEditPage(): ReactElement {
  const navigate = useNavigate();
  const { modelId } = useParams<{ modelId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useGetModelForEditQuery(
    { projectId, modelId: modelId ?? "" },
    { skip: !projectId || !modelId },
  );
  const [updateModel, { isLoading: isSaving }] = useUpdateModelMutation();
  // Catalog list price for this (provider, model), shown as a hint in the
  // Custom pricing section with a "Use these" shortcut. Skipped until the model
  // (and thus its provider + provider model id) has loaded.
  const { data: catalogPricing } = useGetModelPricingDefaultsQuery(
    {
      projectId: projectId ?? "",
      provider: data?.provider ?? "",
      model: data?.providerModelId ?? "",
    },
    {
      skip: !projectId || !data?.provider || !data?.providerModelId,
      refetchOnMountOrArgChange: true,
    },
  );
  const [form, setForm] = useState<EditModelFormState>({
    name: "",
    throttlingTier: "default",
    maxRequestsPerMinute: "",
    maxTokensPerMinute: "",
    customPricingOpen: false,
    inputCostPer1M: "",
    outputCostPer1M: "",
    pricingUnit: "per-1m",
    spendingLimitOpen: false,
    spendingLimit: "",
    spendingLimitPeriod: "month",
  });

  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable form state from fetched model payload.
    setForm((prev) => ({
      ...prev,
      name: data.name ?? "",
      throttlingTier: data.rpm != null || data.tpm != null ? "custom" : "default",
      maxRequestsPerMinute: data.rpm != null ? String(data.rpm) : "",
      maxTokensPerMinute: data.tpm != null ? String(data.tpm) : "",
      customPricingOpen: data.inputCostPer1M != null || data.outputCostPer1M != null,
      inputCostPer1M: data.inputCostPer1M != null ? String(data.inputCostPer1M) : "",
      outputCostPer1M: data.outputCostPer1M != null ? String(data.outputCostPer1M) : "",
      spendingLimitOpen: data.spendingLimit != null,
      spendingLimit: data.spendingLimit != null ? String(data.spendingLimit) : "",
      spendingLimitPeriod: data.spendingLimitPeriod ?? "month",
    }));
  }, [data]);

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
      { key: "day", value: "day", label: "Per day" },
      { key: "week", value: "week", label: "Per week" },
      { key: "month", value: "month", label: "Per month" },
    ],
    [],
  );

  const hasCatalogPricing =
    catalogPricing != null &&
    (catalogPricing.inputCostPer1M != null || catalogPricing.outputCostPer1M != null);

  function applyCatalogPricing(): void {
    if (!hasCatalogPricing || catalogPricing == null) return;
    const unit = form.pricingUnit;
    setForm((prev) => ({
      ...prev,
      inputCostPer1M:
        catalogPricing.inputCostPer1M != null
          ? per1MToUnit(catalogPricing.inputCostPer1M, unit)
          : prev.inputCostPer1M,
      outputCostPer1M:
        catalogPricing.outputCostPer1M != null
          ? per1MToUnit(catalogPricing.outputCostPer1M, unit)
          : prev.outputCostPer1M,
    }));
  }

  function handleCancel(): void {
    navigate(`/${ROUTES.MODELS}/${modelId}`);
  }

  function handleSave(): void {
    if (!projectId || !modelId) return;
    const name = form.name.trim();
    if (!name) {
      toast.error("Model name is required.");
      return;
    }
    void updateModel({
      projectId,
      modelId,
      body: {
        name,
        rpm: form.throttlingTier === "custom" ? parseNumberOrNull(form.maxRequestsPerMinute) : null,
        tpm: form.throttlingTier === "custom" ? parseNumberOrNull(form.maxTokensPerMinute) : null,
        inputCostPer1M: parseNumberOrNull(form.inputCostPer1M),
        outputCostPer1M: parseNumberOrNull(form.outputCostPer1M),
        spendingLimit: parseNumberOrNull(form.spendingLimit),
        spendingLimitPeriod: form.spendingLimit.trim() ? form.spendingLimitPeriod : null,
      },
    })
      .unwrap()
      .then(() => {
        toast.success("Model updated.");
        navigate(`/${ROUTES.MODELS}/${modelId}`);
      })
      .catch(() => {
        toast.error("Couldn't update model. Please try again.");
      });
  }

  if (isLoading) {
    return (
      <div className="model-edit-page__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="model-edit-page__error">
        <Typography Component="h1" fontSize="fs20" boldness="semibold">
          Model not found.
        </Typography>
        <Button variant="flat" size="medium" label="Back to Models" onClick={() => navigate(`/${ROUTES.MODELS}`)} />
      </div>
    );
  }

  return (
    <div className="model-edit-page">
      <header className="model-edit-page__bar">
        <Typography Component="h1" fontSize="fs20">Edit model</Typography>
        <Button variant="icon" size="medium" icon={<IconX size={18} />} aria-label="Close edit model" onClick={handleCancel} />
      </header>

      <main className="model-edit-page__content">
        <section className="model-edit-page__intro">
          <Typography Component="h2" fontSize="fs20" boldness="semibold">Model</Typography>
          <Typography fontSize="fs16" color="var(--text-secondary)">
            Edit agent and knowledge base LLM and embedding models.
          </Typography>
        </section>

        <section className="model-edit-page__card">
          <div className="model-edit-page__column">
            <Typography Component="h3" fontSize="fs14" boldness="semibold">Model details</Typography>
            <Input
              label="Name"
              required
              value={form.name}
              isDisabled
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            />

            <SelectDropdown
              label="Throttling tier"
              items={throttlingItems}
              value={form.throttlingTier}
              onValueChange={(value) => {
                if (value === "default" || value === "custom") {
                  setForm((prev) => ({ ...prev, throttlingTier: value }));
                }
              }}
            />

            {form.throttlingTier === "custom" && (
              <>
                <Input
                  type="number"
                  label="Maximum requests per minute"
                  placeholder="Enter requests per minute"
                  value={form.maxRequestsPerMinute}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, maxRequestsPerMinute: e.target.value }))
                  }
                />
                <Input
                  type="number"
                  label="Maximum tokens per minute"
                  placeholder="Enter tokens per minute"
                  value={form.maxTokensPerMinute}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, maxTokensPerMinute: e.target.value }))
                  }
                />
              </>
            )}

            <button type="button" className="model-edit-page__section-toggle" onClick={() => setForm((prev) => ({ ...prev, customPricingOpen: !prev.customPricingOpen }))}>
              <Typography Component="span" fontSize="fs14" boldness="semibold">Custom pricing</Typography>
              <IconChevronDown size={16} className={form.customPricingOpen ? "model-edit-page__chevron-open" : ""} />
            </button>

            {form.customPricingOpen && (
              <div className="model-edit-page__stack">
                {hasCatalogPricing && (
                  <div className="model-edit-page__catalog-price" role="note">
                    <div className="model-edit-page__catalog-price-text">
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
                )}
                <div className="model-edit-page__split-row">
                  <Input type="number" label="Input cost, USD" placeholder="Enter input cost" value={form.inputCostPer1M} onChange={(e) => setForm((prev) => ({ ...prev, inputCostPer1M: e.target.value }))} />
                  <SelectDropdown label="Unit" items={pricingUnitItems} value={form.pricingUnit} onValueChange={(value) => {
                    if (value === "per-1m" || value === "per-1k") setForm((prev) => ({ ...prev, pricingUnit: value }));
                  }} />
                </div>

                <div className="model-edit-page__split-row">
                  <Input type="number" label="Output cost, USD" placeholder="Enter output cost" value={form.outputCostPer1M} onChange={(e) => setForm((prev) => ({ ...prev, outputCostPer1M: e.target.value }))} />
                  <SelectDropdown label="Unit" items={pricingUnitItems} value={form.pricingUnit} onValueChange={(value) => {
                    if (value === "per-1m" || value === "per-1k") setForm((prev) => ({ ...prev, pricingUnit: value }));
                  }} />
                </div>

              </div>
            )}

            <button type="button" className="model-edit-page__section-toggle" onClick={() => setForm((prev) => ({ ...prev, spendingLimitOpen: !prev.spendingLimitOpen }))}>
              <Typography Component="span" fontSize="fs14" boldness="semibold">Spending limit</Typography>
              <IconChevronDown size={16} className={form.spendingLimitOpen ? "model-edit-page__chevron-open" : ""} />
            </button>

            {form.spendingLimitOpen && (
              <div className="model-edit-page__split-row">
                <Input type="number" label="Spending limit, USD" placeholder="Enter spending limit" value={form.spendingLimit} onChange={(e) => setForm((prev) => ({ ...prev, spendingLimit: e.target.value }))} />
                <SelectDropdown label="Period" items={spendingPeriodItems} value={form.spendingLimitPeriod} onValueChange={(value) => {
                  if (value === "day" || value === "week" || value === "month") setForm((prev) => ({ ...prev, spendingLimitPeriod: value }));
                }} />
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="model-edit-page__footer">
        <Button variant="solid" size="medium" label={isSaving ? "Saving..." : "Save"} onClick={handleSave} isDisabled={isSaving} />
        <Button variant="outline" size="medium" label="Cancel" onClick={handleCancel} />
      </footer>
    </div>
  );
}

export { ModelEditPage };
