import { useCallback } from "react";

import { useRefreshProvidersMutation } from "@/routes/pages/models/models.api";
import { toast } from "@/ui-lib/base-components/toast/toast";

/**
 * Shared "Refresh connection health" action for the Providers + Models tabs.
 * Pulls live provider health from Bifrost and always surfaces the outcome via a
 * success/error toast so a click never feels like a no-op. Returns the trigger
 * plus its in-flight flag; callers add their own list-refetch guard.
 */
function useRefreshProviderHealth(): {
  refresh: (projectId: string) => void;
  isRefreshing: boolean;
} {
  const [refreshProviders, { isLoading: isRefreshing }] = useRefreshProvidersMutation();

  const refresh = useCallback(
    (projectId: string): void => {
      void refreshProviders({ projectId })
        .unwrap()
        .then((res) => {
          const count = res.data?.length ?? 0;
          toast.success(
            count > 0
              ? `Connection health refreshed for ${count} provider${count === 1 ? "" : "s"}.`
              : "Connection health refreshed.",
          );
        })
        .catch(() => {
          toast.error("Couldn't refresh connection health. Please try again.");
        });
    },
    [refreshProviders],
  );

  return { refresh, isRefreshing };
}

export { useRefreshProviderHealth };
