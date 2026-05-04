import type { V05CheckReport as CheckReport } from "../commands/check.js";
import type { ListReport } from "../commands/list.js";
import type { RefreshReport } from "../commands/refresh.js";
import type { ScanReport } from "../types.js";

export type RenderJsonOpts = {
  pretty: boolean;
};

export function renderJson(report: ScanReport, opts: RenderJsonOpts): string {
  const json = opts.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
  return `${json}\n`;
}

export function renderJsonCheck(report: CheckReport, opts: RenderJsonOpts): string {
  const json = opts.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
  return `${json}\n`;
}

export function renderJsonRefresh(report: RefreshReport, opts: RenderJsonOpts): string {
  const json = opts.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
  return `${json}\n`;
}

export function renderJsonList(report: ListReport, opts: RenderJsonOpts): string {
  const json = opts.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
  return `${json}\n`;
}
