import type { Plan } from '@prisma/client';
import { INVESTIGATIONS, type InvestigationType } from '@inqurix/core';

export interface PlanDef {
  name: string;
  priceUsdMonthly: number;
  maxSeats: number;
  /** Credits added per billing period. Local search and preview never use credits. */
  monthlyCredits: number;
  features: {
    localSearch: true;
    semanticSearch: boolean;
    investigations: boolean;
    companyWorkspace: boolean;
    sharedSources: number;
    exportReports: boolean;
    auditLog: boolean;
  };
}

/** Commercial configuration. Prices are shown in the UI; the charge itself is set in Paddle. */
export const PLANS: Record<Plan, PlanDef> = {
  free: { name: 'Free', priceUsdMonthly: 0, maxSeats: 1, monthlyCredits: 25, features: { localSearch: true, semanticSearch: true, investigations: true, companyWorkspace: false, sharedSources: 0, exportReports: true, auditLog: false } },
  pro: { name: 'Pro', priceUsdMonthly: 12, maxSeats: 1, monthlyCredits: 500, features: { localSearch: true, semanticSearch: true, investigations: true, companyWorkspace: false, sharedSources: 0, exportReports: true, auditLog: false } },
  business: { name: 'Business', priceUsdMonthly: 29, maxSeats: 250, monthlyCredits: 2000, features: { localSearch: true, semanticSearch: true, investigations: true, companyWorkspace: true, sharedSources: 100, exportReports: true, auditLog: true } },
};

/** Only resource-intensive operations cost credits. */
export const OPERATION_COSTS: Record<string, number> = {
  ...Object.fromEntries(Object.entries(INVESTIGATIONS).map(([k, v]) => [`investigation:${k as InvestigationType}`, v.credits])),
  'ocr:page': 1,
  'company:index_document': 1,
};
