import { formatBytes } from "@/components/data-source/utils/data-source.utils";

function formatIndexSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  return formatBytes(bytes);
}

function formatNumber(val: number | null | undefined): string {
  if (val == null) return "—";
  return val.toLocaleString("en-US");
}

export { formatIndexSize, formatNumber };
