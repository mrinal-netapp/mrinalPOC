package services

import "time"

// mergeProgressState applies a progress patch to an existing entry (nil = first write).
// Returned value is safe to store; request-only unit fields on the patch are not persisted on the root payload.
func mergeProgressState(existing *ProgressPayload, patch ProgressPayload, now time.Time) *ProgressPayload {
	patch.LastUpdated = now

	if patch.UnitID != "" {
		entry := cloneProgressPayload(existing)
		if entry == nil {
			entry = &ProgressPayload{LastUpdated: now}
		}
		unitStatus := patch.UnitStatus
		if unitStatus == "" {
			unitStatus = "running"
		}
		metrics := patch.UnitMetrics
		if metrics == nil {
			metrics = patch.Extra
		}
		if metrics == nil {
			metrics = make(map[string]interface{})
		}
		unit := UnitProgress{
			UnitID:      patch.UnitID,
			Status:      unitStatus,
			Metrics:     metrics,
			LastUpdated: now,
		}
		entry.Units = upsertUnit(entry.Units, unit)
		entry.Units = capUnits(entry.Units, MaxUnitsCap)
		if patch.TotalUnits > 0 {
			entry.TotalUnits = patch.TotalUnits
		}
		recomputed := recomputeJobLevelFromUnits(entry.Units)
		if recomputed != nil {
			// Preserve job-level keys (e.g. discovery counts) while overlaying rolled-up unit counters.
			entry.Extra = mergeRollupIntoJobExtra(entry.Extra, recomputed.Extra)
			if recomputed.Phase != "" {
				entry.Phase = recomputed.Phase
			}
			if recomputed.Percentage >= 0 {
				entry.Percentage = recomputed.Percentage
			}
		}
		entry.LastUpdated = now
		entry.UnitID = ""
		entry.UnitStatus = ""
		entry.UnitMetrics = nil
		entry.Replace = false
		return entry
	}

	// Job-level update
	if patch.Replace {
		stored := patch
		if existing != nil {
			if patch.TotalUnits == 0 {
				stored.TotalUnits = existing.TotalUnits
			}
			if len(patch.Units) == 0 {
				stored.Units = copyUnits(existing.Units)
			} else {
				stored.Units = capUnits(copyUnits(patch.Units), MaxUnitsCap)
			}
		} else if len(patch.Units) > 0 {
			stored.Units = capUnits(copyUnits(patch.Units), MaxUnitsCap)
		}
		stored.UnitID = ""
		stored.UnitStatus = ""
		stored.UnitMetrics = nil
		stored.LastUpdated = now
		return &stored
	}

	stored := patch
	if existing != nil {
		if patch.Extra == nil && existing.Extra != nil {
			stored.Extra = copyExtra(existing.Extra)
		} else if existing.Extra != nil && patch.Extra != nil {
			stored.Extra = mergeProgressExtra(copyExtra(existing.Extra), patch.Extra)
		}
	}
	if existing != nil && patch.TotalUnits == 0 {
		stored.TotalUnits = existing.TotalUnits
		stored.Units = copyUnits(existing.Units)
	} else if len(patch.Units) > 0 {
		stored.Units = capUnits(copyUnits(patch.Units), MaxUnitsCap)
	}
	stored.UnitID = ""
	stored.UnitStatus = ""
	stored.UnitMetrics = nil
	stored.LastUpdated = now
	return &stored
}

func cloneProgressPayload(p *ProgressPayload) *ProgressPayload {
	if p == nil {
		return nil
	}
	out := *p
	out.Extra = copyExtra(p.Extra)
	out.Units = copyUnits(p.Units)
	return &out
}

func mergeRollupIntoJobExtra(prev, rollup map[string]interface{}) map[string]interface{} {
	out := copyExtra(prev)
	if out == nil {
		out = make(map[string]interface{})
	}
	if rollup == nil {
		return out
	}
	for k, v := range rollup {
		out[k] = v
	}
	return out
}
