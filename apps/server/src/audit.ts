import type { Prisma } from '@prisma/client';
import { prisma } from './db.js';

export function audit(action: string, e: { orgId?: string; userId?: string; target?: string; meta?: Prisma.InputJsonValue; ip?: string }) {
  return prisma.auditLog.create({ data: { action, ...e } });
}
